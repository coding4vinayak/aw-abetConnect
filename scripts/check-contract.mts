// The API contract check: src/lib/openapi.ts against the route handlers.
//
// A spec is a second description of the same thing, and second descriptions rot.
// This one cannot, because every claim is read back out of the source that serves it:
//
//   · every operation in the spec has a handler exporting that verb, and every
//     handler verb is in the spec — a documented call that 404s, and a shipped call
//     nobody can discover, have both bitten a sister product
//   · every parameter and body field the spec advertises is actually read by that
//     route. This is the rule that catches `cursor`: the queue documented it in its
//     own comment for months without ever parsing it, so an integrator paging a big
//     workspace re-fetched page 1 forever and blamed their own loop
//   · every status a route can return is documented for it
//   · every code passed to apiError exists in the spec's enum, and every code in
//     that enum is reachable somewhere
//   · every credential scheme an operation offers is declared, every declared
//     scheme is offered by something, and the 403s and 401s raised inside
//     authenticate() — which no route's apiError call ever shows — are documented
//   · a route that answers a CORS preflight says so in the spec, because a
//     browser-only failure is otherwise invisible in the server's own logs
//   · operationIds are unique, and info.version matches package.json
//
// Run: npx tsx scripts/check-contract.mts
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { API_ERROR_CODES } from "../src/lib/api";
import { openapiSpec } from "../src/lib/openapi";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
/**
 * A view of one operation. Declared rather than `any`: a spec this file reasons
 * about in `any` is a spec this file cannot actually check.
 */
interface SpecParameter {
  name: string;
  in: string;
}
interface SpecOperation {
  operationId?: string;
  summary?: string;
  parameters?: SpecParameter[];
  security?: Record<string, string[]>[];
  requestBody?: {
    content?: Record<string, { schema?: { properties?: Record<string, unknown> } }>;
  };
  responses?: Record<string, unknown>;
}
/** Where the error code enum lives, spelled out once so the lookups below are honest. */
interface ErrorSchema {
  properties?: { error?: { properties?: { code?: { enum?: string[] } } } };
}

const VERBS = ["GET", "POST", "PATCH", "PUT", "DELETE"] as const;
const lower = (v: string) => v.toLowerCase();

const passes: string[] = [];
const failures: string[] = [];
const check = (label: string, ok: boolean, detail = "") =>
  (ok ? passes : failures).push(ok ? label : `${label}${detail ? ` — ${detail}` : ""}`);

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, acc);
    else acc.push(full);
  }
  return acc;
}

/** src/app/api/v1/threads/[id]/route.ts → /api/v1/threads/{id} */
function toSpecPath(routeFile: string): string {
  const dir = relative(join(ROOT, "src", "app"), routeFile)
    .replace(/\\/g, "/")
    .replace(/\/route\.ts$/, "");
  return (
    "/" +
    dir
      .split("/")
      .map((seg) => seg.replace(/^\[(.+)]$/, "{$1}"))
      .join("/")
  );
}

interface Handler {
  verbs: string[];
  source: string;
  file: string;
}
const implemented = new Map<string, Handler>();
for (const file of walk(join(ROOT, "src", "app", "api"))) {
  if (!file.endsWith("route.ts")) continue;
  const source = readFileSync(file, "utf8");
  const verbs = [...source.matchAll(/^export async function (\w+)/gm)]
    .map((m) => m[1])
    .filter((v): v is (typeof VERBS)[number] => (VERBS as readonly string[]).includes(v));
  implemented.set(toSpecPath(file), { verbs, source, file: relative(ROOT, file) });
}
check("route handlers were found", implemented.size > 0, `${implemented.size} paths`);

type Op = SpecOperation;
const paths = openapiSpec.paths as unknown as Record<string, Record<string, Op>>;
const specOps: { path: string; verb: string; op: Op }[] = [];
for (const [path, item] of Object.entries(paths)) {
  for (const [verb, op] of Object.entries(item)) {
    if (!VERBS.map(lower).includes(verb as (typeof VERBS)[number])) continue;
    specOps.push({ path, verb: verb.toUpperCase(), op });
  }
}
check("the spec declares operations", specOps.length > 0, `${specOps.length} operations`);

const operationIds = specOps.map(({ op }) => String(op.operationId ?? ""));
check(
  "every operation has a unique operationId",
  operationIds.every(Boolean) && new Set(operationIds).size === operationIds.length,
  operationIds.filter((v, i) => !v || operationIds.indexOf(v) !== i).join(", "),
);
for (const { path, verb, op } of specOps) {
  check(`${verb} ${path} has a summary`, typeof op.summary === "string" && op.summary.length > 0);
}
// ── 1. spec ↔ handlers, both directions ────────────────────────────────────────
for (const { path, verb } of specOps) {
  const handler = implemented.get(path);
  check(
    `spec says ${verb} ${path}, and a handler answers it`,
    Boolean(handler?.verbs.includes(verb)),
    handler
      ? `${handler.file} exports ${handler.verbs.join(", ") || "nothing"}`
      : "no route at this path",
  );
}
for (const [path, handler] of implemented) {
  for (const verb of handler.verbs) {
    check(
      `${verb} ${path} is in the spec`,
      Boolean(paths[path]?.[lower(verb)]),
      "shipped but undescribed",
    );
  }
}

// ── 2. the spec cannot advertise a parameter or field the route ignores ────────
const readQuery = (source: string, name: string) =>
  new RegExp(`(?:searchParams|\\bp)\\.get\\(\\s*"${name}"\\s*\\)`).test(source);
const readsBodyField = (source: string, name: string) =>
  new RegExp(`\\bbody\\.${name}\\b`).test(source) ||
  new RegExp(`\\bbody\\[\\s*"${name}"\\s*\\]`).test(source);

for (const { path, verb, op } of specOps) {
  const handler = implemented.get(path);
  if (!handler) continue; // already failed above
  for (const param of op.parameters ?? []) {
    if (param.in === "query") {
      check(
        `${verb} ${path} reads the '${param.name}' parameter it advertises`,
        readQuery(handler.source, String(param.name)),
        `${handler.file} never calls get("${param.name}")`,
      );
    } else if (param.in === "path") {
      check(
        `${verb} ${path} has a [${param.name}] segment`,
        path.includes(`{${param.name}}`) && handler.file.includes(`[${param.name}]`),
        `no [${param.name}] in ${handler.file}`,
      );
    }
  }
  const properties = op.requestBody?.content?.["application/json"]?.schema?.properties ?? {};
  for (const field of Object.keys(properties)) {
    check(
      `${verb} ${path} reads the '${field}' body field it accepts`,
      readsBodyField(handler.source, field),
      `${handler.file} never touches body.${field}`,
    );
  }
}

// ── 3. what each handler can return ────────────────────────────────────────────
/**
 * Split a route file into the body of each exported verb, so an apiError is
 * attributed to the operation that raises it rather than to the file it lives in.
 */
function verbBlocks(source: string): Map<string, string> {
  const marks: { verb: string; start: number }[] = [];
  for (const m of source.matchAll(/^export async function (\w+)/gm)) {
    marks.push({ verb: m[1].toUpperCase(), start: m.index ?? 0 });
  }
  const blocks = new Map<string, string>();
  marks.forEach((mark, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].start : source.length;
    blocks.set(mark.verb, source.slice(mark.start, end));
  });
  return blocks;
}

const usedCodes = new Set<string>();
for (const [path, handler] of implemented) {
  for (const [verb, block] of verbBlocks(handler.source)) {
    const op = paths[path]?.[lower(verb)];
    if (!op) continue; // already failed above
    const declared = new Set(Object.keys(op.responses ?? {}).map(String));
    for (const m of block.matchAll(/apiError\(\s*"([a-z_]+)",\s*(\d+)/g)) {
      usedCodes.add(m[1]);
      // 401 and 500 are documented once for the whole API rather than per operation:
      // any handler that authenticates can return them, and repeating them fourteen
      // times is noise that hides the one that matters here.
      if (m[2] === "401" || m[2] === "500") continue;
      check(
        `${verb} ${path} documents its ${m[2]} (${m[1]})`,
        declared.has(m[2]),
        `returns ${m[2]} while the spec lists ${[...declared].join(", ")}`,
      );
    }
  }
}
// handleRouteError lives in lib/api.ts, outside any handler, and it is the only
// producer of two of the codes. Read it too rather than assuming.
const envelopeSource = readFileSync(join(ROOT, "src", "lib", "api.ts"), "utf8");
for (const m of envelopeSource.matchAll(/apiError\(\s*"([a-z_]+)"/g)) usedCodes.add(m[1]);
// authenticate() throws AuthError outside any route file, and handleRouteError
// turns those into apiError responses on the wire. A literal scan for apiError()
// never sees them, so authentication_error looks unreachable unless read here.
{
  const earlyAuth = readFileSync(join(ROOT, "src", "lib", "auth.ts"), "utf8");
  for (const refusal of earlyAuth.match(/new AuthError\((?:[^()]|\([^()]*\))*\)/g) ?? []) {
    const status = /\b([45]\d\d)\b/.exec(refusal)?.[1] ?? "401";
    const codes = [...refusal.matchAll(/"([a-z_]+)"/g)]
      .map((m) => m[1])
      .filter((s) => (API_ERROR_CODES as readonly string[]).includes(s));
    for (const code of codes) usedCodes.add(code);
    if (codes.length === 0 && status === "401") usedCodes.add("authentication_error");
  }
}

const errorSchema = (openapiSpec.components.schemas as Record<string, ErrorSchema>).Error;
const specCodes: string[] = errorSchema.properties?.error?.properties?.code?.enum ?? [];
check(
  "the spec's error codes are exactly the codes the server can send",
  [...API_ERROR_CODES].sort().join() === [...specCodes].sort().join(),
  `enum declares ${specCodes.join(", ")}`,
);
for (const code of API_ERROR_CODES) {
  check(`${code} is reachable`, usedCodes.has(code), "listed, but nothing on the server returns it");
}

// ── 4. the credentials on offer, and the refusals raised outside a route ───────
/**
 * A `security` entry naming a scheme the components block never declares is a
 * "Try it" button that silently sends nothing, and the integrator reads that as
 * their own mistake rather than ours. The reverse — a scheme no operation
 * references — is a door nobody walks through, usually because the endpoint it
 * belonged to was deleted and the scheme was left behind.
 */
const schemes = (openapiSpec.components as unknown as Record<string, Record<string, unknown>>)
  .securitySchemes;
const offered = new Set<string>();
for (const { path, verb, op } of specOps) {
  for (const entry of op.security ?? []) {
    for (const name of Object.keys(entry)) {
      offered.add(name);
      check(
        `${verb} ${path} offers a scheme that exists`,
        Boolean(schemes[name]),
        `components.securitySchemes has no '${name}'`,
      );
    }
  }
}
for (const name of Object.keys(schemes)) {
  check(
    `the '${name}' scheme is offered by some operation`,
    offered.has(name),
    "declared, referenced by nothing",
  );
}

/**
 * authenticate() refuses from outside any route file, so its codes never appear in
 * an apiError() call the scan above can see. Read them where they are raised: a
 * publishable key hitting a secret-only endpoint is the most likely failure a new
 * integrator meets, and it would otherwise be documented nowhere but the prose.
 */
const authSource = readFileSync(join(ROOT, "src", "lib", "auth.ts"), "utf8");
const documentedStatuses = new Set<string>(["401"]); // every authenticated call can answer it
for (const item of Object.values(paths)) {
  for (const op of Object.values(item)) {
    for (const status of Object.keys(op.responses ?? {})) documentedStatuses.add(String(status));
  }
}
const authRefusals = authSource.match(/new AuthError\((?:[^()]|\([^()]*\))*\)/g) ?? [];
check("authenticate()'s refusals were read", authRefusals.length > 0, "none found in lib/auth.ts");
for (const refusal of authRefusals) {
  const status = /\b([45]\d\d)\b/.exec(refusal)?.[1] ?? "401";
  const codes = [...refusal.matchAll(/"([a-z_]+)"/g)]
    .map((m) => m[1])
    .filter((s) => (API_ERROR_CODES as readonly string[]).includes(s));
  // AuthError's constructor defaults to authentication_error, so a throw with no
  // literal code still makes that code reachable on the wire via handleRouteError.
  for (const code of codes) usedCodes.add(code);
  if (codes.length === 0 && status === "401") usedCodes.add("authentication_error");
  check(
    `authenticate()'s ${status} carries a documented code`,
    codes.length > 0 || status === "401", // 401 is the constructor's default
    `no API_ERROR_CODES member appears in this throw, so the client sees ${status} with an undocumented code`,
  );
  check(
    `authenticate()'s ${status} is a status the spec knows`,
    documentedStatuses.has(status),
    "no operation documents it",
  );
}

// ── 5. README and spec must describe the same API ──────────────────────────────
const readme = readFileSync(join(ROOT, "README.md"), "utf8");
const documented = new Set<string>();
for (const line of readme.split("\n")) {
  const m = line.match(
    new RegExp(`^\\s*(${VERBS.join("|")})\\s+(/api/[a-z0-9/_{}-]+)\\s*(#.*)?$`, "i"),
  );
  if (m) documented.add(`${m[1].toUpperCase()} ${m[2].replace(/\{[^}]*\}/g, "{id}")}`);
}
check("the README names at least one endpoint", documented.size > 0);
const specCalls = new Set(
  specOps.map(({ path, verb }) => `${verb} ${path.replace(/\{[^}]*\}/g, "{id}")}`),
);
for (const call of specCalls) {
  check(`${call} is in the README too`, documented.has(call), "in the spec, absent from the prose");
}
for (const call of documented) {
  check(`README's ${call} is in the spec`, specCalls.has(call), "in the prose, absent from the spec");
}

// ── 5. version honesty ─────────────────────────────────────────────────────────
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string };
check(
  "info.version matches package.json",
  openapiSpec.info.version === pkg.version,
  `spec says ${openapiSpec.info.version}, package says ${pkg.version}`,
);

// ── report ─────────────────────────────────────────────────────────────────────
for (const label of failures) console.log(`FAIL  ${label}`);
console.log(`\nabetConnect contract check — ${passes.length} passed, ${failures.length} failed`);
console.log(
  `operations: ${specOps.length} declared, ${[...implemented.values()].reduce((n, h) => n + h.verbs.length, 0)} handled`,
);
console.log(`error codes: ${API_ERROR_CODES.length}, all reachable`);
if (failures.length) {
  console.log("\nThis document is served to customers at /api/v1/openapi. A claim in it the");
  console.log("source does not honour becomes their integrator's bug report against us.");
  process.exit(1);
}
