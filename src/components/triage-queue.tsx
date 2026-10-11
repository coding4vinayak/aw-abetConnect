"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { loadThread } from "@/app/actions";
import { formatMoney, type ThreadDetail, type ThreadSummary } from "@/lib/serialize";
import { EmptyDetail, ThreadDetailPane } from "./thread-detail";
import {
  bucketStyle,
  ChannelChip,
  intentLabel,
  relativeTime,
  ScoreBadge,
} from "./visuals";

const BUCKET_TABS = ["ALL", "HOT", "WARM", "NURTURE", "NOISE"] as const;
type BucketTab = (typeof BUCKET_TABS)[number];

function QueueRow({
  thread,
  selected,
  onSelect,
}: {
  thread: ThreadSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  const style = bucketStyle(thread.bucket);
  const value = formatMoney(thread.estimatedValueCents, thread.currency);

  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full border-b border-line px-3.5 py-3 text-left transition ${
        selected ? "bg-surface-raised" : "hover:bg-surface"
      }`}
    >
      <div className="flex gap-3">
        <ScoreBadge score={thread.score} bucket={thread.bucket} />

        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className="flex min-w-0 items-center gap-1.5">
              {thread.awaitingReply && (
                <span
                  title="Waiting on you"
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${style.dot}`}
                />
              )}
              <span className="truncate text-[13px] font-semibold text-foreground">
                {thread.contact.name ??
                  thread.contact.email ??
                  thread.contact.phone ??
                  "Unknown"}
              </span>
              {thread.contact.company && (
                <span className="shrink-0 truncate text-[12px] text-muted-dim">
                  · {thread.contact.company}
                </span>
              )}
            </span>
            <span className="shrink-0 text-[11px] text-muted-dim">
              {relativeTime(thread.lastMessageAt)}
            </span>
          </div>

          <p className="mt-0.5 truncate text-[12px] text-muted">
            {thread.subject ?? thread.preview ?? ""}
          </p>

          <p className={`mt-1 truncate text-[11px] ${style.text}`}>{thread.scoreReason}</p>

          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {thread.channels.map((c) => (
              <ChannelChip key={c} channel={c} />
            ))}
            {thread.channels.length > 1 && (
              <span className="text-[10px] text-[var(--warm)]">multi-channel</span>
            )}
            {value && <span className="text-[10px] text-[var(--positive)]">{value}</span>}
            <span className="text-[10px] text-muted-dim">
              {intentLabel(thread.intent)}
            </span>
          </div>
        </div>
      </div>
    </button>
  );
}

export function TriageQueue({
  threads,
  counts,
  engineName,
}: {
  threads: ThreadSummary[];
  counts: Record<string, number>;
  engineName: string;
}) {
  const [tab, setTab] = useState<BucketTab>("ALL");
  const [query, setQuery] = useState("");
  const [requestedId, setRequestedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ThreadDetail | null>(null);
  const [loading, startLoading] = useTransition();
  // Local overrides so acting on a thread updates the list without a full reload.
  const [overrides, setOverrides] = useState<Record<string, Partial<ThreadSummary>>>({});

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return threads
      .map((t) => ({ ...t, ...overrides[t.id] }))
      .filter((t) => {
        if (tab !== "ALL" && t.bucket !== tab) return false;
        if (t.status !== "OPEN") return false;
        if (!q) return true;
        return [
          t.contact.name,
          t.contact.email,
          t.contact.company,
          t.subject,
          t.preview,
        ]
          .filter(Boolean)
          .some((field) => String(field).toLowerCase().includes(q));
      });
  }, [threads, overrides, tab, query]);

  // Selection is derived, not stored. Filtering or acting on a thread can make
  // the requested id disappear from the list, and falling back to the top of
  // the queue during render avoids a second render pass to correct it.
  const selectedId =
    requestedId && visible.some((t) => t.id === requestedId)
      ? requestedId
      : (visible[0]?.id ?? null);

  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    startLoading(async () => {
      const loaded = await loadThread(selectedId);
      // Guard against a slow response for a thread the user has moved on from.
      if (!cancelled) setDetail(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  const handleChanged = (updated: ThreadDetail) => {
    setDetail(updated);
    setOverrides((prev) => ({
      ...prev,
      [updated.id]: {
        score: updated.score,
        bucket: updated.bucket,
        status: updated.status,
        scoreReason: updated.scoreReason,
        awaitingReply: updated.awaitingReply,
        lastMessageAt: updated.lastMessageAt,
      },
    }));
  };

  const awaiting = visible.filter((t) => t.awaitingReply).length;
  // Only show detail that belongs to the current selection, so a stale pane
  // never sits next to a different highlighted row.
  const shown = detail && detail.id === selectedId ? detail : null;

  return (
    <div className="flex h-full min-h-0">
      {/* Queue ------------------------------------------------------- */}
      <section className="flex w-[380px] shrink-0 flex-col border-r border-line">
        <div className="shrink-0 border-b border-line px-3.5 py-3">
          <div className="flex items-baseline justify-between">
            <h1 className="text-[13px] font-semibold tracking-tight text-foreground">
              Triage queue
            </h1>
            <span className="font-mono text-[11px] text-muted-dim">
              {awaiting} waiting on you
            </span>
          </div>

          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name, company, subject…"
            className="mt-2.5 w-full rounded-md border border-line bg-background px-2.5 py-1.5 text-[12px] text-foreground outline-none transition placeholder:text-muted-dim focus:border-[color-mix(in_srgb,var(--nurture)_45%,transparent)]"
          />

          <div className="mt-2.5 flex gap-1">
            {BUCKET_TABS.map((t) => {
              const count = t === "ALL" ? undefined : (counts[t] ?? 0);
              const active = tab === t;
              return (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTab(t)}
                  className={`rounded-md px-2 py-1 text-[11px] font-medium transition ${
                    active
                      ? "bg-surface-raised text-foreground"
                      : "text-muted-dim hover:text-muted"
                  }`}
                >
                  {t === "ALL" ? "All" : bucketStyle(t).label}
                  {count !== undefined && count > 0 && (
                    <span className="ml-1 font-mono text-[10px] text-muted-dim">
                      {count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {visible.length === 0 ? (
            <p className="px-4 py-8 text-center text-[12px] text-muted-dim">
              Nothing here. {query ? "Try a different search." : "Queue is clear."}
            </p>
          ) : (
            visible.map((thread) => (
              <QueueRow
                key={thread.id}
                thread={thread}
                selected={thread.id === selectedId}
                onSelect={() => setRequestedId(thread.id)}
              />
            ))
          )}
        </div>

        <div className="shrink-0 border-t border-line px-3.5 py-2">
          <p className="font-mono text-[10px] text-muted-dim">
            scored by {engineName}
          </p>
        </div>
      </section>

      {/* Detail ------------------------------------------------------ */}
      <section className="min-w-0 flex-1">
        {shown ? (
          // Keyed on thread and draft so the reply editor remounts with fresh
          // state instead of carrying one prospect's text over to another.
          <ThreadDetailPane
            key={`${shown.id}:${shown.draft?.id ?? "none"}`}
            thread={shown}
            onChanged={handleChanged}
          />
        ) : loading ? (
          <div className="flex h-full items-center justify-center text-[13px] text-muted-dim">
            Loading…
          </div>
        ) : (
          <EmptyDetail />
        )}
      </section>
    </div>
  );
}
