import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { createEmailVerificationToken, getVerificationUrl } from "@/lib/tokens";
import { getEmailSender, renderVerificationEmail } from "@/lib/email";
import { apiError } from "@/lib/api";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * POST /api/auth/send-verification
 *
 * Resends the verification email to the currently signed-in user.
 * Requires an active session; the user must exist and not already be verified.
 */
export async function POST() {
  const session = await getSession();
  if (!session) {
    return apiError("authentication_error", 401, "Sign in first.");
  }

  const user = await db.user.findUnique({
    where: { id: session.userId },
    select: { id: true, email: true, name: true, emailVerified: true },
  });
  if (!user) {
    return apiError("not_found", 404, "User not found.");
  }
  if (user.emailVerified) {
    return NextResponse.json({ ok: true, alreadyVerified: true });
  }

  const token = await createEmailVerificationToken(user.id);
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const verifyUrl = getVerificationUrl(baseUrl, token);

  const emailData = { name: user.name, verifyUrl, expiresHours: 24 };
  const { html, text } = renderVerificationEmail(emailData);

  await getEmailSender().send(user.email, "Verify your abetConnect email", html, text);

  return NextResponse.json({ ok: true, sent: true });
}
