import { NextResponse } from "next/server";
import Stripe from "stripe";
import { getStripe, verifyWebhook, syncSubscriptionFromStripe } from "@/lib/stripe";
import { db } from "@/lib/db";
import { claimStripeEvent, finishStripeEvent } from "@/lib/billing-events";
import { DUNNING_STATUSES, sendCancellation, sendDunning, sendReceipt, sendRecovered } from "@/lib/billing-mails";

export const dynamic = "force-dynamic";

/**
 * Apply a subscription snapshot only if it is not older than the newest one
 * this row has already applied — and announce the one transition that deserves
 * a mail of its own.
 *
 * Stripe delivers in no promised order: a late "trialing" snapshot delivered
 * after the conversion would otherwise drag a paying buyer backwards. Exact
 * redeliveries never reach this point — the event claim in POST answers them.
 * This guards the event that is *late*, not the one that is repeated.
 *
 * The previous status is read from the local row *before* the sync overwrites
 * it — Stripe events do not carry the old state, and a transition you cannot
 * see is a transition you cannot announce. Returns whether the event was
 * applied; `false` means a late, already-superseded snapshot, which must not
 * announce anything either.
 */
async function syncAndAnnounce(stripeSub: Stripe.Subscription, eventCreatedAt: number) {
  const workspaceId = stripeSub.metadata.workspaceId as string | undefined;
  const previous = workspaceId
    ? await db.subscription.findUnique({
        where: { workspaceId },
        select: { status: true, lastStripeEventAt: true },
      })
    : null;

  const at = new Date(eventCreatedAt * 1000);
  if (previous?.lastStripeEventAt && at < previous.lastStripeEventAt) {
    console.log(
      `[billing] stale subscription event skipped: ${at.toISOString()} < ${previous.lastStripeEventAt.toISOString()}`,
    );
    return false;
  }

  await syncSubscriptionFromStripe(stripeSub, at);

  // The one transition abetConnect announces: a past-due subscription that
  // recovered. Silence here reads as "still broken" and prompts a
  // cancellation. The sync above has already committed, and `sendRecovered`
  // swallows its own failures — a mail must never fail a webhook whose work
  // is done.
  if (previous && workspaceId && previous.status === "past_due" && stripeSub.status === "active") {
    await sendRecovered(workspaceId);
  }

  return true;
}

export async function POST(request: Request) {
  const signature = request.headers.get("stripe-signature");
  const rawBody = await request.text();

  let event;
  try {
    event = verifyWebhook(rawBody, signature);
  } catch (err) {
    console.error("[billing] webhook signature verification failed:", err);
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  const claim = await claimStripeEvent(event).catch((error) => {
    // Nothing has happened yet, so the failure can be loud: the claim table is
    // the record that this delivery was seen, and a delivery without a record
    // must be retried by Stripe rather than half-processed.
    console.error("[billing] event claim failed:", error);
    return null;
  });
  if (!claim) {
    return NextResponse.json({ error: "Event not recorded" }, { status: 500 });
  }
  if (claim !== "process") {
    // "duplicate" is a replay of a settled event. "in_flight" is the same id
    // arriving while its first attempt is still running — non-2xx asks Stripe
    // to come back later, by which time the first attempt has finished
    // ("duplicate") or died ("retry" on a later delivery). "retry" itself
    // means a claim was written once and never finished: run it again now.
    console.log(`[billing] ${event.type}: ${claim} (${event.id})`);
    if (claim === "duplicate") return NextResponse.json({ received: true, duplicate: true });
    if (claim === "in_flight") return NextResponse.json({ error: "Event already in flight" }, { status: 409 });
  }

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.mode === "subscription" && typeof session.subscription === "string") {
        const sub = await getStripe().subscriptions.retrieve(session.subscription);
        await syncSubscriptionFromStripe(sub);
        // After the sync, never instead of it: the receipt is best-effort.
        await sendReceipt(session);
      }
      break;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated": {
      await syncAndAnnounce(event.data.object as Stripe.Subscription, event.created);
      break;
    }
    case "customer.subscription.deleted": {
      const stripeSub = event.data.object as Stripe.Subscription;
      const applied = await syncAndAnnounce(stripeSub, event.created);
      const workspaceId = stripeSub.metadata.workspaceId as string | undefined;
      if (applied && workspaceId) await sendCancellation(workspaceId);
      break;
    }
    case "invoice.payment_failed": {
      const invoice = event.data.object as Stripe.Invoice;
      // Invoice shape drifts across SDK versions (subscription vs parent
      // .subscription_details.subscription) — read defensively, skip if absent.
      const inv = invoice as Stripe.Invoice & { subscription?: unknown };
      const parent = (invoice as unknown as { parent?: { subscription_details?: { subscription?: unknown } } }).parent;
      const subId =
        typeof inv.subscription === "string"
          ? inv.subscription
          : typeof parent?.subscription_details?.subscription === "string"
            ? parent.subscription_details.subscription
            : undefined;
      if (subId) {
        const stripeSub = await getStripe().subscriptions.retrieve(subId);
        await syncSubscriptionFromStripe(stripeSub);
        // Only a status that still describes an open problem is dunned: a
        // fresh retrieve that comes back healthy must not mail a lie.
        if ((DUNNING_STATUSES as readonly string[]).includes(stripeSub.status)) {
          await sendDunning(stripeSub);
        }
      }
      break;
    }
    default:
      console.log(`[billing] unhandled event: ${event.type}`);
  }

  await finishStripeEvent(event.id);
  return NextResponse.json({ received: true });
}