/**
 * The ingest promises — run with:  npm run check:ingest
 *
 * WHY THIS EXISTS
 *
 * The README sells two behaviours a customer can check on day one, and neither
 * had anything watching once it broke:
 *
 *   · "Ingest is idempotent on the provider's message id … A replay returns the
 *     original thread with `duplicate: true` and HTTP 200 rather than a second
 *     201." The lookup that backs that sentence only searched threads that were
 *     still OPEN or SNOOZED. Providers retry for hours, and a rep works the
 *     queue in the meantime — so a retry that landed after a thread was won,
 *     lost or closed opened a SECOND lead with `duplicate: false`, re-firing
 *     thread.created and forking a live conversation away from its history.
 *
 *   · "Scores are built from individual signals … so the numbers shown still add
 *     up to the score exactly." The score started from an invisible baseline and
 *     the 0..100 bounds and the hard-noise clamp moved it silently — adding up
 *     the panel's rows was off by +5 on an ordinary message and by more on every
 *     clamped one.
 *
 * This script builds a throwaway database on the configured Postgres from the
 * committed migrations and drives lib/ingest.ts and the scoring engine directly.
 * No running server, no credentials, and nothing left behind afterwards. Needs a
 * reachable Postgres: docker compose locally, the service container in CI.
 *
 * WHAT IT DOES NOT COVER
 *
 * It calls the library, not the wire: the route's 200-vs-201 mapping for
 * `duplicate` and the adapter payload shapes live in scripts/smoke.sh, which
 * boots a real build. The two suites meet in the middle — this one can reach
 * states a browser cannot (a provider retry against a thread that was already
 * won) with a real database under it.
 */

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import type { NormalizedMessage } from "../src/lib/types";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

let passed = 0;
const failures: string[] = [];

/** Reporting matches scripts/smoke.sh, so a run reads the same whichever suite
 *  you are looking at: one line per claim, and the count at the end. */
function ok(label: string, condition: unknown): void {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failures.push(label);
    console.log(`  FAIL  ${label}`);
  }
}

const baseUrl =
  process.env.DATABASE_URL ?? "postgresql://abetconnect:abetconnect@localhost:5432/abetconnect";
const scratchName = `check_ingest_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;

// A per-run database on the configured server, so parallel or crashed runs never
// collide and the drop at the end is the whole cleanup. CREATE DATABASE cannot run
// inside a transaction, which is why this is a plain pool and not the app client.
const server = new Pool({ connectionString: baseUrl });
await server.query(`CREATE DATABASE "${scratchName}"`);

const scratchUrl = (() => {
  const parsed = new URL(baseUrl);
  parsed.pathname = `/${scratchName}`;
  parsed.searchParams.delete("schema");
  return parsed.toString();
})();
process.env.DATABASE_URL = scratchUrl;

// Build the schema from the committed migration history rather than db push, so the
// thing under test is the schema a deploy would create.
execFileSync(path.join(ROOT, "node_modules", ".bin", "prisma"), ["migrate", "deploy"], {
  cwd: ROOT,
  env: process.env,
  stdio: "ignore",
});

const { db } = await import("../src/lib/db");
const { ingestMessage } = await import("../src/lib/ingest");

try {
  const workspace = await db.workspace.create({
    data: { name: "Ingest check", slug: `ingest-check-${Date.now()}` },
  });

  const message = (overrides: Partial<NormalizedMessage> = {}): NormalizedMessage => ({
    channel: "EMAIL",
    direction: "INBOUND",
    body: "Hi, can you send a quote for 12 seats? Please reply before Friday.",
    sentAt: new Date(),
    subject: "Quote for 12 seats",
    contact: { email: "raj@check.example", name: "Raj Patel" },
    externalId: "check-msg-1",
    ...overrides,
  });

  // ── the explanation's arithmetic, as stored (the panel reads these rows) ──
  const first = await ingestMessage(workspace, message());
  ok("a first ingest opens a thread rather than flagging a duplicate", first.duplicate === false);

  const stored = await db.thread.findUniqueOrThrow({ where: { id: first.threadId } });
  const storedRows = await db.signal.findMany({ where: { threadId: first.threadId } });
  ok(
    "the stored rows add up to the stored score",
    storedRows.reduce((sum, row) => sum + row.weight, 0) === stored.score,
  );
  ok("the baseline is one of the stored rows", storedRows.some((row) => row.kind === "BASE"));

  // ── idempotency, the way a provider actually retries ─────────────────────
  const replayOpen = await ingestMessage(workspace, message());
  ok(
    "a replay while the thread is open comes back as the original thread",
    replayOpen.duplicate === true && replayOpen.threadId === first.threadId,
  );

  await db.thread.update({ where: { id: first.threadId }, data: { status: "WON" } });

  const replayClosed = await ingestMessage(workspace, message());
  ok("a replay after the thread was won is still a replay", replayClosed.duplicate === true);
  ok("…and points at the original thread", replayClosed.threadId === first.threadId);
  ok("…without re-inflating the score", replayClosed.triage.score === stored.score);
  ok(
    "…and the provider message id exists exactly once",
    (await db.message.count({ where: { externalId: "check-msg-1" } })) === 1,
  );
  ok(
    "…and no second thread was opened",
    (await db.thread.count({ where: { workspaceId: workspace.id } })) === 1,
  );
  ok(
    "…and the closed thread stayed closed",
    (await db.thread.findUniqueOrThrow({ where: { id: first.threadId } })).status === "WON",
  );

  // The behaviour that must survive: a genuinely new message is not a replay.
  const fresh = await ingestMessage(
    workspace,
    message({
      externalId: "check-msg-2",
      subject: "Separate question about my invoice",
      body: "Separate question: where can I download the invoice for last month?",
    }),
  );
  ok(
    "a genuinely new message still opens a new conversation",
    fresh.duplicate === false && fresh.threadId !== first.threadId,
  );
  ok(
    "…so the workspace holds two threads now",
    (await db.thread.count({ where: { workspaceId: workspace.id } })) === 2,
  );

  // ── the arithmetic under a clamp, as stored ──────────────────────────────
  const floored = await ingestMessage(
    workspace,
    message({
      externalId: "check-msg-3",
      contact: { email: "auto@check.example" },
      subject: "Re: procurement",
      body:
        "This is an automated reply. I am out of office until Monday. In the " +
        "meantime: our budget is approved and we need a quote for 200 seats before Friday.",
    }),
  );
  const floorThread = await db.thread.findUniqueOrThrow({ where: { id: floored.threadId } });
  const floorRows = await db.signal.findMany({ where: { threadId: floored.threadId } });
  ok(
    "a floored score still shows rows that add up to it",
    floorThread.score === 0 &&
      floorRows.reduce((sum, row) => sum + row.weight, 0) === 0,
  );
  ok(
    "…because the floor is stored as its own row",
    floorRows.some((row) => row.kind === "ADJUSTMENT" && row.weight > 0),
  );
} catch (error) {
  // A fatal error is usually a database stack trace; collapse it to one readable
  // line so the summary at the end still reads as a list of claims.
  const message = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ");
  const brief = message.length > 220 ? `${message.slice(0, 220)}…` : message;
  if (!failures.includes(brief)) {
    failures.push(brief);
    console.log(`  FAIL  ${brief}`);
  }
}

try {
  const { db } = await import("../src/lib/db");
  await db.$disconnect();
} catch {
  // Never connected — the failure was reported above.
}
try {
  // WITH (FORCE) terminates any connection the run left behind (PostgreSQL 13+).
  await server.query(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`);
} catch {
  // The server was never reachable — there is nothing to drop.
}
try {
  await server.end();
} catch {
  // Nothing left to close.
}

console.log("");
console.log("================================");
console.log(`  ${passed} passed, ${failures.length} failed`);
console.log("================================");
console.log("  ingest idempotency and the score explanation verified against a real schema");
if (failures.length) process.exit(1);
