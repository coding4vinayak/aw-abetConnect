import { NextResponse } from "next/server";
import { hashToken } from "@/lib/tokens";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * GET /api/auth/verify-email?token=...
 *
 * Public endpoint (no session) that consumes a verification token.
 * On success, marks the user's email as verified and returns a page
 * that redirects to /login with a success message.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  if (!token) {
    return new NextResponse(
      `<!DOCTYPE html><html><body style="font-family:system-ui;padding:2rem;text-align:center;">
        <h1>Invalid or expired link</h1>
        <p>This verification link is invalid or has expired.</p>
        <p><a href="/signup">Create a new account</a> or <a href="/login">sign in</a>.</p>
      </body></html>`,
      { status: 400, headers: { "Content-Type": "text/html" } },
    );
  }

  const tokenHash = hashToken(token);
  const record = await db.emailVerificationToken.findUnique({ where: { tokenHash } });

  if (!record || record.expiresAt < new Date()) {
    return new NextResponse(
      `<!DOCTYPE html><html><body style="font-family:system-ui;padding:2rem;text-align:center;">
        <h1>Invalid or expired link</h1>
        <p>This verification link is invalid or has expired.</p>
        <p><a href="/signup">Create a new account</a> or <a href="/login">sign in</a>.</p>
      </body></html>`,
      { status: 400, headers: { "Content-Type": "text/html" } },
    );
  }

  await db.$transaction([
    db.user.update({ where: { id: record.userId }, data: { emailVerified: true } }),
    db.emailVerificationToken.delete({ where: { id: record.id } }),
  ]);

  return new NextResponse(
    `<!DOCTYPE html><html><body style="font-family:system-ui;padding:2rem;text-align:center;">
      <h1>Email verified!</h1>
      <p>Your email address has been verified. You can now sign in.</p>
      <p><a href="/login" style="background:#2563eb;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block;margin-top:1rem;">Sign in</a></p>
    </body></html>`,
    { status: 200, headers: { "Content-Type": "text/html" } },
  );
}
