"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import {
  regenerateDraft,
  saveDraft,
  sendReply,
  setThreadStatus,
} from "@/app/actions";
import { formatMoney, type ThreadDetail } from "@/lib/serialize";
import {
  bucketStyle,
  ChannelChip,
  channelLabel,
  initials,
  intentLabel,
  intentTone,
  Pill,
  relativeTime,
  ScoreBadge,
} from "./visuals";

/** Signal kinds that argue for attention vs against it. */
const NEGATIVE_KINDS = new Set(["NOISE"]);

function SignalRow({
  signal,
}: {
  signal: ThreadDetail["signals"][number];
}) {
  const negative = signal.weight < 0 || NEGATIVE_KINDS.has(signal.kind);
  return (
    <li className="flex items-start gap-2.5 py-1.5">
      <span
        className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${
          negative ? "bg-[var(--noise)]" : "bg-[var(--positive)]"
        }`}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[13px] text-foreground">{signal.label}</span>
          <span
            className={`shrink-0 font-mono text-[11px] tabular-nums ${
              negative ? "text-[var(--noise)]" : "text-[var(--positive)]"
            }`}
          >
            {signal.weight > 0 ? `+${signal.weight}` : signal.weight}
          </span>
        </div>
        {signal.evidence && (
          <p className="mt-0.5 truncate font-mono text-[11px] text-muted-dim">
            “{signal.evidence}”
          </p>
        )}
      </div>
    </li>
  );
}

function MessageBubble({
  message,
}: {
  message: ThreadDetail["messages"][number];
}) {
  const inbound = message.direction === "INBOUND";
  return (
    <div className={`flex ${inbound ? "justify-start" : "justify-end"}`}>
      <div className={`max-w-[85%] ${inbound ? "" : "text-right"}`}>
        <div className="mb-1 flex items-center gap-1.5 text-[11px] text-muted-dim">
          {inbound ? null : <span>You</span>}
          <ChannelChip channel={message.channel} />
          <span>{relativeTime(message.sentAt)}</span>
        </div>
        <div
          className={`whitespace-pre-wrap rounded-xl border px-3.5 py-2.5 text-left text-[13px] leading-relaxed ${
            inbound
              ? "border-line bg-surface-raised text-foreground"
              : "border-[color-mix(in_srgb,var(--nurture)_25%,transparent)] bg-[color-mix(in_srgb,var(--nurture)_10%,transparent)] text-foreground"
          }`}
        >
          {message.body}
        </div>
      </div>
    </div>
  );
}

export function ThreadDetailPane({
  thread,
  onChanged,
}: {
  thread: ThreadDetail;
  onChanged: (updated: ThreadDetail) => void;
}) {
  // This component is mounted with a key of thread id + draft id, so all of
  // this state is naturally per-thread. Switching threads remounts rather than
  // resetting, which removes any chance of one prospect's draft being sent to
  // another.
  const [replyText, setReplyText] = useState(thread.draft?.body ?? "");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const style = bucketStyle(thread.bucket);

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight });
  }, [thread.id, thread.messages.length]);

  // Persist edits so a refresh does not lose work, without a save button.
  useEffect(() => {
    if (!replyText.trim() || replyText === thread.draft?.body) return;
    const handle = setTimeout(() => {
      void saveDraft(thread.id, replyText).then(() => setSavedAt(Date.now()));
    }, 1200);
    return () => clearTimeout(handle);
  }, [replyText, thread.id, thread.draft?.body]);

  const run = (work: () => Promise<ThreadDetail | null>) => {
    setError(null);
    startTransition(async () => {
      try {
        const updated = await work();
        if (updated) onChanged(updated);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Something went wrong");
      }
    });
  };

  const value = formatMoney(thread.estimatedValueCents, thread.currency);
  const positiveSignals = thread.signals.filter((s) => s.weight > 0);
  const negativeSignals = thread.signals.filter((s) => s.weight < 0);

  return (
    <div className="flex h-full min-w-0 flex-col">
      {/* Header ------------------------------------------------------- */}
      <header className="shrink-0 border-b border-line px-5 py-4">
        <div className="flex items-start gap-3.5">
          <ScoreBadge score={thread.score} bucket={thread.bucket} size="lg" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-[15px] font-semibold text-foreground">
                {thread.contact.name ??
                  thread.contact.email ??
                  thread.contact.phone ??
                  "Unknown sender"}
              </h2>
              {thread.contact.company && (
                <span className="text-[13px] text-muted">{thread.contact.company}</span>
              )}
              <Pill tone={intentTone(thread.intent)}>{intentLabel(thread.intent)}</Pill>
              {value && <Pill tone="positive">{value}</Pill>}
            </div>
            <p className="mt-1 truncate text-[13px] text-muted">
              {thread.subject ?? "(no subject)"}
            </p>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-dim">
              {thread.contact.title && <span>{thread.contact.title}</span>}
              {thread.contact.email && <span>{thread.contact.email}</span>}
              {thread.contact.phone && <span>{thread.contact.phone}</span>}
              <span className="flex items-center gap-1">
                {thread.channels.map((c) => (
                  <ChannelChip key={c} channel={c} />
                ))}
              </span>
            </div>
          </div>
        </div>

        <p className={`mt-3 text-[13px] ${style.text}`}>{thread.scoreReason}</p>

        <div className="mt-3 flex flex-wrap gap-1.5">
          <button
            type="button"
            disabled={pending}
            onClick={() => run(() => setThreadStatus(thread.id, "WON"))}
            className="rounded-md border border-[color-mix(in_srgb,var(--positive)_35%,transparent)] px-2.5 py-1 text-[12px] text-[var(--positive)] transition hover:bg-[color-mix(in_srgb,var(--positive)_12%,transparent)] disabled:opacity-40"
          >
            Mark won
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => run(() => setThreadStatus(thread.id, "SNOOZED"))}
            className="rounded-md border border-line px-2.5 py-1 text-[12px] text-muted transition hover:bg-surface-raised hover:text-foreground disabled:opacity-40"
          >
            Snooze 3d
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => run(() => setThreadStatus(thread.id, "CLOSED"))}
            className="rounded-md border border-line px-2.5 py-1 text-[12px] text-muted transition hover:bg-surface-raised hover:text-foreground disabled:opacity-40"
          >
            Close
          </button>
        </div>
      </header>

      {/* Body: transcript + why ------------------------------------- */}
      <div className="flex min-h-0 flex-1">
        <div ref={transcriptRef} className="min-w-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {thread.messages.map((m) => (
            <MessageBubble key={m.id} message={m} />
          ))}
        </div>

        <aside className="hidden w-72 shrink-0 overflow-y-auto border-l border-line px-4 py-4 xl:block">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-dim">
            Why it scored {thread.score}
          </h3>
          {positiveSignals.length > 0 && (
            <ul className="mt-2 divide-y divide-line/60">
              {positiveSignals.map((s) => (
                <SignalRow key={s.id} signal={s} />
              ))}
            </ul>
          )}
          {negativeSignals.length > 0 && (
            <>
              <h4 className="mt-4 text-[11px] font-semibold uppercase tracking-wider text-muted-dim">
                Against
              </h4>
              <ul className="mt-1 divide-y divide-line/60">
                {negativeSignals.map((s) => (
                  <SignalRow key={s.id} signal={s} />
                ))}
              </ul>
            </>
          )}
          {thread.signals.length === 0 && (
            <p className="mt-2 text-[12px] text-muted-dim">
              No signals recorded for this conversation.
            </p>
          )}
        </aside>
      </div>

      {/* Reply ------------------------------------------------------- */}
      <footer className="shrink-0 border-t border-line bg-surface px-5 py-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-[11px] text-muted-dim">
            <span>
              Draft reply
              {thread.draft?.generatedBy ? ` · ${thread.draft.generatedBy}` : ""}
            </span>
            {savedAt && <span className="text-[var(--positive)]">saved</span>}
          </div>
          <button
            type="button"
            disabled={pending}
            onClick={() => run(() => regenerateDraft(thread.id))}
            className="rounded-md border border-line px-2.5 py-1 text-[12px] text-muted transition hover:bg-surface-raised hover:text-foreground disabled:opacity-40"
          >
            {pending ? "Working…" : "Rewrite"}
          </button>
        </div>

        <textarea
          value={replyText}
          onChange={(e) => setReplyText(e.target.value)}
          rows={7}
          spellCheck
          placeholder="Write a reply, or hit Rewrite to generate one."
          className="w-full resize-none rounded-lg border border-line bg-background px-3 py-2.5 text-[13px] leading-relaxed text-foreground outline-none transition placeholder:text-muted-dim focus:border-[color-mix(in_srgb,var(--nurture)_45%,transparent)]"
        />

        {error && <p className="mt-2 text-[12px] text-[var(--hot)]">{error}</p>}

        <div className="mt-2 flex items-center justify-between gap-3">
          <p className="text-[11px] text-muted-dim">
            Sending records the reply and fires the{" "}
            <code className="font-mono text-muted">reply.sent</code> webhook — your
            existing {channelLabel(thread.channel).toLowerCase()} provider delivers it.
          </p>
          <button
            type="button"
            disabled={pending || !replyText.trim()}
            onClick={() => run(() => sendReply(thread.id, replyText))}
            className="shrink-0 rounded-lg bg-foreground px-4 py-2 text-[13px] font-semibold text-background transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-30"
          >
            {pending ? "Sending…" : "Send reply"}
          </button>
        </div>
      </footer>
    </div>
  );
}

export function EmptyDetail() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
      <p className="text-[15px] font-medium text-muted">Nothing selected</p>
      <p className="max-w-sm text-[13px] text-muted-dim">
        Pick the conversation at the top of the queue. It is the one closest to
        buying, not the one that arrived most recently.
      </p>
    </div>
  );
}

export function ContactAvatar({
  name,
  email,
}: {
  name?: string | null;
  email?: string | null;
}) {
  return (
    <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-line bg-surface-raised font-mono text-[10px] font-semibold text-muted">
      {initials(name, email)}
    </span>
  );
}
