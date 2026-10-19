import { NextResponse } from "next/server";
import {
  createCheckoutSession,
  PRICES,
  sameOriginReturnUrl,
  SUBSCRIPTION_STATUS_OPEN,
} from "@/lib/stripe";
import { getSession } from "@/lib/session";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * POST /api/billing/checkout
 * Body: { priceId: "SEAT_MONTHLY" | "SEAT_ANNUAL", returnUrl }
 * Returns: { url } — redirect the user to this URL.
 *
 * Every input here has a job. The workspace comes from the signed-in session
 * and nothing else — an anonymous caller cannot hand this route somebody
 * else's workspace and have it acquire a Stripe customer. `priceId` is checked
 * against this product's own prices before Stripe ever sees it, so a typo
 * cannot become a 500 that looks like an outage. `returnUrl` has to be a page
 * on this site, because Stripe sends the buyer there directly after the card.
 * And a workspace that already has a live subscription is refused in favour
 * of the portal: a second checkout is a second subscription, and a second
 * invoice.
 */
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in required." }, { status: 401 });

  const body = (await request.json().catch(() => null)) as { priceId?: unknown; returnUrl?: unknown } | null;
  if (!body || typeof body !== "object") return NextResponse.json({ error: "JSON body required" }, { status: 400 });

  const priceId = body.priceId;
  if (typeof priceId !== "string" || !(priceId in PRICES)) {
    return NextResponse.json({ error: `priceId must be one of ${Object.keys(PRICES).join(", ")}` }, { status: 400 });
  }
  const ret = sameOriginReturnUrl(body.returnUrl);
  if (!ret) return NextResponse.json({ error: "returnUrl must be a page on this site" }, { status: 400 });

  // The refusal set is wider than "has access": `unpaid` is a subscription
  // whose dunning ran out, with an open invoice the portal can settle — a new
  // checkout pays neither invoice. `incomplete` is deliberately allowed: it
  // never charged and Stripe expires it on its own, and starting over is how
  // the buyer whose card was declined tries once more.
  const current = await db.subscription.findUnique({
    where: { workspaceId: session.workspaceId },
    select: { status: true },
  });
  if (current && (SUBSCRIPTION_STATUS_OPEN as readonly string[]).includes(current.status)) {
    return NextResponse.json(
      {
        error:
          `This workspace is already on a ${current.status} plan. Switch plan or fix the card in the ` +
          "billing portal — a second checkout would be a second subscription, and a second invoice.",
      },
      { status: 409 },
    );
  }

  try {
    const url = await createCheckoutSession(session.workspaceId, priceId as keyof typeof PRICES, ret);
    return NextResponse.json({ url });
  } catch (err) {
    console.error("[billing] checkout error:", err);
    return NextResponse.json({ error: "Could not create checkout session" }, { status: 500 });
  }
}
