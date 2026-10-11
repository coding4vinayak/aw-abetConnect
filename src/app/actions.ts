"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { buildContextForThread } from "@/lib/ingest";
import { getEngine } from "@/lib/intelligence";
import { bucketForScore } from "@/lib/intelligence/engine";
import { toThreadDetail, type ThreadDetail } from "@/lib/serialize";
import { requireSession } from "@/lib/session";
import type { TriageResult } from "@/lib/types";
import { dispatch } from "@/lib/webhooks";

/**
 * Server actions for the dashboard.
 *
 * The dashboard talks to the database directly rather than to its own REST API,
 * so no API key is ever shipped to the browser. The REST API exists for other
 * systems, not for this UI.
 */

const THREAD_INCLUDE = {
  contact: true,
  signals: { orderBy: { weight: "desc" as const } },
  messages: { orderBy: { sentAt: "asc" as const } },
  drafts: { orderBy: { createdAt: "desc" as const } },
  _count: { select: { messages: true } },
};

async function requireWorkspaceId(): Promise<string> {
  // Every dashboard action resolves its scope from the session, so there is no
  // code path left that could be made to touch a workspace the signed-in user
  // does not belong to. Unsigned visitors are redirected to /login.
  const session = await requireSession();
  return session.workspaceId;
}

export async function loadThread(threadId: string): Promise<ThreadDetail | null> {
  const workspaceId = await requireWorkspaceId();
  const thread = await db.thread.findFirst({
    where: { id: threadId, workspaceId },
    include: THREAD_INCLUDE,
  });
  return thread ? toThreadDetail(thread) : null;
}

export async function regenerateDraft(threadId: string): Promise<ThreadDetail | null> {
  const workspaceId = await requireWorkspaceId();
  const thread = await db.thread.findFirst({
    where: { id: threadId, workspaceId },
    include: { signals: true },
  });
  if (!thread) return null;

  const context = await buildContextForThread(threadId);
  if (!context) return loadThread(threadId);

  const triage: TriageResult = {
    score: thread.score,
    bucket: thread.bucket as TriageResult["bucket"],
    intent: (thread.intent ?? "INTRO") as TriageResult["intent"],
    reason: thread.scoreReason ?? "",
    signals: thread.signals.map((s) => ({
      kind: s.kind as TriageResult["signals"][number]["kind"],
      label: s.label,
      weight: s.weight,
      evidence: s.evidence ?? undefined,
    })),
    engine: thread.scoredBy ?? "unknown",
    estimatedValueCents: thread.estimatedValueCents ?? undefined,
    currency: thread.currency ?? undefined,
  };

  const generated = await getEngine().draft(context, triage);

  await db.draft.updateMany({
    where: { threadId, status: { in: ["SUGGESTED", "EDITED"] } },
    data: { status: "DISCARDED" },
  });
  await db.draft.create({
    data: {
      threadId,
      body: generated.body,
      generatedBy: generated.engine,
      intent: generated.intent,
    },
  });

  revalidatePath("/");
  return loadThread(threadId);
}

export async function sendReply(
  threadId: string,
  body: string,
): Promise<ThreadDetail | null> {
  const workspaceId = await requireWorkspaceId();
  const text = body.trim();
  if (!text) throw new Error("Cannot send an empty reply.");

  const thread = await db.thread.findFirst({
    where: { id: threadId, workspaceId },
    include: { contact: true },
  });
  if (!thread) return null;

  const sentAt = new Date();
  const message = await db.message.create({
    data: {
      threadId,
      direction: "OUTBOUND",
      channel: thread.channel,
      body: text,
      sentAt,
    },
  });

  const pending = await db.draft.findFirst({
    where: { threadId, status: { in: ["SUGGESTED", "EDITED"] } },
    orderBy: { createdAt: "desc" },
  });
  if (pending) {
    await db.draft.update({
      where: { id: pending.id },
      data: { body: text, status: "SENT", sentAt },
    });
  }

  await db.thread.update({
    where: { id: threadId },
    data: { lastMessageAt: sentAt, lastOutboundAt: sentAt, awaitingReply: false },
  });

  // Actual delivery happens in whatever is subscribed to this event — this
  // product triages, it does not own your email or WhatsApp sending.
  void dispatch(workspaceId, "reply.sent", {
    threadId,
    messageId: message.id,
    channel: thread.channel,
    body: text,
    to: {
      name: thread.contact.name,
      email: thread.contact.email,
      phone: thread.contact.phone,
    },
    subject: thread.subject,
  });

  revalidatePath("/");
  return loadThread(threadId);
}

export async function saveDraft(threadId: string, body: string): Promise<void> {
  const workspaceId = await requireWorkspaceId();
  const thread = await db.thread.findFirst({ where: { id: threadId, workspaceId } });
  if (!thread) return;

  const current = await db.draft.findFirst({
    where: { threadId, status: { in: ["SUGGESTED", "EDITED"] } },
    orderBy: { createdAt: "desc" },
  });

  if (current) {
    await db.draft.update({ where: { id: current.id }, data: { body, status: "EDITED" } });
  } else {
    await db.draft.create({
      data: { threadId, body, generatedBy: "human", intent: thread.intent, status: "EDITED" },
    });
  }
}

export async function setThreadStatus(
  threadId: string,
  status: "OPEN" | "SNOOZED" | "WON" | "LOST" | "CLOSED",
): Promise<ThreadDetail | null> {
  const workspaceId = await requireWorkspaceId();
  const thread = await db.thread.findFirst({ where: { id: threadId, workspaceId } });
  if (!thread) return null;

  await db.thread.update({
    where: { id: threadId },
    data: {
      status,
      awaitingReply: status === "OPEN" ? thread.awaitingReply : false,
      snoozedUntil:
        status === "SNOOZED" ? new Date(Date.now() + 3 * 24 * 60 * 60 * 1000) : null,
    },
  });

  revalidatePath("/");
  return loadThread(threadId);
}

/** Human override. A ranking a rep cannot correct is a ranking they abandon. */
export async function overrideScore(
  threadId: string,
  score: number,
): Promise<ThreadDetail | null> {
  const workspaceId = await requireWorkspaceId();
  const thread = await db.thread.findFirst({ where: { id: threadId, workspaceId } });
  if (!thread) return null;

  const clamped = Math.max(0, Math.min(100, Math.round(score)));
  await db.thread.update({
    where: { id: threadId },
    data: {
      score: clamped,
      bucket: bucketForScore(clamped),
      scoreReason: "Set manually by a human",
      scoredBy: "manual",
      scoredAt: new Date(),
    },
  });

  revalidatePath("/");
  return loadThread(threadId);
}
