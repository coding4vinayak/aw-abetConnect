import { db } from "./db";
import { inferSeniority, normaliseSubject } from "./channels/parse";
import { getEngine } from "./intelligence";
import type { TriageContext } from "./intelligence";
import type { NormalizedMessage, TriageResult } from "./types";
import { dispatch } from "./webhooks";
import { BUCKET_THRESHOLDS } from "./intelligence/engine";

/**
 * The ingest pipeline. One message in, one triaged thread out.
 *
 *   normalized message
 *     -> resolve contact (deduped across channels)
 *     -> stitch into an existing thread, or open a new one
 *     -> score the conversation and explain the score
 *     -> draft a reply
 *     -> emit webhooks
 *
 * Everything downstream — the UI, the API, a CRM sync — reads the result of
 * this function. Nothing else writes threads.
 */

export interface IngestOptions {
  /** Skip reply drafting. Used by bulk backfills where drafts are noise. */
  skipDraft?: boolean;
  /**
   * Append to a specific thread instead of resolving one from the sender.
   *
   * Required for outbound messages: the sender of our own reply is us, so
   * resolving a contact from the `from` address would create a contact and a
   * thread for our own sales inbox.
   */
  threadId?: string;
}

export interface IngestResult {
  threadId: string;
  messageId: string;
  contactId: string;
  triage: TriageResult;
  draftId?: string;
  /** True when the provider replayed a message we already had. */
  duplicate: boolean;
}

/**
 * Find the person behind this message, across channels.
 *
 * Email is the strongest identifier, phone the next. Getting this right is what
 * turns six channels into one inbox instead of six inboxes in one window.
 */
async function resolveContact(workspaceId: string, message: NormalizedMessage) {
  const { email, phone, name, company, title } = message.contact;
  const seniority = inferSeniority(title);

  if (email) {
    return db.contact.upsert({
      where: { workspaceId_email: { workspaceId, email } },
      create: {
        workspaceId,
        email,
        phone,
        name,
        company,
        title,
        seniority,
      },
      // Only fill gaps. A later message with a missing name must not erase a
      // name we already learned from an earlier one.
      update: {
        phone: phone ?? undefined,
        name: name ?? undefined,
        company: company ?? undefined,
        title: title ?? undefined,
        seniority: title ? seniority : undefined,
      },
    });
  }

  if (phone) {
    const existing = await db.contact.findFirst({ where: { workspaceId, phone } });
    if (existing) {
      return db.contact.update({
        where: { id: existing.id },
        data: {
          name: existing.name ?? name,
          company: existing.company ?? company,
          title: existing.title ?? title,
          seniority: existing.title ? undefined : title ? seniority : undefined,
        },
      });
    }
  }

  return db.contact.create({
    data: { workspaceId, email, phone, name, company, title, seniority },
  });
}

/**
 * Decide whether this message continues an existing conversation.
 *
 * Rules, in order of confidence:
 *  1. Same provider conversation reference (Slack thread_ts, phone number).
 *  2. Same contact, same normalised subject (email Re: chains).
 *  3. Same contact, an open thread touched in the last 14 days — this is what
 *     merges "emailed on Monday, WhatsApped on Wednesday" into one thread.
 */
const CROSS_CHANNEL_WINDOW_DAYS = 14;

async function findExistingThread(
  workspaceId: string,
  contactId: string,
  message: NormalizedMessage,
) {
  const openStatuses = ["OPEN", "SNOOZED"];

  if (message.conversationRef) {
    const byRef = await db.thread.findFirst({
      where: {
        workspaceId,
        contactId,
        status: { in: openStatuses },
        messages: { some: { externalId: message.conversationRef } },
      },
      orderBy: { lastMessageAt: "desc" },
    });
    if (byRef) return byRef;
  }

  const normalised = normaliseSubject(message.subject);
  if (normalised) {
    const candidates = await db.thread.findMany({
      where: { workspaceId, contactId, status: { in: openStatuses } },
      orderBy: { lastMessageAt: "desc" },
      take: 25,
    });
    const bySubject = candidates.find((t) => normaliseSubject(t.subject) === normalised);
    if (bySubject) return bySubject;
  }

  const cutoff = new Date(Date.now() - CROSS_CHANNEL_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  return db.thread.findFirst({
    where: {
      workspaceId,
      contactId,
      status: { in: openStatuses },
      lastMessageAt: { gte: cutoff },
    },
    orderBy: { lastMessageAt: "desc" },
  });
}

function mergeChannels(existing: string, channel: string): string {
  const set = new Set(existing.split(",").map((c) => c.trim()).filter(Boolean));
  set.add(channel);
  return [...set].join(",");
}

export async function ingestMessage(
  workspace: { id: string; name: string; sellsWhat?: string | null },
  message: NormalizedMessage,
  options: IngestOptions = {},
): Promise<IngestResult> {
  // An explicit thread wins over sender-based resolution.
  const pinned = options.threadId
    ? await db.thread.findFirst({
        where: { id: options.threadId, workspaceId: workspace.id },
        include: { contact: true },
      })
    : null;

  if (options.threadId && !pinned) {
    throw new Error(`Thread ${options.threadId} not found in this workspace`);
  }

  if (!pinned && message.direction === "OUTBOUND") {
    throw new Error(
      "Outbound messages need a threadId — otherwise the sender would be resolved as the contact.",
    );
  }

  const contact = pinned ? pinned.contact : await resolveContact(workspace.id, message);
  const existing = pinned ?? (await findExistingThread(workspace.id, contact.id, message));
  const isNewThread = !existing;

  // Idempotency: providers retry webhooks, and a replayed message must not
  // double-count engagement signals or re-inflate the score.
  if (existing && message.externalId) {
    const seen = await db.message.findUnique({
      where: { threadId_externalId: { threadId: existing.id, externalId: message.externalId } },
    });
    if (seen) {
      return {
        threadId: existing.id,
        messageId: seen.id,
        contactId: contact.id,
        duplicate: true,
        triage: {
          score: existing.score,
          bucket: existing.bucket as TriageResult["bucket"],
          intent: (existing.intent ?? "INTRO") as TriageResult["intent"],
          reason: existing.scoreReason ?? "",
          signals: [],
          engine: existing.scoredBy ?? "cached",
          estimatedValueCents: existing.estimatedValueCents ?? undefined,
          currency: existing.currency ?? undefined,
        },
      };
    }
  }

  const thread = existing
    ? existing
    : await db.thread.create({
        data: {
          workspaceId: workspace.id,
          contactId: contact.id,
          subject: message.subject ?? null,
          channel: message.channel,
          channels: message.channel,
          lastMessageAt: message.sentAt,
          lastInboundAt: message.direction === "INBOUND" ? message.sentAt : null,
          lastOutboundAt: message.direction === "OUTBOUND" ? message.sentAt : null,
          awaitingReply: message.direction === "INBOUND",
        },
      });

  const created = await db.message.create({
    data: {
      threadId: thread.id,
      direction: message.direction,
      channel: message.channel,
      body: message.body,
      externalId: message.externalId ?? null,
      raw: message.raw ? JSON.stringify(message.raw).slice(0, 20_000) : null,
      sentAt: message.sentAt,
    },
  });

  // Counts include the message just stored, so the engagement signals reflect
  // the conversation as it now stands.
  const [inboundCount, outboundCount, priorMessages] = await Promise.all([
    db.message.count({ where: { threadId: thread.id, direction: "INBOUND" } }),
    db.message.count({ where: { threadId: thread.id, direction: "OUTBOUND" } }),
    db.message.findMany({
      where: { threadId: thread.id },
      select: { channel: true },
      distinct: ["channel"],
    }),
  ]);

  const context: TriageContext = {
    message,
    contact: {
      name: contact.name,
      company: contact.company,
      title: contact.title,
      seniority: contact.seniority as TriageContext["contact"]["seniority"],
    },
    thread: {
      inboundCount,
      outboundCount,
      channels: priorMessages.map((m) => m.channel),
      firstMessageAt: thread.createdAt,
      lastOutboundAt: thread.lastOutboundAt,
      previousIntent: thread.intent as TriageResult["intent"] | null,
    },
    workspace: { name: workspace.name, sellsWhat: workspace.sellsWhat },
  };

  const engine = getEngine();
  const triage =
    message.direction === "INBOUND"
      ? await engine.triage(context)
      : // Our own outbound message does not get re-scored; it just means the
        // ball is no longer in our court.
        {
          score: thread.score,
          bucket: thread.bucket as TriageResult["bucket"],
          intent: (thread.intent ?? "INTRO") as TriageResult["intent"],
          reason: thread.scoreReason ?? "",
          signals: [],
          engine: thread.scoredBy ?? engine.name,
          estimatedValueCents: thread.estimatedValueCents ?? undefined,
          currency: thread.currency ?? undefined,
        };

  if (message.direction === "INBOUND") {
    // Signals are replaced wholesale rather than appended: they describe the
    // current state of the conversation, not its history.
    await db.signal.deleteMany({ where: { threadId: thread.id } });
    if (triage.signals.length > 0) {
      await db.signal.createMany({
        data: triage.signals.map((s) => ({
          threadId: thread.id,
          kind: s.kind,
          label: s.label,
          weight: s.weight,
          evidence: s.evidence ?? null,
        })),
      });
    }
  }

  const updated = await db.thread.update({
    where: { id: thread.id },
    data: {
      subject: thread.subject ?? message.subject ?? null,
      channels: mergeChannels(thread.channels, message.channel),
      score: triage.score,
      bucket: triage.bucket,
      scoreReason: triage.reason,
      intent: triage.intent,
      scoredBy: triage.engine,
      scoredAt: new Date(),
      estimatedValueCents: triage.estimatedValueCents ?? thread.estimatedValueCents,
      currency: triage.currency ?? thread.currency,
      lastMessageAt: message.sentAt,
      lastInboundAt:
        message.direction === "INBOUND" ? message.sentAt : thread.lastInboundAt,
      lastOutboundAt:
        message.direction === "OUTBOUND" ? message.sentAt : thread.lastOutboundAt,
      awaitingReply: message.direction === "INBOUND",
      // An inbound message on a snoozed thread wakes it up.
      status: message.direction === "INBOUND" && thread.status === "SNOOZED" ? "OPEN" : thread.status,
      snoozedUntil:
        message.direction === "INBOUND" && thread.status === "SNOOZED" ? null : thread.snoozedUntil,
    },
  });

  let draftId: string | undefined;
  const worthDrafting =
    !options.skipDraft && message.direction === "INBOUND" && triage.bucket !== "NOISE";

  if (worthDrafting) {
    try {
      const draft = await engine.draft(context, triage);
      // Supersede any previous unsent suggestion; a stale draft answering an
      // older message is worse than none.
      await db.draft.updateMany({
        where: { threadId: thread.id, status: "SUGGESTED" },
        data: { status: "DISCARDED" },
      });
      const record = await db.draft.create({
        data: {
          threadId: thread.id,
          body: draft.body,
          generatedBy: draft.engine,
          intent: draft.intent,
        },
      });
      draftId = record.id;
    } catch (error) {
      // A failed draft must not fail the ingest. The score is the valuable part.
      console.warn("[ingest] draft generation failed:", error);
    }
  }

  // Webhooks last, and never blocking the result.
  const payload = {
    threadId: updated.id,
    contactId: contact.id,
    channel: message.channel,
    score: updated.score,
    bucket: updated.bucket,
    intent: updated.intent,
    reason: updated.scoreReason,
    subject: updated.subject,
    contact: {
      name: contact.name,
      email: contact.email,
      phone: contact.phone,
      company: contact.company,
    },
  };

  if (isNewThread) void dispatch(workspace.id, "thread.created", payload);
  if (message.direction === "INBOUND") {
    void dispatch(workspace.id, "thread.scored", payload);
    if (updated.score >= BUCKET_THRESHOLDS.HOT) {
      void dispatch(workspace.id, "thread.hot", payload);
    }
    if (updated.intent === "CHURN_RISK") {
      void dispatch(workspace.id, "thread.at_risk", payload);
    }
  }
  if (draftId) void dispatch(workspace.id, "draft.created", { ...payload, draftId });

  return {
    threadId: updated.id,
    messageId: created.id,
    contactId: contact.id,
    triage,
    draftId,
    duplicate: false,
  };
}

/** Rebuild the triage context for a thread that already exists, so a draft can
 *  be regenerated on demand without re-ingesting anything. */
export async function buildContextForThread(threadId: string): Promise<TriageContext | undefined> {
  const thread = await db.thread.findUnique({
    where: { id: threadId },
    include: {
      contact: true,
      workspace: true,
      messages: { orderBy: { sentAt: "desc" }, take: 50 },
    },
  });
  if (!thread) return undefined;

  const lastInbound = thread.messages.find((m) => m.direction === "INBOUND");
  if (!lastInbound) return undefined;

  return {
    message: {
      channel: lastInbound.channel as NormalizedMessage["channel"],
      direction: "INBOUND",
      body: lastInbound.body,
      sentAt: lastInbound.sentAt,
      subject: thread.subject ?? undefined,
      contact: {
        name: thread.contact.name ?? undefined,
        email: thread.contact.email ?? undefined,
        phone: thread.contact.phone ?? undefined,
        company: thread.contact.company ?? undefined,
        title: thread.contact.title ?? undefined,
      },
    },
    contact: {
      name: thread.contact.name,
      company: thread.contact.company,
      title: thread.contact.title,
      seniority: thread.contact.seniority as TriageContext["contact"]["seniority"],
    },
    thread: {
      inboundCount: thread.messages.filter((m) => m.direction === "INBOUND").length,
      outboundCount: thread.messages.filter((m) => m.direction === "OUTBOUND").length,
      channels: [...new Set(thread.messages.map((m) => m.channel))],
      firstMessageAt: thread.createdAt,
      lastOutboundAt: thread.lastOutboundAt,
    },
    workspace: { name: thread.workspace.name, sellsWhat: thread.workspace.sellsWhat },
  };
}
