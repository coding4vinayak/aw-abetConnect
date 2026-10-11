import { NextResponse } from "next/server";
import { hashToken } from "@/lib/tokens";
import { db } from "@/lib/db";
import { hashPassword } from "@/lib/password";
import { apiError } from "@/lib/api";

export const dynamic = "force-dynamic";

/**
 * POST /api/auth/reset-password
 *
 * Public endpoint that consumes a reset token and sets a new password.
 */
export async function POST(request: Request) {
  let token: string, password: string;
  try {
    const body = (await request.json()) as { token?: unknown; password?: unknown };
    token = String(body.token ?? "").trim();
    password = String(body.password ?? "");
  } catch {
    return apiError("invalid_request", 422, "Token and password are required.", { param: "token" });
  }

  if (!token) return apiError("invalid_request", 422, "Missing token.", { param: "token" });
  if (!password || password.length < 8) {
    return apiError("invalid_request", 422, "Password must be at least 8 characters.", { param: "password" });
  }

  const tokenHash = hashToken(token);
  const record = await db.passwordResetToken.findUnique({ where: { tokenHash } });

  if (!record || record.expiresAt < new Date()) {
    return apiError("invalid_request", 422, "This reset link is invalid or has expired.", { param: "token" });
  }

  await db.$transaction([
    db.user.update({ where: { id: record.userId }, data: { passwordHash: await hashPassword(password) } }),
    db.passwordResetToken.delete({ where: { id: record.id } }),
    // A password reset is what someone does *because* they think another person
    // has access. Without this, every existing session keeps working after the
    // password changes, so whoever prompted the reset is still signed in — the
    // reset would change nothing about the situation it was meant to end.
    db.session.deleteMany({ where: { userId: record.userId } }),
  ]);

  return NextResponse.json({ ok: true });
}
