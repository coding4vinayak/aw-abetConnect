import Link from "next/link";
import { signOut } from "./auth-actions";
import { db } from "@/lib/db";
import { verificationEnforced } from "@/lib/email";
import { getEngine } from "@/lib/intelligence";
import { toThreadSummary } from "@/lib/serialize";
import { getSession } from "@/lib/session";
import { resolveWorkspace } from "@/lib/resolve-workspace";
import { TriageQueue } from "@/components/triage-queue";
import { ExampleInbox } from "@/components/example-inbox";
import { hasExampleInbox } from "@/lib/example-inbox";
import { VerifyBanner } from "@/components/verify-banner";

// The queue reflects a live inbox, so never serve it from the static cache.
export const dynamic = "force-dynamic";

/**
 * Shown when a workspace is real but empty — which is the state every new
 * signup starts in. The old version of this screen told the reader to run
 * `npm run seed`, which is developer advice, not customer advice.
 */
function EmptyInbox() {
  return (
    <div className="flex h-full items-center justify-center px-6">
      <div className="max-w-md">
        <h2 className="text-[13px] font-semibold text-foreground">No conversations yet</h2>
        <p className="mt-2 text-[12px] leading-relaxed text-muted">
          Your queue fills up as messages arrive. Point a channel at your ingest endpoint and
          the first inbound message appears here, scored, within seconds.
        </p>
        <Link
          href="/integrations"
          className="mt-4 inline-block rounded-md border border-line px-3 py-1.5 text-[12px] text-foreground transition hover:bg-surface-raised"
        >
          Connect a channel
        </Link>
        <ExampleInbox loaded={false} />
      </div>
    </div>
  );
}

export default async function TriagePage({
  searchParams,
}: {
  searchParams: Promise<{ workspace?: string }>;
}) {
  // One policy, shared with the other four apps: the demo workspace is public,
  // a customer's own workspace needs a session, and anything else is refused.
  // This app has no marketing page — the queue is the front door — so a
  // visitor who is not signed in is shown the demo rather than a login form.
  const requested = (await searchParams)?.workspace;
  const resolved = await resolveWorkspace(requested);
  if (!resolved.workspace) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-6">
        <div className="max-w-md text-center">
          <h1 className="text-[15px] font-semibold tracking-tight text-foreground">Sign in to see your queue</h1>
          <p className="mt-2 text-[12px] leading-relaxed text-muted">
            One inbox, every channel, ranked by who is most likely to buy. Sign in, or point a channel
            at your ingest endpoint and watch the first message appear.
          </p>
          <Link
            href="/login"
            className="mt-4 inline-block rounded-md border border-line px-3 py-1.5 text-[12px] text-foreground transition hover:bg-surface-raised"
          >
            Sign in
          </Link>
        </div>
      </div>
    );
  }
  const session = resolved.session;
  const workspaceId = resolved.workspace.id;
  const viewingDemo = resolved.via === "demo" || resolved.via === "session-viewing-demo";

  const [workspace, viewer] = await Promise.all([
    db.workspace.findUnique({ where: { id: workspaceId } }),
    // Only in the world where the click matters: a deployment with no mail
    // provider never blocks sign-in on verification, so the banner would be
    // advice nobody can act on.
    session && verificationEnforced()
      ? db.user.findUnique({ where: { id: session.userId }, select: { emailVerified: true } })
      : Promise.resolve(null),
  ]);
  if (!workspace) return <EmptyInbox />;
  const needsVerification = Boolean(viewer && !viewer.emailVerified);

  const [threads, bucketCounts, showExampleBanner] = await Promise.all([
    db.thread.findMany({
      where: { workspaceId, status: "OPEN" },
      // The product's whole opinion, in one clause: unanswered first, then by
      // how close they are to buying, and only then by recency.
      orderBy: [{ awaitingReply: "desc" }, { score: "desc" }, { lastMessageAt: "desc" }],
      take: 200,
      include: {
        contact: true,
        _count: { select: { messages: true } },
        messages: { orderBy: { sentAt: "desc" }, take: 1 },
      },
    }),
    db.thread.groupBy({
      by: ["bucket"],
      where: { workspaceId, status: "OPEN" },
      _count: { _all: true },
    }),
    // Whether what is on screen is the sample inbox, so the queue can say so
    // and offer the way out.
    hasExampleInbox(workspaceId),
  ]);

  const counts = Object.fromEntries(bucketCounts.map((c) => [c.bucket, c._count._all]));
  const hot = counts.HOT ?? 0;

  return (
    <main id="main-content" className="flex h-full flex-col">
      <header className="flex shrink-0 items-center justify-between border-b border-line px-4 py-2.5">
        <div className="flex items-baseline gap-2.5">
          <span className="text-[13px] font-semibold tracking-tight text-foreground">
            abetConnect
          </span>
          <span className="text-[11px] text-muted-dim">{workspace.name}</span>
        </div>
        <div className="flex items-center gap-3 text-[11px] text-muted-dim">
          {hot > 0 && (
            <span className="text-[var(--hot)]">
              {hot} hot {hot === 1 ? "conversation" : "conversations"}
            </span>
          )}
          {/* Team and Integrations are doors into a workspace. A visitor who is
              looking at the demo has no workspace, so the doors stay shut
              rather than bouncing them to a sign-in form. */}
          {session && (
            <>
              <Link
                href="/members"
                className="rounded-md border border-line px-2 py-1 transition hover:bg-surface-raised hover:text-foreground"
              >
                Team
              </Link>
              <Link
                href="/integrations"
                className="rounded-md border border-line px-2 py-1 transition hover:bg-surface-raised hover:text-foreground"
              >
                Integrations
              </Link>
            </>
          )}
          {session ? (
            <>
              <span className="hidden text-muted-dim sm:inline">{session.email}</span>
              {/* A plain form post: signing out should not need client JavaScript. */}
              <form action={signOut}>
                <button
                  type="submit"
                  className="rounded-md border border-line px-2 py-1 transition hover:bg-surface-raised hover:text-foreground"
                >
                  Sign out
                </button>
              </form>
            </>
          ) : (
            <Link
              href="/login"
              className="rounded-md bg-foreground px-3 py-1 text-[12px] font-medium text-background transition hover:opacity-90"
            >
              Sign in
            </Link>
          )}
        </div>
      </header>

      {needsVerification && <VerifyBanner />}

      {viewingDemo && (
        <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface-raised px-4 py-2 text-[12px] text-muted">
          <span>
            <strong className="text-foreground">This is the live demo.</strong> The conversations and
            the scores are the engine&rsquo;s own — every contact is fictional, and nothing here is
            a real message.
          </span>
          {!session && (
            <Link href="/login" className="text-foreground underline underline-offset-2">
              Sign in for your own workspace
            </Link>
          )}
        </div>
      )}

      <div className="min-h-0 flex-1">
        {threads.length === 0 ? (
          <EmptyInbox />
        ) : (
          <>
            {showExampleBanner && (
              <ExampleInbox loaded />
            )}
            <TriageQueue
              threads={threads.map(toThreadSummary)}
              counts={counts}
              engineName={getEngine().name}
            />
          </>
        )}
      </div>
    </main>
  );
}

