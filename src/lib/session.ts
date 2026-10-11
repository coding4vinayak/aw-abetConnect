import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { db } from "./db";

/**
 * Browser sessions.
 *
 * Two decisions worth stating, because they are the ones that are expensive to
 * change later:
 *
 * 1. The session token is stored **hashed**. The cookie holds a random 32-byte
 *    token; the database holds only its sha256. If the database is ever dumped,
 *    the attacker gets unusable hashes rather than a set of working logins.
 *    This mirrors how API keys are already handled in `auth.ts`, so there is
 *    one rule in the codebase instead of two.
 * 2. The workspace lives **on the session**, not only on the user. A person can
 *    belong to several teams (see the `Membership` model); the session records
 *    which one is currently open, so switching teams later is a column change
 *    rather than a redesign.
 */

const COOKIE_NAME = "abetconnect_session";
const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days.

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createSession(userId: string, workspaceId: string): Promise<void> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + TTL_MS);

  await db.session.create({
    data: { userId, workspaceId, tokenHash: hashSessionToken(token), expiresAt },
  });

  const jar = await cookies();
  jar.set(COOKIE_NAME, token, {
    httpOnly: true, // Unreadable from JavaScript, so an XSS bug cannot steal it.
    sameSite: "lax", // Still sent on the top-level redirect back from an email link.
    secure: process.env.NODE_ENV === "production", // Plain HTTP is only for localhost.
    path: "/",
    expires: expiresAt,
  });
}

export interface ActiveSession {
  userId: string;
  email: string;
  name: string | null;
  workspaceId: string;
  workspaceName: string;
  workspaceSlug: string;
  role: string;
}

/**
 * Resolve the session for the current request.
 *
 * Wrapped in React's `cache` so the dashboard, the header and any server action
 * in the same render share one lookup instead of re-querying per component.
 */
export const getSession = cache(async (): Promise<ActiveSession | null> => {
  const jar = await cookies();
  const token = jar.get(COOKIE_NAME)?.value;
  if (!token) return null;

  // Deliberately not `include: { user: true, workspace: true }`. Both relations
  // are required, so Prisma throws "Field user is required to return data" if
  // the row is gone — a 500 on a stale cookie, before any code here can check.
  // (Foreign keys cascade this in a correct database, but SQLite deployments
  // with foreign keys off, or a hand-restored backup, can still reach it.)
  // Loading them separately turns "impossible" into "signed out".
  const record = await db.session.findUnique({
    where: { tokenHash: hashSessionToken(token) },
  });
  if (!record) return null;

  const [user, workspace] = await Promise.all([
    db.user.findUnique({ where: { id: record.userId } }),
    db.workspace.findUnique({ where: { id: record.workspaceId } }),
  ]);
  // A cookie that cannot name a person, or a workspace, is not a session.
  if (!user || !workspace) {
    await db.session.delete({ where: { id: record.id } }).catch(() => undefined);
    return null;
  }

  if (record.expiresAt.getTime() <= Date.now()) {
    // Expired sessions are deleted on sight, so the table does not accumulate
    // rows that can never authenticate anything.
    await db.session.delete({ where: { id: record.id } }).catch(() => undefined);
    return null;
  }

  const membership = await db.membership.findUnique({
    where: { userId_workspaceId: { userId: record.userId, workspaceId: record.workspaceId } },
    select: { role: true },
  });

  // No membership means this cookie was minted in a workspace that no longer
  // admits the account — the seat was removed, or the row was edited away by hand.
  // The session is over: it is dropped rather than allowed to continue, because
  // every query downstream filters on session.workspaceId, and a default role
  // here would quietly keep a departed teammate reading the queue.
  if (!membership) {
    await db.session.delete({ where: { id: record.id } }).catch(() => undefined);
    return null;
  }

  return {
    userId: user.id,
    email: user.email,
    name: user.name,
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    workspaceSlug: workspace.slug,
    role: membership.role,
  };
});

/**
 * The session, or a redirect to the login screen.
 *
 * Every page and server action that touches a workspace goes through this, which
 * is what makes the dashboard multi-tenant: there is no longer any code path
 * that reads "the first workspace in the table".
 */
export async function requireSession(): Promise<ActiveSession> {
  const session = await getSession();
  if (!session) redirect("/login");
  return session;
}

export async function destroySession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(COOKIE_NAME)?.value;
  if (token) {
    await db.session.deleteMany({ where: { tokenHash: hashSessionToken(token) } });
  }
  jar.delete(COOKIE_NAME);
}
