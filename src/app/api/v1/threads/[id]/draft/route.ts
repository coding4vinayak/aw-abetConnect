import { NextResponse } from "next/server";
import { authenticate } from "@/lib/auth";
import { apiError, handleRouteError, readBody } from "@/lib/api";
import { db } from "@/lib/db";
import { buildContextForThread } from "@/lib/ingest";
import { getEngine } from "@/lib/intelligence";
import type { TriageResult } from "@/lib/types";

/**
 * POST /api/v1/threads/{id}/draft
 *
 * Regenerate the suggested reply. Used by the "rewrite" button, and by anyone
 * who wants drafting without the rest of the product.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const workspace = await authenticate(request);
    const { id } = await params;

    const thread = await db.thread.findFirst({
      where: { id, workspaceId: workspace.id },
      include: { signals: true },
    });
    if (!thread) return apiError("not_found", 404, "Thread not found");

    const context = await buildContextForThread(id);
    if (!context) {
      return apiError("conflict", 409, "Thread has no inbound message to reply to");
    }

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

    const engine = getEngine();
    const generated = await engine.draft(context, triage);

    await db.draft.updateMany({
      where: { threadId: id, status: { in: ["SUGGESTED", "EDITED"] } },
      data: { status: "DISCARDED" },
    });

    const draft = await db.draft.create({
      data: {
        threadId: id,
        body: generated.body,
        generatedBy: generated.engine,
        intent: generated.intent,
      },
    });

    return NextResponse.json(
      {
        draft: {
          id: draft.id,
          body: draft.body,
          intent: draft.intent,
          status: draft.status,
          generatedBy: draft.generatedBy,
        },
      },
      { status: 201 },
    );
  } catch (error) {
    return handleRouteError(error);
  }
}

/** PATCH /api/v1/threads/{id}/draft — save a rep's edits without sending. */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const workspace = await authenticate(request);
    const { id } = await params;
    const body = await readBody(request);

    if (typeof body.body !== "string" || !body.body.trim()) {
      return apiError("invalid_request", 422, "'body' is required", { param: "body" });
    }

    const thread = await db.thread.findFirst({ where: { id, workspaceId: workspace.id } });
    if (!thread) return apiError("not_found", 404, "Thread not found");

    const current = await db.draft.findFirst({
      where: { threadId: id, status: { in: ["SUGGESTED", "EDITED"] } },
      orderBy: { createdAt: "desc" },
    });

    const draft = current
      ? await db.draft.update({
          where: { id: current.id },
          data: { body: body.body, status: "EDITED" },
        })
      : await db.draft.create({
          data: {
            threadId: id,
            body: body.body,
            generatedBy: "human",
            intent: thread.intent,
            status: "EDITED",
          },
        });

    return NextResponse.json({
      draft: {
        id: draft.id,
        body: draft.body,
        intent: draft.intent,
        status: draft.status,
        generatedBy: draft.generatedBy,
      },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
