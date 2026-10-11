import { NextResponse } from "next/server";
import { createCheckoutSession } from "@/lib/stripe";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * POST /api/billing/checkout
 * Body: { priceId: "SEAT_MONTHLY" | "SEAT_ANNUAL", returnUrl }
 * Returns: { url } — redirect the user to this URL.
 */
export async function POST(request: Request) {
  const session = await requireSession();
  const workspaceId = session.workspaceId;

  const body = await request.json();
  const priceId = body.priceId as "SEAT_MONTHLY" | "SEAT_ANNUAL";
  const returnUrl = body.returnUrl as string;

  if (!priceId || !returnUrl) {
    return NextResponse.json({ error: "priceId and returnUrl required" }, { status: 400 });
  }

  try {
    const url = await createCheckoutSession(workspaceId, priceId, returnUrl);
    return NextResponse.json({ url });
  } catch (err) {
    console.error("[billing] checkout error:", err);
    return NextResponse.json({ error: "Could not create checkout session" }, { status: 500 });
  }
}