// Unit tests for the outbound-webhook signatures: pure functions, no server,
// no network. Importing the module constructs a Postgres client (lazily —
// nothing here connects), so no database is needed either.
//
// The two known-answer vectors below are the whole contract: `signBody` signs
// the raw body with the endpoint's secret, `signPayload` signs
// `{timestamp}.{body}`. The digests were computed with an independent
// HMAC-SHA256 implementation and pinned here, so a change to either
// construction — an extra prefix, a different encoding — fails a test instead
// of silently invalidating every receiver that already verifies deliveries.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { signBody, signPayload, subscribes, WEBHOOK_EVENTS } from "../../src/lib/webhooks";

const SECRET = "whsec_test-key";
const BODY = '{"id":"evt_1","event":"reply.sent","timestamp":1700000000,"data":{}}';

describe("signBody", () => {
  it("is HMAC-SHA256 hex over the raw body alone — the nuCRM-compatible spelling", () => {
    assert.equal(
      signBody(SECRET, BODY),
      "22d3ef3e925f74063a5839eb5ab92911fef8fe76c8c111cc8eaf8bfa32c784e5",
    );
  });

  it("is not the Stripe-style digest, so a receiver cannot accept the wrong one by accident", () => {
    assert.notEqual(signBody(SECRET, BODY), signPayload(SECRET, BODY, 1700000000));
  });

  it("moves with both the secret and the body", () => {
    assert.notEqual(signBody(SECRET, BODY), signBody("whsec_other", BODY));
    assert.notEqual(signBody(SECRET, BODY), signBody(SECRET, `${BODY} `));
  });
});

describe("signPayload", () => {
  it("keeps the Stripe-style construction: the timestamp is inside the signed string", () => {
    assert.equal(
      signPayload(SECRET, BODY, 1700000000),
      "a4786f8dc57a8fc60284d8cf3cee397f471be3390246c7036189c965557aebce",
    );
    assert.notEqual(signPayload(SECRET, BODY, 1700000000), signPayload(SECRET, BODY, 1700000001));
  });
});

describe("WEBHOOK_EVENTS", () => {
  it("is the six-event menu the README and the openapi enum both read", () => {
    assert.deepEqual([...WEBHOOK_EVENTS], [
      "thread.created",
      "thread.scored",
      "thread.hot",
      "thread.at_risk",
      "draft.created",
      "reply.sent",
    ]);
  });
});

describe("subscribes", () => {
  it("an empty event list means everything, including events added later", () => {
    assert.equal(subscribes("", "reply.sent"), true);
  });

  it("matches a name in a comma list regardless of spacing", () => {
    assert.equal(subscribes("thread.created, reply.sent", "reply.sent"), true);
    assert.equal(subscribes("thread.created", "reply.sent"), false);
  });
});

// The egress contract is two-sided: `classifyTarget` refuses an internal
// destination when the subscription is written, `assertAllowedTarget`
// re-judges the address DNS answers with immediately above the delivery
// fetch. A source guard, not a runtime test — the failure mode is a removed
// line that still typechecks, and only the source says so.
describe("egress guards", () => {
  const at = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

  it("classifies the destination on both write paths", () => {
    const post = at("src/app/api/v1/webhooks/route.ts");
    const patch = at("src/app/api/v1/webhooks/[id]/route.ts");
    assert.match(post, /classifyTarget\(url, "url"\)/, "POST must classify the destination");
    assert.match(patch, /classifyTarget\(url, "url"\)/, "PATCH must classify a repointed destination");
  });

  it("asserts egress immediately above the delivery fetch", () => {
    const sender = at("src/lib/webhooks.ts");
    assert.match(
      sender,
      /await assertAllowedTarget\(endpoint\.url, "url"\);/,
      "delivery must re-judge the address DNS answers with now",
    );
  });
});

// The nuCRM-facing half of a delivery, pinned at the source: a receiver on
// `/api/tenant/plugins/webhook/{id}` verifies the body-only digest, then reads
// `x-webhook-timestamp` for freshness and `x-webhook-delivery` for dedupe. All
// three are separate header lines, so all three can be dropped by one edit that
// still typechecks and still passes every other test here. The values matter as
// much as their presence — a freshness header that disagrees with the payload's
// own `timestamp`, or a delivery id that is not the one inside the signed body,
// is a header a receiver trusts and a sender has to explain.
describe("the headers a nuCRM receiver reads", () => {
  const sender = readFileSync(join(process.cwd(), "src/lib/webhooks.ts"), "utf8");

  it("every delivery carries the generic digest, the freshness value and the delivery id", () => {
    assert.match(sender, /"x-webhook-signature": `sha256=\$\{signBody\(endpoint\.secret, body\)\}`/, "the body-only spelling");
    assert.match(sender, /"x-webhook-timestamp": String\(timestamp\)/, "the seconds value, same one the family pair signs");
    assert.match(sender, /"x-webhook-delivery": id/, "the payload id, inside the signed bytes");
  });

  it("one timestamp, one id, one stringify serve the body and the headers", () => {
    assert.match(sender, /const timestamp = Math\.floor\(Date\.now\(\) \/ 1000\);/);
    assert.equal(
      (sender.match(/Date\.now\(\)/g) ?? []).length,
      1,
      "a second Date.now() for a header would disagree with the timestamp inside the body",
    );
    assert.match(sender, /const body = JSON\.stringify\(\{ id, event, timestamp, data \}\);/);
    const bodyAt = sender.indexOf("const body = JSON.stringify(");
    const fetchAt = sender.indexOf("const res = await fetch(");
    assert.ok(bodyAt !== -1 && bodyAt < fetchAt, "stringify once, then send those exact bytes");
  });
});
