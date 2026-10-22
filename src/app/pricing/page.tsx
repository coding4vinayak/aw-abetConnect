import type { Metadata } from "next";
import { SiteNav, SiteFooter } from "@/components/site";
import { BuyButton } from "@/components/buy-button";
import { ManageBillingButton } from "@/components/manage-billing";
import { db } from "@/lib/db";
import { getSession } from "@/lib/session";
import { PRICES, SUBSCRIPTION_STATUS_OPEN } from "@/lib/stripe";

export const metadata: Metadata = {
  title: "Pricing — abetConnect",
  description: "abetConnect pricing: $24 per agent/month, with a 14-day free trial.",
};

/**
 * What a workspace that is already paying needs to be told before it shops:
 * which card it is on, and where changes actually happen. `POST
 * /api/billing/checkout` refuses a live subscription, so a start button
 * in front of a paying customer would be a button that only ever says no.
 */
function planLine(status: string, priceId: string | null, periodEnd: Date | null): string {
  const named = priceId === PRICES.SEAT_ANNUAL ? "Annual" : priceId === PRICES.SEAT_MONTHLY ? "Monthly" : "current";
  if (status === "trialing") {
    const until = periodEnd ? new Intl.DateTimeFormat("en", { dateStyle: "long" }).format(periodEnd) : null;
    return `This workspace is trialing the ${named} plan${until ? ` until ${until}` : ""}, when the first invoice lands.`;
  }
  if (status === "past_due") {
    return `This workspace is on the ${named} plan, and its last payment was declined. Updating the card is the fix — a new subscription would not pay the old one.`;
  }
  if (status === "unpaid") {
    return `This workspace is on the ${named} plan, and its payments have run out. The portal is where the open invoice is settled — a new subscription would not pay the old one.`;
  }
  return `This workspace is on the ${named} plan.`;
}

export default async function Page() {
  const session = await getSession();
  const plan = session
    ? await db.subscription.findUnique({
        where: { workspaceId: session.workspaceId },
        select: { status: true, stripePriceId: true, stripeCurrentPeriodEnd: true },
      })
    : null;
  const billed = plan !== null && (SUBSCRIPTION_STATUS_OPEN as readonly string[]).includes(plan.status);

  return (
    <div className="min-h-screen bg-surface text-foreground">
      <SiteNav />
      <main className="mx-auto max-w-4xl px-6 py-12">
        <h1 className="text-3xl font-bold tracking-tight">Pricing</h1>
        <p className="mt-2 text-muted">
          One plan, everything included. You pay per agent: checkout bills the size of your
          team — everyone in the workspace plus invites still outstanding — and the billing
          portal is where seats go up or down afterwards. Enterprise adds SSO, audit exports,
          and a 99.9% SLA.
        </p>
        {billed && plan ? (
          <div className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900">
            <span>{planLine(plan.status, plan.stripePriceId, plan.stripeCurrentPeriodEnd)}</span>
            <ManageBillingButton label="Change plan in the portal" />
          </div>
        ) : null}
        <div className="mt-8 grid gap-6 sm:grid-cols-3">
          <div className="rounded-2xl border p-6 border-line bg-surface-raised">
            <p className="text-sm font-semibold uppercase tracking-wide text-muted">Monthly</p>
            <p className="mt-2 text-4xl font-bold">$24</p>
            <p className="mt-1 text-sm text-muted">per agent/month</p>
            {billed && plan?.stripePriceId === PRICES.SEAT_MONTHLY ? (
              <p className="mt-6 rounded-lg bg-green-50 px-4 py-2 text-center text-sm font-semibold text-green-700">Your plan</p>
            ) : billed ? (
              <div className="mt-6"><ManageBillingButton label="Switch in the portal" /></div>
            ) : (
              <div className="mt-6"><BuyButton priceId="SEAT_MONTHLY" label="Start 14-day free trial" /></div>
            )}
          </div>
          <div className="rounded-2xl border-2 border-blue-600 p-6 bg-surface-raised">
            <p className="text-sm font-semibold uppercase tracking-wide text-blue-600">Annual — 2 months free</p>
            <p className="mt-2 text-4xl font-bold">$240</p>
            <p className="mt-1 text-sm text-muted">per agent/month, billed yearly</p>
            {billed && plan?.stripePriceId === PRICES.SEAT_ANNUAL ? (
              <p className="mt-6 rounded-lg bg-green-50 px-4 py-2 text-center text-sm font-semibold text-green-700">Your plan</p>
            ) : billed ? (
              <div className="mt-6"><ManageBillingButton label="Switch in the portal" /></div>
            ) : (
              <div className="mt-6"><BuyButton priceId="SEAT_ANNUAL" label="Start 14-day free trial" /></div>
            )}
          </div>
          <div className="rounded-2xl border p-6 border-line bg-surface-raised">
            <p className="text-sm font-semibold uppercase tracking-wide text-muted">Enterprise</p>
            <p className="mt-2 text-4xl font-bold">Custom</p>
            <p className="mt-1 text-sm text-muted">Audit exports available; SSO, SLA and onboarding by custom arrangement</p>
            <a href="mailto:support@abetworks.in?subject=abetConnect%20enterprise" className="mt-6 block rounded-lg border border-blue-600 px-4 py-2 text-center text-sm font-semibold text-blue-600 hover:bg-blue-50 transition">Talk to us</a>
          </div>
        </div>
        <h2 className="mt-12 text-xl font-bold">Also in the Abetworks suite</h2>
        <p className="mt-2 text-gray-600">
          AbetConnect is one of the products in the Abetworks suite, and every one of them is sold on its own.
          These are the products that put the conversations in front of the people who act on them — each has its own sign-up, and 
          <a href="mailto:support@abetworks.in?subject=One%20workspace%20across%20the%20Abetworks%20suite" className="underline">
            one contract can set up a workspace across all of them
          </a>
          .
        </p>
        <div className="mt-6 space-y-3">
          <a href="https://leadgenius.abetworks.in" className="block rounded-2xl border border-gray-200 bg-white p-4 shadow-sm hover:bg-gray-50 transition">
            <span className="font-semibold text-gray-900">LeadGenius</span> <span className="text-gray-600">— multichannel outreach with warmup and deliverability guardrails, so cold email lands where it should. $29 per user per month.</span>
          </a>
          <a href="https://leadworks.abetworks.in" className="block rounded-2xl border border-gray-200 bg-white p-4 shadow-sm hover:bg-gray-50 transition">
            <span className="font-semibold text-gray-900">LeadWorks</span> <span className="text-gray-600">— lead operations — capture every lead once (duplicates refused at the door), with validation, dedupe and CRM-ready CSV exports. $49 per month.</span>
          </a>
          <a href="https://abetagent.abetworks.in" className="block rounded-2xl border border-gray-200 bg-white p-4 shadow-sm hover:bg-gray-50 transition">
            <span className="font-semibold text-gray-900">AbetAgent</span> <span className="text-gray-600">— agents with citations, step traces and human escalation. $99 per month.</span>
          </a>
        </div>
        <h2 className="mt-12 text-xl font-bold">Questions</h2>
        <div className="mt-4 space-y-4">
          <div><p className="font-semibold text-foreground">How are agents counted?</p><p className="mt-1 text-muted">Every member in the workspace, plus every invitation that has not been accepted or expired. Checkout starts on that number, so a pending invitation is already paid for and accepting it does not add a charge. New invitations stop at the paid count until you add seats in the portal.</p></div>
          <div><p className="font-semibold text-foreground">Is there a trial?</p><p className="mt-1 text-muted">Yes, two. The live demo workspace is open to anyone, no card. And every paid plan starts with a 14-day free trial — cancel from the billing portal any time before day 14 and you are not charged.</p></div>
          <div><p className="font-semibold text-foreground">Can I cancel anytime?</p><p className="mt-1 text-muted">Yes. Plans are month-to-month; service runs to the end of your billing period.</p></div>
          <div><p className="font-semibold text-foreground">Who owns our conversation data?</p><p className="mt-1 text-muted">You do. Download the whole workspace as JSON from the Team page whenever you want; we never sell data or train shared models on it.</p></div>
          <div><p className="font-semibold text-foreground">Do you offer annual billing?</p><p className="mt-1 text-muted">Yes — $240 per agent per year, two months free, one invoice.</p></div>
          <div><p className="font-semibold text-foreground">Already paying, and want more seats or the other plan?</p><p className="mt-1 text-muted">The billing portal does it — more or fewer agents, or the annual plan, and a change there credits what you have already paid. Starting a second checkout would be a second subscription with a second invoice.</p></div>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
