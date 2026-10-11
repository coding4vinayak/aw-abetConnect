import { NextResponse } from "next/server";
import { authenticate } from "@/lib/auth";
import { apiError, handleRouteError } from "@/lib/api";
import { db } from "@/lib/db";
import {
  CursorError,
  THREAD_ORDER,
  decodeThreadCursor,
  encodeThreadCursor,
  threadCursorAfter,
  type ThreadCursor,
} from "@/lib/pagination";
import { toThreadSummary } from "@/lib/serialize";
import { BUCKETS } from "@/lib/types";

/**
 * GET /api/v1/threads
 *
 * The ranked queue. Default ordering is the product's opinion: unanswered
 * conversations first, then by score, then most recent, then id so that the order
 * is total. Sorting by time — what every normal inbox does — is exactly the
 * behaviour this replaces.
 *
 * Query: bucket, intent, status, channel, awaitingReply, minScore, q, limit, cursor
 *
 * `limit` is clamped to 1..200 (default 50). `cursor` is opaque and comes back as
 * `nextCursor`; it is null on the last page. Paging is keyset, not offset, because
 * a thread's score changes while you read — see lib/pagination.ts.
 */
export async function GET(request: Request) {
  try {
    const workspace = await authenticate(request);
    const url = new URL(request.url);
    const p = url.searchParams;

    const limit = Math.min(Math.max(Number(p.get("limit")) || 50, 1), 200);
    const bucket = p.get("bucket")?.toUpperCase();
    const status = p.get("status")?.toUpperCase();
    const intent = p.get("intent")?.toUpperCase();
    const channel = p.get("channel")?.toUpperCase();
    const minScore = Number(p.get("minScore"));
    const query = p.get("q")?.trim();
    const rawCursor = p.get("cursor");

    let cursor: ThreadCursor | null = null;
    if (rawCursor) {
      try {
        cursor = decodeThreadCursor(rawCursor);
      } catch (error) {
        if (error instanceof CursorError)
          return apiError("invalid_cursor", 422, error.message, { param: "cursor" });
        throw error;
      }
    }

    const filters: Record<string, unknown> = { workspaceId: workspace.id };

    if (bucket && (BUCKETS as readonly string[]).includes(bucket)) filters.bucket = bucket;
    if (intent) filters.intent = intent;
    // Default to open work. A queue that shows closed threads is not a queue.
    filters.status = status ?? "OPEN";
    if (channel) filters.channels = { contains: channel };
    if (Number.isFinite(minScore)) filters.score = { gte: minScore };
    if (p.get("awaitingReply") === "true") filters.awaitingReply = true;
    if (p.get("awaitingReply") === "false") filters.awaitingReply = false;

    if (query) {
      filters.OR = [
        { subject: { contains: query } },
        { contact: { is: { name: { contains: query } } } },
        { contact: { is: { email: { contains: query } } } },
        { contact: { is: { company: { contains: query } } } },
        { messages: { some: { body: { contains: query } } } },
      ];
    }

    // The cursor is composed alongside the filters rather than into them: the text
    // search needs its own OR, and a sibling OR would let a filtered page leak rows
    // that the search should have excluded.
    const where = cursor ? { AND: [filters, threadCursorAfter(cursor)] } : filters;

    const rows = await db.thread.findMany({
      where,
      orderBy: THREAD_ORDER,
      // One extra row answers "is there a next page?" without a second query.
      take: limit + 1,
      include: {
        contact: true,
        _count: { select: { messages: true } },
        messages: { orderBy: { sentAt: "desc" }, take: 1 },
      },
    });

    const hasMore = rows.length > limit;
    const threads = hasMore ? rows.slice(0, limit) : rows;
    const last = threads[threads.length - 1];

    const counts = await db.thread.groupBy({
      by: ["bucket"],
      where: { workspaceId: workspace.id, status: "OPEN" },
      _count: { _all: true },
    });

    return NextResponse.json({
      threads: threads.map(toThreadSummary),
      counts: Object.fromEntries(counts.map((c) => [c.bucket, c._count._all])),
      nextCursor: hasMore && last ? encodeThreadCursor(last) : null,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
