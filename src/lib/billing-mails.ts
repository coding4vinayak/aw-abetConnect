/**
 * What abetConnect tells its customers about their billing.
 *
 * Four mails, each driven by an event this app has already committed: the
 * receipt after checkout, the dunning notice when a payment fails, the
 * all-clear when it recovers, and the confirmation when a subscription ends.
 *
 * Two rules shape every function here:
 *
 * 1. **The address comes from the workspace, not from Stripe.** `ensureCustomer`
 *    creates the customer with an empty email — checkout collects one from the
 *    buyer, but nothing guarantees Stripe writes it back. The owner of the
 *    workspace is an answer this app has always held; a customer-shaped lookup
 *    is a way to lose a declined-payment notice over a field this app already
 *    knows.
 *
 * 2. **A mail never fails a webhook.** Stripe calls a sender only after the
 *    subscription row is written. Answering non-2xx then would make Stripe
 *    retry a delivery whose work is done — and the retry no longer sees the
 *    transition to announce, so a loud failure does not delay the mail, it
 *    deletes it. Every sender here swallows its own errors and says so in the
 *    log instead.
 */
import type Stripe from "stripe";
import { db } from "./db";
import { getStripe } from "./stripe";
import {
  appBaseUrl,
  getEmailSender,
  productName,
  renderCancellationEmail,
  renderPaymentFailedEmail,
  renderPaymentRecoveredEmail,
  renderReceiptEmail,
} from "./email";

/**
 * The statuses that still describe an open payment problem. Dunning tells the
 * buyer their payment failed, so it is only true for these — a fresh retrieve
 * that comes back `active` means the failure is resolved (or Stripe is still
 * retrying the charge) and the mail would be telling a healthy buyer a lie.
 */
export const DUNNING_STATUSES = ["past_due", "unpaid", "incomplete"] as const;

/**
 * Who billing mail is addressed to: the workspace's first owner, from the
 * local membership row. See rule 1 at the top of this file for why Stripe is
 * never asked.
 */
export async function ownerOf(workspaceId: string) {
  return db.membership.findFirst({
    where: { workspaceId, role: "OWNER" },
    orderBy: { createdAt: "asc" },
    select: { user: { select: { email: true, name: true } } },
  });
}

/**
 * Confirms the payment to the buyer. Driven off the checkout session (which
 * carries the customer email) rather than a later subscription event, so the
 * receipt fires exactly once per purchase — and the event claim in POST is
 * what keeps that true when Stripe redelivers. The period end is a nicety:
 * a receipt without a date still confirms payment.
 */
export async function sendReceipt(session: Stripe.Checkout.Session) {
  try {
    const email = session.customer_details?.email ?? session.customer_email;
    if (!email) return;
    const subId = typeof session.subscription === "string" ? session.subscription : undefined;
    let periodEnd: Date | null = null;
    if (subId) {
      try {
        const sub = await getStripe().subscriptions.retrieve(subId);
        const raw = sub.items.data[0]?.current_period_end;
        if (typeof raw === "number") periodEnd = new Date(raw * 1000);
      } catch {
        // period end is a nicety; a receipt without a date still confirms payment.
      }
    }
    const { subject, html, text: plain } = renderReceiptEmail({
      product: productName(),
      name: session.customer_details?.name ?? null,
      planLabel: `${productName()} subscription`,
      periodEnd,
      portalUrl: `${appBaseUrl()}/members`,
    });
    await getEmailSender().send(email, subject, html, plain);
  } catch (error) {
    console.error("[billing] receipt not sent:", error);
  }
}

/**
 * The declined-payment notice. Fires on every invoice.payment_failed that
 * leaves the subscription in a dunning status, so the last one before Stripe
 * cancels is always seen.
 */
export async function sendDunning(stripeSub: Stripe.Subscription) {
  try {
    const workspaceId = stripeSub.metadata.workspaceId as string | undefined;
    if (!workspaceId) return;
    const owner = await ownerOf(workspaceId);
    if (!owner) return;
    const { subject, html, text: plain } = renderPaymentFailedEmail({
      product: productName(),
      name: owner.user.name,
      portalUrl: `${appBaseUrl()}/members`,
    });
    await getEmailSender().send(owner.user.email, subject, html, plain);
  } catch (error) {
    console.error("[billing] dunning mail not sent:", error);
  }
}

/**
 * The all-clear for a payment that failed and then went through. Only sent on
 * a real past-due → active transition — silence here reads as "still broken"
 * and prompts a cancellation. The caller reads the previous status from the
 * local row before the sync overwrites it; Stripe events do not carry the old
 * state, and a transition you cannot see is a transition you cannot announce.
 */
export async function sendRecovered(workspaceId: string) {
  try {
    const owner = await ownerOf(workspaceId);
    if (!owner) return;
    const { subject, html, text: plain } = renderPaymentRecoveredEmail({
      product: productName(),
      name: owner.user.name,
      appUrl: `${appBaseUrl()}/`,
    });
    await getEmailSender().send(owner.user.email, subject, html, plain);
  } catch (error) {
    console.error("[billing] recovery mail not sent:", error);
  }
}

/**
 * The cancellation confirmation. The buyer already clicked cancel in the
 * portal; this only answers the two questions that raises — will I be charged
 * again, and is my data gone — and points at the pricing page in case the
 * answer to the second one matters.
 */
export async function sendCancellation(workspaceId: string) {
  try {
    const owner = await ownerOf(workspaceId);
    if (!owner) return;
    const { subject, html, text: plain } = renderCancellationEmail({
      product: productName(),
      name: owner.user.name,
      pricingUrl: `${appBaseUrl()}/pricing`,
    });
    await getEmailSender().send(owner.user.email, subject, html, plain);
  } catch (error) {
    console.error("[billing] cancellation mail not sent:", error);
  }
}
