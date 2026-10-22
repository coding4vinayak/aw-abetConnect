/**
 * Who may see which workspace — run with:  npm run check:demo
 *
 * WHY THIS EXISTS
 *
 * abetConnect had no marketing page of its own: the queue *was* the front door,
 * so a visitor who was not signed in got a login form and nothing else. The
 * other four apps in the suite answer that question with a public demo
 * workspace, because a product whose demo needs credentials is a product
 * nobody evaluates.
 *
 * Making the demo public is only safe if the *rest* of the rule stays shut: a
 * signed-out visitor may see the demo and nothing else, and naming someone
 * else's workspace must be refused rather than served. Both halves are easy to
 * get wrong and impossible to eyeball, so this script drives them against a
 * throwaway database built from the committed migrations.
 *
 * It covers
 *
 *   - an anonymous visitor: the demo, by default and by name;
 *   - a signed-in customer: their own workspace, and the demo if they ask;
 *   - a foreign workspace slug: refused, for both anonymous and signed in;
 *   - a deployment with no demo seeded: refused, so nobody is shown a blank page
 *     under a promise;
 *   - the pages that depend on the rule: the front door resolves through it,
 *     and the sign-in page offers the demo.
 *
 * WHAT IT DOES NOT COVER
 *
 * The rendering of the queue itself, the ranking engine, the ingest path and
 * billing — those are covered by check:ingest, check:contract and check:access.
 *
 * Needs a reachable Postgres: docker compose locally, the service container in
 * CI.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

let passed = 0;
const failures: string[] = [];

/** One line per claim, and the count at the end — the same shape as the other
 *  check scripts, so a run reads the same whichever suite you are looking at. */
function ok(label: string, condition: unknown): void {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failures.push(label);
    console.log(`  FAIL  ${label}`);
  }
}

function eq(label: string, actual: unknown, expected: unknown): void {
  if (actual === expected) {
    ok(label, true);
  } else {
    ok(`${label} — got ${JSON.stringify(actual)}, wanted ${JSON.stringify(expected)}`, false);
  }
}

function source(relPath: string): string {
  return readFileSync(path.join(ROOT, relPath), "utf8");
}

/** The resolution is a union: a workspace or a refusal, never both. These
 *  readers narrow it, so a change in the shape is a type error here rather
 *  than a wrong answer in an assertion. */
function via(result: Resolution): string | null {
  return "via" in result ? result.via : null;
}

function reason(result: Resolution): string | null {
  return "reason" in result ? result.reason : null;
}

function slugOf(result: Resolution): string | null {
  return result.workspace?.slug ?? null;
}

// A per-run database on the configured server, so parallel or crashed runs never
// collide and the drop at the end is the whole cleanup. CREATE DATABASE cannot run
// inside a transaction, which is why this is a plain pool and not the app client.
const baseUrl =
  process.env.DATABASE_URL ?? "postgresql://abetconnect:abetconnect@localhost:5432/abetconnect";
const scratchName = `check_demo_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
const server = new Pool({ connectionString: baseUrl });
await server.query(`CREATE DATABASE "${scratchName}"`);

const scratchUrl = (() => {
  const parsed = new URL(baseUrl);
  parsed.pathname = `/${scratchName}`;
  parsed.searchParams.delete("schema");
  return parsed.toString();
})();
process.env.DATABASE_URL = scratchUrl;

// The schema a deploy would create, from the committed migration history.
execFileSync(path.join(ROOT, "node_modules", ".bin", "prisma"), ["migrate", "deploy"], {
  cwd: ROOT,
  env: process.env,
  stdio: "ignore",
});

const { db } = await import("../src/lib/db");
const { resolveWorkspace, DEMO_SLUG } = await import("../src/lib/resolve-workspace");
type ActiveSession = import("../src/lib/session").ActiveSession;
type Resolution = import("../src/lib/resolve-workspace").WorkspaceResolution;

async function makeWorkspace(name: string, slug: string) {
  return db.workspace.create({ data: { name, slug } });
}

async function makeUser(email: string) {
  return db.user.create({
    data: { email, name: email.split("@")[0], passwordHash: "placeholder-not-a-real-digest" },
  });
}

/** The owner of a workspace, and the session shape the resolver accepts. */
async function signedIn(workspaceId: string, slug: string, name: string) {
  const email = `owner-${slug}@example.com`;
  const user = await makeUser(email);
  await db.membership.create({ data: { userId: user.id, workspaceId, role: "OWNER" } });
  const session: ActiveSession = {
    userId: user.id,
    email,
    name: user.name,
    workspaceId,
    workspaceName: name,
    workspaceSlug: slug,
    role: "OWNER",
  };
  return session;
}

try {
  // ── the fixtures ───────────────────────────────────────────────────────
  const demo = await makeWorkspace("Acme Revenue Team", DEMO_SLUG);
  const customer = await makeWorkspace("Northwind Logistics", "northwind");
  const other = await makeWorkspace("Globex Freight", "globex");
  const session = await signedIn(customer.id, customer.slug, customer.name);

  // ── an anonymous visitor ───────────────────────────────────────────────
  const anonDefault = await resolveWorkspace(undefined, null);
  eq("an anonymous visitor is shown the demo by default", via(anonDefault), "demo");
  eq("…and it is the demo workspace", slugOf(anonDefault), DEMO_SLUG);

  const anonNamed = await resolveWorkspace(DEMO_SLUG, null);
  eq("an anonymous visitor may ask for the demo by name", via(anonNamed), "demo");
  eq("…and gets the demo workspace", slugOf(anonNamed), DEMO_SLUG);

  const anonForeign = await resolveWorkspace(other.slug, null);
  eq("an anonymous visitor naming another workspace is refused", anonForeign.workspace, null);
  eq("…with the reason a sign-in needs", reason(anonForeign), "signin-required");

  const anonUnknown = await resolveWorkspace("no-such-workspace", null);
  eq("an anonymous visitor naming a workspace that does not exist is refused", anonUnknown.workspace, null);

  // ── a signed-in customer ───────────────────────────────────────────────
  const own = await resolveWorkspace(undefined, session);
  eq("a signed-in customer gets their own workspace", via(own), "session");
  eq("…and it is theirs", slugOf(own), customer.slug);

  const ownByName = await resolveWorkspace(customer.slug, session);
  eq("a signed-in customer may name their own workspace", via(ownByName), "session");

  const viewingDemo = await resolveWorkspace(DEMO_SLUG, session);
  eq("a signed-in customer may look at the demo", via(viewingDemo), "session-viewing-demo");
  eq("…and it is the demo", slugOf(viewingDemo), DEMO_SLUG);

  const foreign = await resolveWorkspace(other.slug, session);
  eq("a signed-in customer naming another workspace is refused", foreign.workspace, null);
  eq("…with the reason a sign-in needs", reason(foreign), "signin-required");

  // ── a deployment with no demo seeded ───────────────────────────────────
  await db.workspace.delete({ where: { id: demo.id } });
  const noDemoAnon = await resolveWorkspace(undefined, null);
  eq("with no demo seeded, an anonymous visitor is sent to sign in", noDemoAnon.workspace, null);
  const noDemoNamed = await resolveWorkspace(DEMO_SLUG, null);
  eq("…and asking for the demo by name does not resurrect it", noDemoNamed.workspace, null);
  const noDemoOwn = await resolveWorkspace(undefined, session);
  eq("…but a signed-in customer still gets their own workspace", via(noDemoOwn), "session");

  // ── the pages that depend on the rule ──────────────────────────────────
  const front = source("src/app/page.tsx");
  ok("the front door resolves through the shared rule", front.includes("resolveWorkspace"));
  ok("the front door no longer demands a session before it shows anything", !front.includes("requireSession()"));
  ok("the front door says which one you are looking at", front.includes("This is the live demo"));
  ok("the front door offers a way in", front.includes('href="/login"'));

  const signIn = source("src/app/login/page.tsx");
  ok("the sign-in page offers the demo", signIn.includes("Open the live demo"));
  ok("the sign-in page's demo link points at the demo", signIn.includes("workspace=demo"));

  const resolver = source("src/lib/resolve-workspace.ts");
  ok("the demo slug is matched exactly, never by prefix", resolver.includes('DEMO_SLUG = "demo"'));
} finally {
  await server.query(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`);
  await server.end();
}

console.log(`\n  ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.error(`\n  Failed: ${failures.join("; ")}`);
  process.exit(1);
}
