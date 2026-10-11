import { NextResponse } from "next/server";
import { createPasswordResetToken, getPasswordResetUrl, checkPasswordResetRateLimit, recordPasswordResetAttempt } from "@/lib/tokens";
import { getEmailSender, renderPasswordResetEmail } from "@/lib/email";
import { db } from "@/lib/db";
import { apiError } from "@/lib/api";

export const dynamic = "force-dynamic";

/**
 * POST /api/auth/forgot-password
 *
 * Public endpoint that initiates a password reset. Always returns 200
 * with { ok: true } to prevent email enumeration — the rate limit is
 * keyed by the submitted email address.
 */
export async function POST(request: Request) {
  let email: string;
  try {
    const body = (await request.json()) as { email?: unknown };
    email = String(body.email ?? "").trim().toLowerCase();
  } catch {
    return apiError("invalid_request", 422, "Email is required.", { param: "email" });
  }
  if (!email || !email.includes("@")) {
    return apiError("invalid_request", 422, "Enter a valid email.", { param: "email" });
  }

  const rate = await checkPasswordResetRateLimit(email);
  if (!rate.allowed) {
    return apiError("rate_limit_error", 429, `Too many reset requests. Try again in ${rate.retryAfterMinutes} minute(s).`);
  }

  await recordPasswordResetAttempt(email);

  const user = await db.user.findUnique({ where: { email }, select: { id: true, name: true, email: true } });
  if (user) {
    const token = await createPasswordResetToken(user.id);
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
    const resetUrl = getPasswordResetUrl(baseUrl, token);

    const emailData = { name: user.name, resetUrl, expiresHours: 1 };
    const { html, text } = renderPasswordResetEmail(emailData);

    await getEmailSender().send(user.email, "Reset your abetConnect password", html, text);
  }

  return NextResponse.json({ ok: true });
}
