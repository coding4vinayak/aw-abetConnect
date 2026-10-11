// Unit tests for Stripe webhook verification: offline, no network, no DB.
// The signature check is the security boundary (anyone can POST to the
// endpoint), so it gets its own tests. Run: npm run test:unit
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import Stripe from "stripe";
import { verifyWebhook } from "../../src/lib/stripe";

const SECRET = "whsec_test_secret_for_unit_tests_only";

before(() => {
  process.env.STRIPE_WEBHOOK_SECRET = SECRET;
});

after(() => {
  delete process.env.STRIPE_WEBHOOK_SECRET;
});

function signedHeader(payload: string, secret: string = SECRET): string {
  return Stripe.webhooks.generateTestHeaderString({ payload, secret });
}

describe("verifyWebhook", () => {
  it("accepts a properly signed payload", () => {
    const payload = JSON.stringify({ id: "evt_test", object: "event" });
    const event = verifyWebhook(payload, signedHeader(payload));
    assert.equal(event.id, "evt_test");
  });

  it("rejects a tampered payload", () => {
    const payload = JSON.stringify({ id: "evt_test", object: "event" });
    const header = signedHeader(payload);
    assert.throws(() => verifyWebhook(payload + " ", header), /signature/i);
  });

  it("rejects a foreign secret", () => {
    const payload = JSON.stringify({ id: "evt_test", object: "event" });
    const header = signedHeader(payload, "whsec_attacker_secret");
    assert.throws(() => verifyWebhook(payload, header), /signature/i);
  });

  it("rejects a missing signature", () => {
    assert.throws(() => verifyWebhook("{}", null), /signature/i);
  });
});
