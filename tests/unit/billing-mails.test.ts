// Billing mail: who hears what, from which address, and why a mail can never
// fail a webhook. Pinned offline, the way the sibling apps pin theirs.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const at = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

const source = (text: string) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^[\t ]*\/\/.*$/gm, " ");

/** The body of one function in this file, comments already stripped. */
function body(text: string, name: string): string {
  const found = new RegExp(`function ${name}\\([^)]*\\) \\{([\\s\\S]*?)\\n\\}`).exec(text);
  assert.ok(found, `${name} is defined`);
  return found[1];
}

const webhook = source(at("../../src/app/api/billing/webhook/route.ts"));
const mails = source(at("../../src/lib/billing-mails.ts"));
const auth = source(at("../../src/app/auth-actions.ts"));
const members = source(at("../../src/app/members/page.tsx"));

describe("the recipient is the workspace's own answer", () => {
  it("resolves the first owner from the local membership row", () => {
    assert.match(mails, /db\.membership\.findFirst\(\{/);
    assert.match(mails, /role: "OWNER"/);
    assert.match(mails, /orderBy: \{ createdAt: "asc" \}/);
    assert.match(mails, /select: \{ user: \{ select: \{ email: true, name: true \} \} \}/);
  });

  it("never asks Stripe for an address", () => {
    // ensureCustomer creates the customer with an empty email; checkout may
    // collect one, but nothing guarantees Stripe writes it back.
    assert.doesNotMatch(mails, /customers\.retrieve/);
  });

  it("says so when there is nobody to say it to", () => {
    for (const mail of ["sendDunning", "sendRecovered", "sendCancellation"]) {
      assert.match(body(mails, mail), /if \(!owner\) return;/);
    }
  });
});

describe("a committed sync may not be answered with a failure", () => {
  it("every sender swallows its own errors, loudly", () => {
    for (const mail of ["sendReceipt", "sendDunning", "sendRecovered", "sendCancellation"]) {
      const b = body(mails, mail);
      assert.match(b, /catch \(error\)/, `${mail} catches`);
      assert.match(b, /not sent:/, `${mail} logs the miss`);
    }
  });

  it("the webhook syncs before it announces", () => {
    const announce = body(webhook, "syncAndAnnounce");
    const syncAt = announce.indexOf("syncSubscriptionFromStripe");
    assert.ok(
      syncAt < announce.indexOf("sendTrialEnded") && syncAt < announce.indexOf("sendRecovered"),
      "each transition is announced once the row is already written",
    );
    assert.match(webhook, /if \(applied && workspaceId\) await sendCancellation\(workspaceId\);/);
  });

  it("the receipt follows the checkout sync, never replaces it", () => {
    const syncAt = webhook.indexOf("await syncSubscriptionFromStripe(sub);");
    const receiptAt = webhook.indexOf("await sendReceipt(session);");
    assert.ok(syncAt >= 0 && receiptAt > syncAt, "the receipt is best-effort, after the commit");
  });
});

describe("the transition decides the mail", () => {
  it("announces a converted trial and a recovered payment, on those transitions only", () => {
    assert.match(webhook, /if \(previous\.status === "trialing"\) \{/);
    assert.match(webhook, /await sendTrialEnded\(workspaceId/);
    assert.match(webhook, /else if \(previous\.status === "past_due"\) \{/);
    assert.match(webhook, /await sendRecovered\(workspaceId\)/);
  });

  it("Stripe's three-day warning is mailed, and only while the row still says trialing", () => {
    assert.match(webhook, /case "customer\.subscription\.trial_will_end"/);
    assert.match(webhook, /await sendTrialEnding\(workspaceId\)/);
    assert.match(mails, /subscription\.status !== "trialing"\) return/);
    assert.match(mails, /daysLeft > 3\) return/);
  });

  it("the receipt knows a trial from a payment", () => {
    assert.match(mails, /trialing = sub\.status === "trialing"/);
    assert.match(mails, /renderReceiptEmail\(\{[\s\S]*?trialing,/);
  });

  it("a trial checkout is not announced in the app as a payment", () => {
    assert.match(members, /trialing \? "Trial started — welcome aboard\. " : "Payment received — welcome aboard\. "/);
  });

  it("a stale snapshot announces nothing", () => {
    const announce = body(webhook, "syncAndAnnounce");
    assert.match(announce, /return false;/);
    assert.ok(
      announce.indexOf("return false") < announce.indexOf("sendRecovered"),
      "the refusal happens before anything could be announced",
    );
  });

  it("dunning fires only while money is still owed", () => {
    assert.match(mails, /export const DUNNING_STATUSES = \["past_due", "unpaid", "incomplete"\] as const;/);
    assert.match(webhook, /\(DUNNING_STATUSES as readonly string\[\]\)\.includes\(stripeSub\.status\)/);
    assert.match(webhook, /await sendDunning\(stripeSub\)/);
  });
});

describe("the verification gate follows the transport", () => {
  it("signup pre-verifies only when no provider is configured", () => {
    assert.match(auth, /emailVerified: !verificationEnforced\(\)/);
  });

  it("sign-in enforces the click only when a provider exists", () => {
    assert.match(auth, /if \(!user\.emailVerified && verificationEnforced\(\)\)/);
  });

  it("signup sends the first link while the token is the only way in", () => {
    assert.match(auth, /if \(verificationEnforced\(\)\) \{/);
    assert.match(auth, /createEmailVerificationToken\(created\.userId\)/);
    assert.match(auth, /getVerificationUrl\(appBaseUrl\(\), token\)/);
  });
});

describe("the plan has a home on /members", () => {
  it("reads the billing flag the buy button returns with", () => {
    assert.match(members, /searchParams: Promise<\{ billing\?: string \}>/);
    assert.match(members, /billing === "success" \|\| billing === "portal"/);
  });

  it("carries the same refusal set the checkout route enforces", () => {
    assert.match(members, /SUBSCRIPTION_STATUS_OPEN/);
  });

  it("dunning in the app points at the portal, the one place that fixes it", () => {
    assert.match(members, /Updating your card in the portal is the fix/);
    assert.match(members, /<ManageBillingButton label="Update card" \/>/);
  });

  it("a free workspace is offered the pricing page, not a dead button", () => {
    assert.match(members, /href="\/pricing"/);
  });
});
