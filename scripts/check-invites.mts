/**
 * Roles and invitations — run with:  npm run check:access
 *
 * WHY THIS EXISTS
 *
 * abetConnect has carried three roles in its schema from the start, and the API key
 * guard has honoured them, but nothing could actually produce an ADMIN or a MEMBER:
 * the only account signup ever created was an OWNER. So the difference between the
 * roles was a column value, and the only way to see the guard work was to hand-edit
 * the Membership table in a database console — which is not something to do to a
 * customer's data, and not evidence anybody trusts. Reviewing that guard meant
 * reading code and hoping.
 *
 * This script makes the behaviour observable. It builds a throwaway database on
 * the configured Postgres from the committed migrations, mints an owner, an admin
 * and a member, and drives the invitation flow and the role rules against it. No
 * hand-edited rows, no running server, no credentials, and nothing left behind
 * afterwards. Needs a reachable Postgres: docker compose locally, the service
 * container in CI.
 *
 * WHAT IT DOES NOT COVER
 *
 * It calls lib/roles.ts, lib/invites.ts and lib/seats.ts directly. The cookie and
 * session layer in src/app/**\/actions.ts is not exercised here, because those modules
 * need a Next request context — scripts/smoke.sh drives them over HTTP against a real
 * build, which is where an invitation is issued from the page and redeemed in a
 * browser. The two suites meet in the middle: this one covers every rule, including
 * the ones a browser cannot reach, and that one covers the wire. Section 6 is the
 * join, asserting that the request guards still call the predicates proved below.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

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

function eq(label: string, actual: unknown, expected: unknown): void {
  if (actual === expected) {
    ok(label, true);
  } else {
    ok(`${label} — got ${JSON.stringify(actual)}, wanted ${JSON.stringify(expected)}`, false);
  }
}

/** A refusal has to say which rule fired, so a changed message shows up here as a
 *  named failure rather than a bare false. */
function refuses(
  label: string,
  result: { ok: boolean; error?: string },
  fragment: string,
): void {
  if (!result.ok) {
    ok(`${label} refused: "${result.error}"`, (result.error ?? "").includes(fragment));
  } else {
    ok(`${label} — expected refusal containing "${fragment}", but it was accepted`, false);
  }
}

function accepts(label: string, result: { ok: boolean; error?: string }): void {
  if (result.ok) {
    ok(label, true);
  } else {
    ok(`${label} — expected acceptance, got "${result.error}"`, false);
  }
}

const baseUrl =
  process.env.DATABASE_URL ?? "postgresql://abetconnect:abetconnect@localhost:5432/abetconnect";
const scratchName = `check_invites_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;

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
const { canEditRole, canGrant, canManageRoles, INVITABLE_ROLES, isInvitableRole } =
  await import("../src/lib/roles");
const {
  acceptInvite,
  createInvite,
  hashInviteToken,
  inviteProblem,
  INVITE_TTL_DAYS,
  listPendingInvites,
  revokeInvite,
} = await import("../src/lib/invites");
const { editSeat, REMOVE } = await import("../src/lib/seats");

/**
 * Fixtures.
 *
 * passwordHash is a placeholder because nothing here authenticates. The question
 * under test is what a membership role permits, and acceptInvite reads an account's
 * email address, never its password.
 */

let counter = 0;

async function makeWorkspace(name: string) {
  counter += 1;
  return db.workspace.create({
    data: {
      name,
      slug: `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${counter}`,
    },
  });
}

async function makeUser(email: string) {
  return db.user.create({
    data: { email, name: email.split("@")[0], passwordHash: "placeholder-not-a-real-digest" },
  });
}

async function makeSeat(userId: string, workspaceId: string, role: string) {
  return db.membership.create({ data: { userId, workspaceId, role } });
}

/** The owner and the workspace that signup would have created for them. */
async function owned(email: string, workspaceName: string) {
  const workspace = await makeWorkspace(workspaceName);
  const user = await makeUser(email);
  await makeSeat(user.id, workspace.id, "OWNER");
  return { user, workspace };
}

function source(relPath: string): string {
  return readFileSync(path.join(ROOT, relPath), "utf8");
}

/** Stops a run that cannot continue meaningfully, rather than reporting forty
 *  failures caused by the one line that broke. Returns the success arm of the
 *  union so callers keep the fields the refusal arm does not have. */
function unwrap<T extends { ok: boolean }>(label: string, result: T): Extract<T, { ok: true }> {
  if (!result.ok) {
    const message = `${label} — unexpected refusal: ${(result as { error?: string }).error}`;
    // Recorded by the catch at the end of the run, so it is not counted twice.
    throw new Error(message);
  }
  return result as Extract<T, { ok: true }>;
}

// ---------------------------------------------------------------------------
// 1. The role rules
//
// This is the predicate the API key guard runs on, so every line here is an answer
// to a question an operator can ask about a real seat: can this person mint a
// credential, invite a colleague, or hand out an owner.
// ---------------------------------------------------------------------------

for (const role of ["OWNER", "ADMIN"]) {
  ok(`${role} may manage credentials and people`, canManageRoles(role));
}
for (const role of ["MEMBER", "OWNER ", "", "owner", "BOGUS", undefined, null]) {
  ok(`${String(role)} may not manage credentials or people`, !canManageRoles(role));
}

eq("invitations issue two roles", INVITABLE_ROLES.join(","), "ADMIN,MEMBER");
ok("…and OWNER is not one of them", !isInvitableRole("OWNER"));
ok("role names are compared exactly", !isInvitableRole("owner"));

const grants: Array<[string | null, string, boolean]> = [
  ["OWNER", "ADMIN", true],
  ["OWNER", "MEMBER", true],
  // Typing OWNER into a role field while inviting someone must not be a way to
  // hand over a workspace.
  ["OWNER", "OWNER", false],
  ["ADMIN", "MEMBER", true],
  // The escalation rule: a compromised admin account cannot quietly duplicate
  // itself, because only an owner may issue an admin.
  ["ADMIN", "ADMIN", false],
  ["ADMIN", "OWNER", false],
  // The reason a third role exists at all.
  ["MEMBER", "MEMBER", false],
  ["MEMBER", "ADMIN", false],
  ["MEMBER", "OWNER", false],
  [null, "MEMBER", false],
  ["OWNER", "SUPERUSER", false],
  ["OWNER", "", false],
];

for (const [granter, target, allowed] of grants) {
  const result = canGrant(granter, target);
  eq(`${granter} inviting ${target}`, result.ok, allowed);
  if (!allowed) ok(`refusal of ${granter} -> ${target} is explained`, "error" in result);
}

const edits: Array<[string | null, string, boolean]> = [
  ["OWNER", "ADMIN", true],
  ["OWNER", "MEMBER", true],
  // No one edits their own seat through this rule, which is what keeps "demote
  // self" from being one misclick away from a workspace with no owner.
  ["OWNER", "OWNER", false],
  ["ADMIN", "MEMBER", true],
  ["ADMIN", "ADMIN", false],
  ["ADMIN", "OWNER", false],
  ["MEMBER", "MEMBER", false],
  [null, "MEMBER", false],
];

for (const [actor, target, allowed] of edits) {
  eq(`${actor} editing ${target}`, canEditRole(actor, target), allowed);
}

try {
  // -------------------------------------------------------------------------
  // 2. Issuing an invitation
  // -------------------------------------------------------------------------

  const acme = await owned("owner@acme.test", "Acme Leads");
  const teammate = await makeUser("teammate@acme.test");

  const issue = (email: string, role: string) =>
    createInvite({
      workspaceId: acme.workspace.id,
      email,
      role,
      createdById: acme.user.id,
    });

  refuses("blank address", await issue("   ", "MEMBER"), "valid email");
  refuses("no @", await issue("teammate", "MEMBER"), "valid email");
  refuses("no domain", await issue("teammate@", "MEMBER"), "valid email");
  refuses("absurdly long address", await issue(`${"a".repeat(300)}@acme.test`, "MEMBER"), "valid email");
  refuses("invented role", await issue("teammate@acme.test", "SUPERUSER"), "admin or member");
  refuses("ownership by invitation", await issue("teammate@acme.test", "OWNER"), "admin or member");

  eq("a refused invitation stores nothing", await db.invite.count(), 0);

  const issued = unwrap("invite a colleague as a member", await issue("  Teammate@Acme.test  ", "MEMBER"));
  eq("the address is normalised", issued.email, "teammate@acme.test");
  eq("first issue is not a rotation", issued.rotated, false);

  const stored = await db.invite.findFirst({ where: { email: "teammate@acme.test" } });
  ok("an invitation row exists", stored !== null);
  eq("it carries the granted role", stored?.role, "MEMBER");
  eq("the token is kept as a sha256 digest", stored?.tokenHash.length, 64);
  ok("the stored value is not the token", stored?.tokenHash !== issued.token);
  ok(
    `it expires ${INVITE_TTL_DAYS} days out`,
    Math.abs(
      (stored!.expiresAt.getTime() - stored!.createdAt.getTime()) / 86_400_000 -
        INVITE_TTL_DAYS,
    ) < 0.01,
  );
  eq("hashing is what the row stores", stored?.tokenHash, hashInviteToken(issued.token));

  // The rows, not the model: the claim is that a database dump contains nothing
  // usable, so a leaked Invite table is not a list of working links.
  const dump = JSON.stringify(await db.invite.findMany());
  ok("no plaintext token anywhere in the invitation rows", !dump.includes(issued.token));

  // Inviting the same address again rotates the link instead of leaving two live
  // ones, because the old plaintext cannot be recovered to be re-sent.
  const again = unwrap("re-invite the same address", await issue("teammate@acme.test", "MEMBER"));
  eq("a re-invite reports a rotation", again.rotated, true);
  ok("the link changed", again.token !== issued.token);
  eq("and there is still only one", await db.invite.count({ where: { workspaceId: acme.workspace.id } }), 1);
  refuses(
    "the superseded link stops working",
    await acceptInvite({ token: issued.token, userId: teammate.id }),
    "does not exist",
  );
  accepts("the current link works", await acceptInvite({ token: again.token, userId: teammate.id }));
  refuses(
    "inviting someone who already has a seat",
    await issue("teammate@acme.test", "MEMBER"),
    "already a member",
  );

  // -------------------------------------------------------------------------
  // 3. Redeeming an invitation
  // -------------------------------------------------------------------------

  const adminInvite = unwrap("invite an admin", await issue("boss@acme.test", "ADMIN"));
  const boss = await makeUser("boss@acme.test");
  const stranger = await makeUser("nobody@elsewhere.test");

  const pending = await listPendingInvites(acme.workspace.id);
  eq("the pending list holds the live link", pending.length, 1);
  eq("…for the right address", pending[0]?.email, "boss@acme.test");

  refuses(
    "a link opened by the wrong account",
    await acceptInvite({ token: adminInvite.token, userId: stranger.id }),
    "was sent to boss@acme.test",
  );
  eq(
    "and no seat appeared for them",
    await db.membership.count({ where: { workspaceId: acme.workspace.id, userId: stranger.id } }),
    0,
  );

  const joined = unwrap(
    "the named account accepts",
    await acceptInvite({ token: adminInvite.token, userId: boss.id }),
  );
  eq("into the workspace the invitation names", joined.workspaceId, acme.workspace.id);
  const bossSeat = await db.membership.findUnique({
    where: { userId_workspaceId: { userId: boss.id, workspaceId: acme.workspace.id } },
  });
  eq("with the role from the row, not from the browser", bossSeat?.role, "ADMIN");
  ok("so the admin seat passes the credential guard", canManageRoles(bossSeat?.role));
  refuses(
    "the same link a second time",
    await acceptInvite({ token: adminInvite.token, userId: boss.id }),
    "already been used",
  );
  eq(
    "accepting clears it from the pending list",
    (await listPendingInvites(acme.workspace.id)).length,
    0,
  );

  // A seat granted by some other path while a link was in the wild: the link must
  // not silently re-set that person's role.
  const carol = await makeUser("carol@acme.test");
  const stale = unwrap("invite carol as an admin", await issue("carol@acme.test", "ADMIN"));
  await makeSeat(carol.id, acme.workspace.id, "MEMBER");
  refuses(
    "a live link cannot upgrade or demote an existing seat",
    await acceptInvite({ token: stale.token, userId: carol.id }),
    "already have access",
  );
  eq(
    "carol is still a member",
    (
      await db.membership.findUnique({
        where: { userId_workspaceId: { userId: carol.id, workspaceId: acme.workspace.id } },
      })
    )?.role,
    "MEMBER",
  );

  const dan = await makeUser("dan@acme.test");
  const danInvite = unwrap("invite dan", await issue("dan@acme.test", "MEMBER"));
  const danRow = await db.invite.findFirstOrThrow({ where: { email: "dan@acme.test" } });
  await db.invite.update({
    where: { id: danRow.id },
    data: { expiresAt: new Date(Date.now() - 60_000) },
  });
  refuses("an expired link", await acceptInvite({ token: danInvite.token, userId: dan.id }), "expired");
  ok(
    "the page and the redemption agree about expiry",
    (inviteProblem({ acceptedAt: null, expiresAt: new Date(Date.now() - 60_000) }) ?? "").includes("expired"),
  );
  ok(
    "a live link is not a problem",
    inviteProblem({ acceptedAt: null, expiresAt: new Date(Date.now() + 60_000) }) === null,
  );
  ok(
    "no row at all is explained",
    (inviteProblem(null) ?? "").includes("does not exist"),
  );
  refuses("an empty token", await acceptInvite({ token: "", userId: dan.id }), "does not exist");
  refuses(
    "a token from somewhere else entirely",
    await acceptInvite({ token: "x".repeat(43), userId: dan.id }),
    "does not exist",
  );

  // Two requests on one link at once: exactly one seat may come out of it.
  const pair = await makeUser("pair@acme.test");
  const pairInvite = unwrap("invite a fifth person", await issue("pair@acme.test", "MEMBER"));
  const raced = await Promise.all([
    acceptInvite({ token: pairInvite.token, userId: pair.id }),
    acceptInvite({ token: pairInvite.token, userId: pair.id }),
  ]);
  eq("exactly one of two simultaneous redemptions wins", raced.filter((r) => r.ok).length, 1);
  eq(
    "and one seat exists",
    await db.membership.count({ where: { workspaceId: acme.workspace.id, userId: pair.id } }),
    1,
  );

  // -------------------------------------------------------------------------
  // 4. Taking a link back
  // -------------------------------------------------------------------------

  const erin = await makeUser("erin@acme.test");
  const live = unwrap("invite erin", await issue("erin@acme.test", "MEMBER"));
  const liveRow = await db.invite.findFirstOrThrow({ where: { email: "erin@acme.test" } });
  const rival = await owned("owner@rival.test", "Rival Replies");

  refuses(
    "another workspace revoking it by id",
    await revokeInvite({ workspaceId: rival.workspace.id, inviteId: liveRow.id }),
    "no longer pending",
  );
  ok(
    "the row survived the attempt",
    (await db.invite.findUnique({ where: { id: liveRow.id } })) !== null,
  );
  eq(
    "and a rival sees none of this workspace's invitations",
    (await listPendingInvites(rival.workspace.id)).length,
    0,
  );
  accepts(
    "the link still works for the person it was sent to",
    await acceptInvite({ token: live.token, userId: erin.id }),
  );
  refuses(
    "revoking a spent invitation",
    await revokeInvite({ workspaceId: acme.workspace.id, inviteId: liveRow.id }),
    "no longer pending",
  );

  const frank = await makeUser("frank@acme.test");
  const revoked = unwrap("invite frank", await issue("frank@acme.test", "MEMBER"));
  const revokedRow = await db.invite.findFirstOrThrow({ where: { email: "frank@acme.test" } });
  accepts("revoke it while pending", await revokeInvite({
    workspaceId: acme.workspace.id,
    inviteId: revokedRow.id,
  }));
  refuses(
    "the revoked link",
    await acceptInvite({ token: revoked.token, userId: frank.id }),
    "does not exist",
  );
  eq(
    "frank has no seat",
    await db.membership.count({ where: { workspaceId: acme.workspace.id, userId: frank.id } }),
    0,
  );

  // The whole point of the exercise: a real mixed-role team, none of it assembled
  // by hand in a database console. Four members got in
  // (teammate, carol, pair, erin); dan's link had expired and frank's was revoked,
  // so neither has a seat.
  const seats = await db.membership.findMany({
    where: { workspaceId: acme.workspace.id },
    orderBy: { role: "asc" },
  });
  eq("everyone invited in has exactly one seat", new Set(seats.map((s) => s.userId)).size, seats.length);
  eq(
    "the team is one owner, one admin and four members",
    seats.map((s) => s.role).join(","),
    "ADMIN,MEMBER,MEMBER,MEMBER,MEMBER,OWNER",
  );

  // -------------------------------------------------------------------------
  // 5. Changing or ending a seat
  //
  // An invitation only ever adds access, so this is the half that fixes a
  // mistake — and the half most likely to be reached by someone who is annoyed
  // rather than careful. The same two predicates decide it, which is the point: a
  // role dropdown must not be able to do what an invitation form cannot.
  // -------------------------------------------------------------------------

  const seatOf = (userId: string) =>
    db.membership.findUnique({
      where: { userId_workspaceId: { userId, workspaceId: acme.workspace.id } },
    });

  const adminRow = await seatOf(boss.id);
  const memberRow = await seatOf(erin.id);
  const ownerRow = await seatOf(acme.user.id);
  ok("the seats the earlier sections built are there to edit", !!adminRow && !!memberRow && !!ownerRow);

  accepts(
    "an owner demotes an admin",
    await editSeat({
      workspaceId: acme.workspace.id,
      membershipId: adminRow!.id,
      actorRole: "OWNER",
      role: "MEMBER",
    }),
  );
  eq("…and it stuck", (await seatOf(boss.id))?.role, "MEMBER");
  accepts(
    "an owner promotes them back",
    await editSeat({
      workspaceId: acme.workspace.id,
      membershipId: adminRow!.id,
      actorRole: "OWNER",
      role: "ADMIN",
    }),
  );
  eq("…both ways", (await seatOf(boss.id))?.role, "ADMIN");

  const unchanged = await editSeat({
    workspaceId: acme.workspace.id,
    membershipId: adminRow!.id,
    actorRole: "OWNER",
    role: "ADMIN",
  });
  ok(
    "setting a role to what it already is changes nothing and says so",
    unchanged.ok && unchanged.action === "unchanged",
  );

  refuses(
    "an admin changing another admin",
    await editSeat({
      workspaceId: acme.workspace.id,
      membershipId: adminRow!.id,
      actorRole: "ADMIN",
      role: "MEMBER",
    }),
    "cannot change an admin seat",
  );
  refuses(
    "an admin promoting a member into admin",
    await editSeat({
      workspaceId: acme.workspace.id,
      membershipId: memberRow!.id,
      actorRole: "ADMIN",
      role: "ADMIN",
    }),
    "Only an owner can grant admin access",
  );
  refuses(
    "a member changing anyone at all",
    await editSeat({
      workspaceId: acme.workspace.id,
      membershipId: memberRow!.id,
      actorRole: "MEMBER",
      role: "ADMIN",
    }),
    "cannot change a member seat",
  );
  refuses(
    "anyone changing an owner from inside the product",
    await editSeat({
      workspaceId: acme.workspace.id,
      membershipId: ownerRow!.id,
      actorRole: "OWNER",
      role: "MEMBER",
    }),
    "cannot change an owner seat",
  );
  refuses(
    "a role that does not exist",
    await editSeat({
      workspaceId: acme.workspace.id,
      membershipId: memberRow!.id,
      actorRole: "OWNER",
      role: "SUPERUSER",
    }),
    "admin or member",
  );
  refuses(
    "a seat in someone else's workspace",
    await editSeat({
      workspaceId: rival.workspace.id,
      membershipId: memberRow!.id,
      actorRole: "OWNER",
      role: "MEMBER",
    }),
    "not in your workspace",
  );
  eq("…and the attempt left it alone", (await seatOf(erin.id))?.role, "MEMBER");

  // Removing access has to end the browser session minted in that workspace, or a
  // deleted seat keeps reading the queue until its tab happens to reload.
  const soonGone = { userId: erin.id, expiresAt: new Date(Date.now() + 3_600_000) };
  await db.session.create({
    data: { ...soonGone, workspaceId: acme.workspace.id, tokenHash: "erin-in-acme" },
  });
  await db.session.create({
    data: { ...soonGone, workspaceId: rival.workspace.id, tokenHash: "erin-in-rival" },
  });
  accepts(
    "an owner takes a seat away",
    await editSeat({
      workspaceId: acme.workspace.id,
      membershipId: memberRow!.id,
      actorRole: "OWNER",
      role: REMOVE,
    }),
  );
  eq("the seat is gone", await seatOf(erin.id), null);
  eq(
    "so is the cookie for that workspace",
    await db.session.count({ where: { userId: erin.id, workspaceId: acme.workspace.id } }),
    0,
  );
  eq(
    "…and a cookie minted in a workspace they still belong to survives",
    await db.session.count({ where: { userId: erin.id, workspaceId: rival.workspace.id } }),
    1,
  );

  // Removal is not a permanent lockout: they can be invited again from here.
  const againErin = unwrap("re-invite a removed seat", await issue("erin@acme.test", "MEMBER"));
  accepts("and the new link works", await acceptInvite({ token: againErin.token, userId: erin.id }));
  eq("back in as a member", (await seatOf(erin.id))?.role, "MEMBER");

  // -------------------------------------------------------------------------
  // 6. The guards actually use these rules
  //
  // Sections 1-5 prove the predicates. These read the request-handling modules and
  // fail if they have stopped calling them, which is the only way the above is
  // worth anything: a correct rule with a private copy of the logic beside it is
  // two rules, and the second one has no tests.
  // -------------------------------------------------------------------------

  const keyActions = source("src/app/integrations/actions.ts");
  ok("the API key guard calls canManageRoles", keyActions.includes("canManageRoles(session.role)"));
  ok(
    "…and kept no private copy of the rule",
    !/role\s*[!=]==\s*["'](OWNER|ADMIN)["']/.test(keyActions),
  );
  const teamActions = source("src/app/members/actions.ts");
  ok("the invite action applies canGrant before creating anything", teamActions.includes("canGrant("));
  ok(
    "the invite action takes no workspace from the form",
    !/formData\.get\(\s*["'](workspace|workspaceId|role_granted)/.test(teamActions),
  );
  const acceptRoute = source("src/app/invite/actions.ts");
  ok(
    "redeeming goes through the library rather than writing a membership inline",
    acceptRoute.includes("acceptInvite(") && !acceptRoute.includes("db.membership.create"),
  );
  const schema = source("prisma/schema.prisma");
  ok(
    "invitations are stored hashed and unique",
    /tokenHash\s+String\s+@unique/.test(schema),
  );
  ok(
    "OWNER is not in the list an invitation can carry",
    !/InviteRole\s*\{[^}]*OWNER/.test(schema) && !INVITABLE_ROLES.includes("OWNER" as never),
  );

  const seatModule = source("src/lib/seats.ts");
  ok("the seat action delegates to the tested rule", teamActions.includes("editSeat("));
  ok("…and queries no membership of its own", !/db\.membership/.test(teamActions));
  ok(
    "taking a seat away takes the sessions minted in that workspace with it",
    seatModule.includes("db.session.deleteMany"),
  );
  ok(
    "a session with no membership is ended, not silently demoted to member",
    !/membership\?\.role \?\?/.test(source("src/lib/session.ts")),
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

console.log(`\n================================`);
console.log(`  ${passed} passed, ${failures.length} failed`);
console.log(`================================`);
for (const failure of failures) console.log(`  FAIL  ${failure}`);
if (!failures.length) {
  console.log("  roles and invitations verified without editing the database by hand");
}
process.exit(failures.length ? 1 : 0);

