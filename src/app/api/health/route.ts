import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { apiError } from "@/lib/api";

export const dynamic = "force-dynamic";

/**
 * GET /api/health
 *
 * Liveness for load balancers and container orchestrators: unauthenticated on
 * purpose, because a probe cannot hold an API key. It pings the database, so a
 * pass here means this instance can actually serve traffic — not just answer TCP.
 */
export async function GET() {
  try {
    await db.$queryRaw`SELECT 1`;
  } catch {
    return apiError("internal_error", 503, "Database unreachable");
  }
  return NextResponse.json({ ok: true, db: "up", time: new Date().toISOString() });
}
