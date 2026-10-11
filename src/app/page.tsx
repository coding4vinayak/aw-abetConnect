import Link from "next/link";
import { signOut } from "./auth-actions";
import { db } from "@/lib/db";
import { getEngine } from "@/lib/intelligence";
import { toThreadSummary } from "@/lib/serialize";
import { requireSession } from "@/lib/session";
import { TriageQueue } from "@/components/triage-queue";

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
      </div>
    </div>
  );
}

export default async function TriagePage() {
  // Redirects to /login when there is no session, so the rest of this function
  // can assume an authenticated workspace.
  const session = await requireSession();
  const workspaceId = session.workspaceId;

  const workspace = await db.workspace.findUnique({ where: { id: workspaceId } });
  if (!workspace) return <EmptyInbox />;

  const [threads, bucketCounts] = await Promise.all([
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
  ]);

  const counts = Object.fromEntries(bucketCounts.map((c) => [c.bucket, c._count._all]));
  const hot = counts.HOT ?? 0;

  return (
    <div className="flex h-full flex-col">
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
        </div>
      </header>

      <div className="min-h-0 flex-1">
        {threads.length === 0 ? (
          <EmptyInbox />
        ) : (
          <TriageQueue
            threads={threads.map(toThreadSummary)}
            counts={counts}
            engineName={getEngine().name}
          />
        )}
      </div>
    </div>
  );
}

