import { createHash, randomBytes } from "node:crypto";
import { db } from "./db";

export const VERIFICATION_TOKEN_EXPIRY_HOURS = 24;
export const PASSWORD_RESET_TOKEN_EXPIRY_HOURS = 1;
export const PASSWORD_RESET_RATE_LIMIT = 3;
export const PASSWORD_RESET_WINDOW_HOURS = 1;

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

export async function createEmailVerificationToken(userId: string): Promise<string> {
  const token = generateToken();
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + VERIFICATION_TOKEN_EXPIRY_HOURS * 60 * 60 * 1000);

  await db.emailVerificationToken.upsert({
    where: { userId },
    create: { userId, tokenHash, expiresAt },
    update: { tokenHash, expiresAt },
  });

  return token;
}

export async function consumeEmailVerificationToken(userId: string, token: string): Promise<boolean> {
  const tokenHash = hashToken(token);
  const record = await db.emailVerificationToken.findUnique({ where: { userId } });

  if (!record || record.tokenHash !== tokenHash) return false;
  if (record.expiresAt < new Date()) return false;

  await db.emailVerificationToken.delete({ where: { userId } });
  return true;
}

export async function createPasswordResetToken(userId: string): Promise<string> {
  const token = generateToken();
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + PASSWORD_RESET_TOKEN_EXPIRY_HOURS * 60 * 60 * 1000);

  await db.passwordResetToken.create({
    data: { userId, tokenHash, expiresAt },
  });

  return token;
}

export async function consumePasswordResetToken(userId: string, token: string): Promise<boolean> {
  const tokenHash = hashToken(token);
  const record = await db.passwordResetToken.findUnique({ where: { tokenHash } });

  if (!record || record.userId !== userId) return false;
  if (record.expiresAt < new Date()) return false;

  await db.passwordResetToken.delete({ where: { id: record.id } });
  return true;
}

export async function checkPasswordResetRateLimit(email: string): Promise<{ allowed: boolean; retryAfterMinutes?: number }> {
  const key = `password-reset:${email.toLowerCase()}`;
  const windowMs = PASSWORD_RESET_WINDOW_HOURS * 60 * 60 * 1000;
  const now = Date.now();

  const record = await db.authThrottle.findUnique({ where: { key } });
  if (!record) return { allowed: true };

  const windowStart = record.windowStart.getTime();
  if (now - windowStart > windowMs) return { allowed: true };
  if (record.count >= PASSWORD_RESET_RATE_LIMIT) {
    const retryAfterMinutes = Math.ceil((windowStart + windowMs - now) / 60000);
    return { allowed: false, retryAfterMinutes };
  }
  return { allowed: true };
}

export async function recordPasswordResetAttempt(email: string): Promise<void> {
  const key = `password-reset:${email.toLowerCase()}`;
  const windowMs = PASSWORD_RESET_WINDOW_HOURS * 60 * 60 * 1000;
  const now = Date.now();

  const record = await db.authThrottle.findUnique({ where: { key } });
  const windowStart = record?.windowStart.getTime() ?? now;
  const expired = now - windowStart > windowMs;
  const count = expired ? 1 : (record?.count ?? 0) + 1;

  await db.authThrottle.upsert({
    where: { key },
    create: { key, count, windowStart: new Date(now) },
    update: { count, windowStart: expired ? new Date(now) : (record?.windowStart ?? new Date(now)) },
  });
}

export function getVerificationUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/$/, "")}/verify-email?token=${token}`;
}

export function getPasswordResetUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/$/, "")}/reset-password?token=${token}`;
}
