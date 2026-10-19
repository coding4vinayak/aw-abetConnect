"use server";

import { randomBytes } from "node:crypto";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { hashPassword, verifyPassword } from "@/lib/password";
import { createSession, destroySession } from "@/lib/session";
import {
  appBaseUrl,
  getEmailSender,
  productName,
  renderVerificationEmail,
  verificationEnforced,
} from "@/lib/email";
import {
  VERIFICATION_TOKEN_EXPIRY_HOURS,
  createEmailVerificationToken,
  getVerificationUrl,
} from "@/lib/tokens";
import {
  MAX_SIGNIN_FAILURES,
  MAX_SIGNUPS,
  clearTally,
  clientAddress,
  gate,
  signInKey,
  signUpKey,
  tally,
} from "@/lib/throttle";

/**
 * Account server actions: sign up, sign in, sign out.
 *
 * These live apart from `actions.ts` (the triage dashboard's actions) because
 * they are the only actions that run *without* a session — which is exactly the
 * distinction a reader needs to see when auditing this file.
 */

export interface AuthState {
  error?: string;
  /** Which input to focus, so the message lands next to the problem. */
  field?: "name" | "email" | "password" | "workspace";
}

/** scrypt cost grows with input length, so bound it before hashing. */
const MAX_PASSWORD_LENGTH = 200;
const MIN_PASSWORD_LENGTH = 8;

const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * The refusal an address sees once its budget is gone.
 *
 * It says how long to wait, because an unexplained form that stops working is a
 * form a customer assumes is broken — and the wait is the one thing that makes
 * spreading attempts across more emails pointless.
 */
function waitMessage(minutes: number): string {
  return `Too many attempts from here. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`;
}

function text(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/**
 * Find a free slug. Slugs are in the URL, so two customers called "Acme" must
 * not fight over one workspace.
 */
async function uniqueSlug(source: string): Promise<string> {
  const stem = slugify(source) || "workspace";
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const candidate = attempt === 0 ? stem : `${stem}-${attempt + 1}`;
    const taken = await db.workspace.findUnique({
      where: { slug: candidate },
      select: { id: true },
    });
    if (!taken) return candidate;
  }
  return `${stem}-${randomBytes(4).toString("hex")}`;
}

/**
 * A throwaway digest used only to keep sign-in timing uniform.
 *
 * Built once, lazily, so the cost of a failed login for an address that does not
 * exist is the same as for one that does. Without this, response time alone
 * tells an attacker which email addresses have accounts.
 */
let dummyDigest: string | null = null;
async function getDummyDigest(): Promise<string> {
  dummyDigest ??= await hashPassword(randomBytes(32).toString("hex"));
  return dummyDigest;
}

export async function signUp(_previous: AuthState, formData: FormData): Promise<AuthState> {
  const name = text(formData, "name");
  const email = text(formData, "email").toLowerCase();
  const password = String(formData.get("password") ?? "");
  const requestedWorkspace = text(formData, "workspace");

  // Checked here, tallied on success below. A farmer should be told before the
  // server has hashed a password for an account it is never going to make, but
  // an address must not run out of budget for merely mistyping an email that
  // already exists — that is what the next person on the same connection does.
  const bucket = signUpKey(await clientAddress());
  const allowed = await gate(bucket);
  if (!allowed.allowed) return { error: waitMessage(allowed.retryAfterMinutes) };

  if (name.length < 2) return { error: "Enter your name.", field: "name" };
  if (!EMAIL_PATTERN.test(email)) {
    return { error: "Enter a valid email address.", field: "email" };
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { error: `Use at least ${MIN_PASSWORD_LENGTH} characters.`, field: "password" };
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return { error: "That password is too long.", field: "password" };
  }

  const existing = await db.user.findUnique({ where: { email }, select: { id: true } });
  if (existing) {
    return { error: "An account with that email already exists. Sign in instead.", field: "email" };
  }

  const passwordHash = await hashPassword(password);
  const workspaceName = requestedWorkspace || `${name}'s team`;
  const slug = await uniqueSlug(requestedWorkspace || name);

  let created: { userId: string; workspaceId: string };
  try {
    // One transaction: a user without a workspace, or a workspace with no
    // owner, would both be broken accounts. Neither can exist if this commits
    // or nothing does.
    created = await db.$transaction(async (tx) => {
      const workspace = await tx.workspace.create({ data: { name: workspaceName, slug } });
      const user = await tx.user.create({
        data: {
          email,
          name,
          passwordHash,
          // Pre-verified only when no provider is configured: with mail unable
          // to arrive, demanding a verification click would lock the account
          // out of its own product. With a provider, the account starts
          // unverified and `signIn` enforces the click.
          emailVerified: !verificationEnforced(),
        },
      });
      await tx.membership.create({
        data: { userId: user.id, workspaceId: workspace.id, role: "OWNER" },
      });
      return { userId: user.id, workspaceId: workspace.id };
    });
  } catch {
    // Almost always the unique index on email winning a race between two
    // simultaneous signups with the same address.
    return { error: "That email was just registered. Try signing in instead.", field: "email" };
  }

  // One workspace created, so the address has spent one of its five. Counted
  // only now, so nothing that did not result in a workspace can exhaust it.
  await tally(bucket, MAX_SIGNUPS);

  // Issue the first verification link here, while the token is the only way
  // in. A provider outage must not swallow the signup: the account exists
  // either way, and the signed-in app can re-send the link.
  if (verificationEnforced()) {
    const token = await createEmailVerificationToken(created.userId);
    const { html, text: plain } = renderVerificationEmail({
      name,
      verifyUrl: getVerificationUrl(appBaseUrl(), token),
      expiresHours: VERIFICATION_TOKEN_EXPIRY_HOURS,
    });
    await getEmailSender()
      .send(email, `Verify your ${productName()} email`, html, plain)
      .catch(() => undefined);
  }

  await createSession(created.userId, created.workspaceId);
  redirect("/");
}

export async function signIn(_previous: AuthState, formData: FormData): Promise<AuthState> {
  const email = text(formData, "email").toLowerCase();
  const password = String(formData.get("password") ?? "");

  if (!email || !password) return { error: "Enter your email and password." };

  // Checked before the lookup and before any hashing: the point of the limit is
  // that a spent address never reaches the expensive path, so it cannot be used
  // to spend CPU either.
  const bucket = signInKey(await clientAddress());
  const allowed = await gate(bucket);
  if (!allowed.allowed) return { error: waitMessage(allowed.retryAfterMinutes) };

  const user = await db.user.findUnique({
    where: { email },
    include: { memberships: { orderBy: { createdAt: "asc" }, take: 1 } },
  });

  const ok = await verifyPassword(password, user?.passwordHash ?? (await getDummyDigest()));
  if (!user || !ok) {
    const spent = await tally(bucket, MAX_SIGNIN_FAILURES);
    if (spent >= MAX_SIGNIN_FAILURES) {
      return { error: `That was ${MAX_SIGNIN_FAILURES} failed attempts. ${waitMessage(15)}` };
    }
    // One message for both cases on purpose: "no such account" would turn the
    // login form into a way to enumerate your customers.
    return { error: "Email or password is incorrect." };
  }

  // Right password, so the address's history of failing it is dropped: whoever
  // types it next is not the person who guessed.
  await clearTally(bucket);

  if (!user.emailVerified && verificationEnforced()) {
    return { error: "Please verify your email before signing in. Check your inbox for the verification link.", field: "email" };
  }

  const membership = user.memberships[0];
  if (!membership) return { error: "This account has no workspace yet. Contact support." };

  await createSession(user.id, membership.workspaceId);
  redirect("/");
}

export async function signOut(): Promise<void> {
  await destroySession();
  redirect("/login");
}
