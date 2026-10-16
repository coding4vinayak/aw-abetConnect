import type { Prisma } from "@/generated/prisma/client";

/**
 * Keyset ("cursor") pagination for the ranked queue.
 *
 * The queue is ordered by opinion, not by insertion: awaiting-reply first, then
 * score, then recency. That ordering is what makes paging hard and what makes the
 * naive answer wrong.
 *
 * Offset paging (`skip=50`) is the tempting one, and it is broken here rather than
 * merely unfashionable: score and awaitingReply change while a human is reading
 * page 1, so the rows shift under the offset. They see thread #51 twice or never
 * see #50 at all. A keyset cursor encodes *where the last page ended* in the
 * ordering itself, so a re-rank in the middle of a walk cannot hide or repeat a
 * thread that has not been reached yet.
 *
 * The cursor is opaque on purpose. Its shape is ours to change; the promise to the
 * caller is only that a cursor from a previous page continues that page's walk.
 */
export interface ThreadCursor {
  /** awaitingReply of the last row on the previous page. */
  awaitingReply: boolean;
  score: number;
  lastMessageAt: Date;
  /** Tiebreak, so two threads with an identical ranking cannot straddle a page edge. */
  id: string;
}

/** The ordering, mirrored from the query. Kept here so the two cannot drift. */
export const THREAD_ORDER: Prisma.ThreadOrderByWithRelationInput[] = [
  { awaitingReply: "desc" },
  { score: "desc" },
  { lastMessageAt: "desc" },
  { id: "desc" },
];

export function encodeThreadCursor(row: {
  awaitingReply: boolean;
  score: number;
  lastMessageAt: Date;
  id: string;
}): string {
  const payload = {
    a: row.awaitingReply ? 1 : 0,
    s: row.score,
    t: row.lastMessageAt.toISOString(),
    i: row.id,
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/**
 * Decode a cursor. Throws on anything we cannot honour — a truncated string, a
 * payload from a different sort, a date that will not parse. The route turns this
 * into a 422 `invalid_cursor` rather than silently restarting from page 1: a
 * caller who pages forever through the same first 50 threads blames their own loop,
 * and that is exactly the bug that hides.
 */
export function decodeThreadCursor(raw: string): ThreadCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw new CursorError("cursor is not a valid cursor");
  }
  const c = parsed as Partial<Record<"a" | "s" | "t" | "i", unknown>>;
  const valid =
    typeof c === "object" &&
    c !== null &&
    (c.a === 0 || c.a === 1) &&
    typeof c.s === "number" &&
    Number.isFinite(c.s) &&
    typeof c.t === "string" &&
    typeof c.i === "string" &&
    !Number.isNaN(new Date(c.t).getTime());
  if (!valid) throw new CursorError("cursor is malformed or from an incompatible sort");
  return {
    awaitingReply: c.a === 1,
    score: c.s as number,
    lastMessageAt: new Date(c.t as string),
    id: c.i as string,
  };
}

export class CursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CursorError";
  }
}

/**
 * "Everything strictly after this row in THREAD_ORDER", as a WHERE fragment.
 *
 * Lexicographic comparison over the sort tuple: at the first field where a row
 * differs from the cursor, the row must rank lower (every column is DESC here,
 * so lower means a smaller value).
 */
export function threadCursorAfter(cursor: ThreadCursor): Prisma.ThreadWhereInput {
  const { awaitingReply: a, score: s, lastMessageAt: t, id } = cursor;
  const sameAwaiting: Prisma.ThreadWhereInput = {
    AND: [
      { awaitingReply: a },
      {
        OR: [
          // Same bucket of awaiting-ness, worse score.
          { score: { lt: s } },
          { AND: [{ score: s }, { lastMessageAt: { lt: t } }] },
          { AND: [{ score: s }, { lastMessageAt: t }, { id: { lt: id } }] },
        ],
      },
    ],
  };
  // Nothing ranks below awaitingReply=false, so that branch only exists when the
  // cursor itself is waiting on a reply.
  return a ? { OR: [{ awaitingReply: false }, sameAwaiting] } : sameAwaiting;
}