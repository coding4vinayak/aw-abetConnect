// The checkout route's refusals, pinned offline — the same rules the rest of
// the suite's billing routes follow, adopted here after the review found this
// route had drifted: an anonymous fetch was answered with an HTML redirect, a
// typo in `priceId` reached Stripe, an attacker-chosen `returnUrl` was honored
// after payment, and a paying workspace could buy a second subscription.
//
// This route makes a Stripe subscription, so it is the one place in the billing
// path where a missing check costs money *and* goodwill. What it can be tested
// for without a Stripe account is the ordering: every reason not to proceed has
// to be decided before the session exists, because afterwards there is a real
// subscription on a real customer and nothing here can undo it.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^[\t ]*\/\/.*$/gm, " ");

const checkout = source("../../src/app/api/billing/checkout/route.ts");
const portal = source("../../src/app/api/billing/portal/route.ts");
const stripeModule = source("../../src/lib/stripe.ts");
const pricingPage = source("../../src/app/pricing/page.tsx");

const NO_PLAN = "{ status: 409 }";
const BUY = "await createCheckoutSession(";

describe("the refusals are decided before the money", () => {
  it("happen in the order the buyer needs them", () => {
    const steps = [
      ['return NextResponse.json({ error: "Sign in required." }, { status: 401 })'],
      ["priceId must be one of"],
      ["returnUrl must be a page on this site"],
      [NO_PLAN],
      [BUY],
    ];
    let at = -1;
    for (const [needle] of steps) {
      const found = checkout.indexOf(needle);
      assert.ok(found > at, `nothing after this may be decided first: ${needle}`);
      at = found;
    }
  });

  it("answers the workspace from its own session, never from the request", () => {
    assert.match(checkout, /const session = await getSession\(\);/);
    assert.doesNotMatch(checkout, /body as \{[^}]*workspaceId/, "a workspaceId in the body is somebody else's tenant");
  });

  it("answers an anonymous API call in the API's language", () => {
    // Not `requireSession`, which redirects a fetch to the HTML login page.
    assert.doesNotMatch(checkout, /requireSession/);
    assert.doesNotMatch(portal, /requireSession/);
    assert.match(portal, /return NextResponse\.json\(\{ error: "Sign in required\." \}, \{ status: 401 \}\)/);
  });
});

describe("a returnUrl on the card path is this site's or nothing", () => {
  it("goes through sameOriginReturnUrl on checkout and on the portal", () => {
    assert.match(checkout, /const ret = sameOriginReturnUrl\(body\.returnUrl\);/);
    assert.match(portal, /const ret = sameOriginReturnUrl\(body\.returnUrl\);/);
    assert.match(stripeModule, /export function sameOriginReturnUrl\(raw: unknown\): string \| null \{/);
  });

  it("fails closed when the deployment has not named its own origin", () => {
    assert.match(stripeModule, /const appUrl = process\.env\.NEXT_PUBLIC_APP_URL;/);
    assert.match(stripeModule, /if \(!appUrl\) return null;/);
  });
});

describe("one subscription per workspace", () => {
  it("asks the row this app trusts, not Stripe", () => {
    assert.match(checkout, /db\.subscription\.findUnique\(\{\s*where: \{ workspaceId: session\.workspaceId \}/);
    assert.doesNotMatch(checkout, /subscriptions\.list/, "an API call here decides nothing that the database does not already know");
  });

  it("refuses every status that is still a live subscription", () => {
    assert.match(checkout, /SUBSCRIPTION_STATUS_OPEN as readonly string\[\]\)\.includes\(current\.status\)/);
    assert.doesNotMatch(checkout, /\[\s*"trialing"/, "the set is named once, in lib/stripe.ts");
    // The access set is unchanged — unpaid is a live subscription, not access
    // — and the refusal set is it plus the status dunning ends in, whose open
    // invoice the portal settles.
    assert.match(stripeModule, /export const SUBSCRIPTION_STATUS_ACTIVE = \["trialing", "active", "past_due"\] as const;/);
    assert.match(stripeModule, /export const SUBSCRIPTION_STATUS_OPEN = \[\.\.\.SUBSCRIPTION_STATUS_ACTIVE, "unpaid"\] as const;/);
    // `incomplete` stays allowed on purpose: abetConnect charges at checkout,
    // a declined card leaves one behind, and Stripe expires it on its own.
    assert.doesNotMatch(stripeModule, /SUBSCRIPTION_STATUS_OPEN = \[[^\]]*"incomplete"/);
  });

  it("returns before it can make a customer or a subscription", () => {
    assert.ok(checkout.indexOf(NO_PLAN) < checkout.indexOf(BUY));
  });

  it("says where to go instead, in the same breath as the refusal", () => {
    assert.match(checkout, /billing portal/);
    assert.match(checkout, /second subscription, and a second invoice/);
  });

  it("keeps the status it refused in the message", () => {
    assert.match(checkout, /`This workspace is already on a \$\{current\.status\} plan\./);
  });
});

describe("one open checkout session per buyer", () => {
  it("hands back the session already open instead of minting a twin", () => {
    assert.match(stripeModule, /checkout\.sessions\.list\(\{ customer: customerId, status: "open", limit: 10 \}\)/);
    assert.match(stripeModule, /s\.metadata\?\.workspaceId === workspaceId/);
    assert.match(stripeModule, /s\.metadata\?\.priceId === priceId/);
    // A session open on the other price is expired rather than left behind.
    assert.match(stripeModule, /checkout\.sessions\.expire\(s\.id\)/);
    // Stamped, so the next press can recognise its own session.
    assert.match(stripeModule, /metadata: \{ workspaceId, priceId \}/);
  });

  it("shares one idempotency key across clicks that race the lookup", () => {
    assert.match(
      stripeModule,
      /idempotencyKey: `checkout:\$\{workspaceId\}:\$\{priceId\}:\$\{Math\.floor\(Date\.now\(\) \/ 10_000\)\}`/,
    );
  });

  it("still gets the buyer to a checkout if the reuse lookup itself fails", () => {
    assert.match(stripeModule, /catch \(err\) \{\s*console\.error\("\[billing\] checkout reuse lookup failed/);
  });
});

describe("the pricing page in front of somebody who already pays", () => {
  it("reads the session, then the row that belongs to it", () => {
    assert.match(pricingPage, /const session = await getSession\(\);/);
    assert.match(pricingPage, /db\.subscription\.findUnique\(\{\s*where: \{ workspaceId: session\.workspaceId \}/);
  });

  it("uses the same live-subscription set as the checkout route", () => {
    assert.match(pricingPage, /SUBSCRIPTION_STATUS_OPEN as readonly string\[\]\)\.includes\(plan\.status\)/);
  });

  it("gives the buy buttons back to a workspace that cancelled", () => {
    assert.equal((pricingPage.match(/billed && plan\?\.stripePriceId/g) ?? []).length, 2);
    assert.equal((pricingPage.match(/<BuyButton/g) ?? []).length, 2, "one per card");
  });

  it("keeps abetConnect's no-card-trial story out of the Stripe trial window", () => {
    // The demo workspace is the trial; the paid checkout charges immediately.
    assert.doesNotMatch(stripeModule, /trial_period_days/);
    assert.match(pricingPage, /No card required/);
  });
});
