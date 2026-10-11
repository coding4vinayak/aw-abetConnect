import { NextResponse } from "next/server";
import { authenticate } from "@/lib/auth";
import { apiError, handleRouteError, readBody } from "@/lib/api";
import { db } from "@/lib/db";
import { toThreadDetail } from "@/lib/serialize";

const THREAD_INCLUDE = {
  contact: true,
  signals: { orderBy: { weight: "desc" as const } },
  messages: { orderBy: { sentAt: "asc" as const } },
  drafts: { orderBy: { createdAt: "desc" as const } },
  _count: { select: { messages: true } },
};

/** GET /api/v1/threads/{id} — full conversation, signals and current draft. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const workspace = await authenticate(request);
    const { id } = await params;

    const thread = await db.thread.findFirst({
      where: { id, workspaceId: workspace.id },
      include: THREAD_INCLUDE,
    });
    if (!thread) return apiError("not_found", 404, "Thread not found");

    return NextResponse.json({ thread: toThreadDetail(thread) });
  } catch (error) {
    return handleRouteError(error);
  }
}

const ALLOWED_STATUSES = ["OPEN", "SNOOZED", "WON", "LOST", "CLOSED"];

/**
 * PATCH /api/v1/threads/{id}
 *
 * Triage actions: change status, snooze, or override the score. The override
 * matters — a rep who cannot correct the ranking stops trusting it.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const workspace = await authenticate(request);
    const { id } = await params;
    const body = await readBody(request);

    const existing = await db.thread.findFirst({
      where: { id, workspaceId: workspace.id },
    });
    if (!existing) return apiError("not_found", 404, "Thread not found");

    const data: Record<string, unknown> = {};

    if (body.status !== undefined) {
      const status = String(body.status).toUpperCase();
      if (!ALLOWED_STATUSES.includes(status)) {
        return apiError("invalid_request", 422, `'status' must be one of: ${ALLOWED_STATUSES.join(", ")}`, {
          param: "status",
        });
      }
      data.status = status;
      if (status !== "SNOOZED") data.snoozedUntil = null;
      // Anything other than OPEN is off the queue, so it is no longer waiting.
      if (status !== "OPEN") data.awaitingReply = false;
    }

    if (body.snoozedUntil !== undefined) {
      const until = new Date(String(body.snoozedUntil));
      if (Number.isNaN(until.getTime())) {
        return apiError("invalid_request", 422, "'snoozedUntil' must be an ISO date", {
          param: "snoozedUntil",
        });
      }
      data.snoozedUntil = until;
      data.status = "SNOOZED";
      data.awaitingReply = false;
    }

    if (body.score !== undefined) {
      const score = Number(body.score);
      if (!Number.isFinite(score) || score < 0 || score > 100) {
        return apiError("invalid_request", 422, "'score' must be a number between 0 and 100", {
          param: "score",
        });
      }
      const { bucketForScore } = await import("@/lib/intelligence/engine");
      data.score = Math.round(score);
      data.bucket = bucketForScore(Math.round(score));
      data.scoreReason = String(body.reason ?? "Manually set by a human");
      data.scoredBy = "manual";
      data.scoredAt = new Date();
    }

    if (Object.keys(data).length === 0) {
      return apiError("invalid_request", 422, "Nothing to update. Send status, snoozedUntil or score.");
    }

    const updated = await db.thread.update({
      where: { id },
      data,
      include: THREAD_INCLUDE,
    });

    return NextResponse.json({ thread: toThreadDetail(updated) });
  } catch (error) {
    return handleRouteError(error);
  }
}
