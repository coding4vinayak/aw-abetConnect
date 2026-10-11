import { NextResponse } from "next/server";
import { createPortalSession } from "@/lib/stripe";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * POST /api/billing/portal
 * Body: { returnUrl }
 * Returns: { url } — redirect the user to the Stripe Customer Portal.
 */
export async function POST(request: Request) {
  const session = await requireSession();
  const workspaceId = session.workspaceId;

  const body = await request.json();
  const returnUrl = body.returnUrl as string;

  if (!returnUrl) {
    return NextResponse.json({ error: "returnUrl required" }, { status: 400 });
  }

  try {
    const url = await createPortalSession(workspaceId, returnUrl);
    return NextResponse.json({ url });
  } catch (err) {
    console.error("[billing] portal error:", err);
    return NextResponse.json({ error: "Could not create portal session" }, { status: 500 });
  }
}