import { db } from "./db";
import { getSession, type ActiveSession } from "./session";

/**
 * Which workspace a request is allowed to read.
 *
 * This app had no marketing page of its own — the queue *is* the front door —
 * so the question "what does a visitor who is not signed in see?" had only one
 * answer: a login form. The other four apps in the suite answer it with a
 * public demo workspace, because a product whose demo needs credentials is a
 * product nobody evaluates.
 *
 * The rules, enforced in one place rather than trusted to each page:
 *
 * 1. The `demo` workspace is public on purpose. It is seeded with example
 *    conversations, and it is what a prospect is sent to.
 * 2. A signed-in customer gets their own workspace with no query string.
 * 3. A signed-in customer may also *look at* the demo, but nothing else.
 *    Naming someone else's slug is refused rather than served, because the
 *    alternative is a customer-to-customer data leak through a URL.
 * 4. No session and no demo: point at the sign-in form, never a redirect that
 *    loses the slug, and never the data.
 */

/** The public sample workspace's slug. Matched exactly, never by prefix. */
export const DEMO_SLUG = "demo";

const SLIM = { select: { id: true, name: true, slug: true } } as const;

export type WorkspaceResolution =
  | {
      workspace: { id: string; name: string; slug: string };
      session: ActiveSession | null;
      via: "demo" | "session" | "session-viewing-demo";
    }
  | { workspace: null; session: ActiveSession | null; reason: "signin-required"; slug: string };

/**
 * The session to resolve against.
 *
 * `undefined` means "look it up from the request" — what a page wants. `null`
 * means "there is no session" — what a check needs, because it has no cookie
 * jar and would otherwise have to fake one. The distinction matters: an
 * explicit `null` must not be mistaken for "not supplied", or the check would
 * be testing the wrong path.
 */
export type SessionOverride = ActiveSession | null | undefined;

export async function resolveWorkspace(
  requested?: string,
  sessionOverride?: SessionOverride,
): Promise<WorkspaceResolution> {
  const session = sessionOverride === undefined ? await getSession() : sessionOverride;
  const slug = requested?.trim() ? requested.trim() : undefined;

  // Rule 1: the demo is public to everyone, signed in or not. One lookup,
  // because this is the path every anonymous visitor takes.
  if (slug === DEMO_SLUG) {
    const demo = await db.workspace.findUnique({ where: { slug: DEMO_SLUG }, ...SLIM });
    if (demo) {
      return { workspace: demo, session, via: session ? "session-viewing-demo" : "demo" };
    }
    // The demo has not been seeded. A signed-in customer still gets their own
    // workspace; anyone else is sent to sign in rather than shown a blank page.
  }

  // Rule 2: no slug named — a session decides, and without one the demo is the
  // best thing this app can show.
  if (!slug) {
    if (session) {
      const own = await db.workspace.findUnique({ where: { id: session.workspaceId }, ...SLIM });
      if (own) return { workspace: own, session, via: "session" };
    }
    const demo = await db.workspace.findUnique({ where: { slug: DEMO_SLUG }, ...SLIM });
    if (demo) return { workspace: demo, session: null, via: "demo" };
    return { workspace: null, session, reason: "signin-required", slug: "" };
  }

  // Rule 3: a slug was named. The only one that may be served is the caller's
  // own — matched by id, not by slug equality, so a renamed workspace cannot
  // turn a stale link into someone else's data.
  if (session) {
    const own = await db.workspace.findUnique({ where: { id: session.workspaceId }, ...SLIM });
    if (own && own.slug === slug) return { workspace: own, session, via: "session" };
  }

  // Anything else — a foreign slug, or an anonymous visitor naming one — is
  // refused. A non-existent slug lands here too, deliberately: telling a
  // signed-out visitor which slugs exist is a free enumeration oracle.
  return { workspace: null, session, reason: "signin-required", slug };
}
