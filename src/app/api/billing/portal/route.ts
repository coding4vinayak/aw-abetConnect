import { NextResponse } from "next/server";
import { createPortalSession, sameOriginReturnUrl } from "@/lib/stripe";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * POST /api/billing/portal
 * Body: { returnUrl }
 * Returns: { url } — redirect the user to the Stripe Customer Portal.
 *
 * Same rules as checkout: the workspace is the session's, an anonymous caller
 * gets a 401 in the API's own language (not a redirect into the HTML login
 * page), and `returnUrl` has to be a page this site minted — it is where
 * Stripe sends the buyer straight out of a page that manages their billing.
 */
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in required." }, { status: 401 });

  const body = (await request.json().catch(() => null)) as { returnUrl?: unknown } | null;
  if (!body || typeof body !== "object") return NextResponse.json({ error: "JSON body required" }, { status: 400 });

  const ret = sameOriginReturnUrl(body.returnUrl);
  if (!ret) return NextResponse.json({ error: "returnUrl must be a page on this site" }, { status: 400 });

  try {
    const url = await createPortalSession(session.workspaceId, ret);
    return NextResponse.json({ url });
  } catch (err) {
    console.error("[billing] portal error:", err);
    return NextResponse.json({ error: "Could not create portal session" }, { status: 500 });
  }
}
