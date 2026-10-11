/**
 * Shapes returned to the UI and the API. Kept in one place so a change to the
 * schema cannot silently change the public contract.
 */

export interface ThreadSummary {
  id: string;
  subject: string | null;
  channel: string;
  channels: string[];
  score: number;
  bucket: string;
  scoreReason: string | null;
  intent: string | null;
  status: string;
  awaitingReply: boolean;
  lastMessageAt: string;
  estimatedValueCents: number | null;
  currency: string | null;
  messageCount: number;
  contact: {
    id: string;
    name: string | null;
    email: string | null;
    phone: string | null;
    company: string | null;
    title: string | null;
    seniority: string | null;
  };
  preview: string | null;
}

export interface ThreadDetail extends ThreadSummary {
  signals: Array<{
    id: string;
    kind: string;
    label: string;
    weight: number;
    evidence: string | null;
  }>;
  messages: Array<{
    id: string;
    direction: string;
    channel: string;
    body: string;
    sentAt: string;
  }>;
  draft: {
    id: string;
    body: string;
    intent: string | null;
    status: string;
    generatedBy: string;
  } | null;
}

type ThreadRecord = {
  id: string;
  subject: string | null;
  channel: string;
  channels: string;
  score: number;
  bucket: string;
  scoreReason: string | null;
  intent: string | null;
  status: string;
  awaitingReply: boolean;
  lastMessageAt: Date;
  estimatedValueCents: number | null;
  currency: string | null;
  contact: {
    id: string;
    name: string | null;
    email: string | null;
    phone: string | null;
    company: string | null;
    title: string | null;
    seniority: string | null;
  };
  messages?: Array<{
    id: string;
    direction: string;
    channel: string;
    body: string;
    sentAt: Date;
  }>;
  _count?: { messages: number };
};

function splitChannels(value: string): string[] {
  return value.split(",").map((c) => c.trim()).filter(Boolean);
}

function previewOf(body?: string): string | null {
  if (!body) return null;
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length > 180 ? `${flat.slice(0, 180)}…` : flat;
}

export function toThreadSummary(thread: ThreadRecord): ThreadSummary {
  const latest = thread.messages?.[0];
  return {
    id: thread.id,
    subject: thread.subject,
    channel: thread.channel,
    channels: splitChannels(thread.channels),
    score: thread.score,
    bucket: thread.bucket,
    scoreReason: thread.scoreReason,
    intent: thread.intent,
    status: thread.status,
    awaitingReply: thread.awaitingReply,
    lastMessageAt: thread.lastMessageAt.toISOString(),
    estimatedValueCents: thread.estimatedValueCents,
    currency: thread.currency,
    messageCount: thread._count?.messages ?? thread.messages?.length ?? 0,
    contact: thread.contact,
    preview: previewOf(latest?.body),
  };
}

export function toThreadDetail(
  thread: ThreadRecord & {
    signals: Array<{
      id: string;
      kind: string;
      label: string;
      weight: number;
      evidence: string | null;
    }>;
    drafts: Array<{
      id: string;
      body: string;
      intent: string | null;
      status: string;
      generatedBy: string;
    }>;
  },
): ThreadDetail {
  const messages = [...(thread.messages ?? [])].sort(
    (a, b) => a.sentAt.getTime() - b.sentAt.getTime(),
  );
  const draft = thread.drafts.find((d) => d.status === "SUGGESTED" || d.status === "EDITED");

  return {
    ...toThreadSummary(thread),
    // Summary preview uses the newest message; detail lists them oldest first.
    preview: previewOf(messages[messages.length - 1]?.body),
    signals: thread.signals,
    messages: messages.map((m) => ({
      id: m.id,
      direction: m.direction,
      channel: m.channel,
      body: m.body,
      sentAt: m.sentAt.toISOString(),
    })),
    draft: draft
      ? {
          id: draft.id,
          body: draft.body,
          intent: draft.intent,
          status: draft.status,
          generatedBy: draft.generatedBy,
        }
      : null,
  };
}

export function formatMoney(cents: number | null, currency: string | null): string | null {
  if (cents === null || cents === undefined) return null;
  const amount = cents / 100;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency ?? "USD",
      maximumFractionDigits: amount >= 1000 ? 0 : 2,
    }).format(amount);
  } catch {
    return `${currency ?? ""}${Math.round(amount).toLocaleString()}`.trim();
  }
}
