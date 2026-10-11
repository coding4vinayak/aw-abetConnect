// Docs-vs-source check for abetConnect.
//
// This repository has no unit tests, and its README is the sales document: the route
// list is what a customer evaluates and what an integrator codes against. Two ways
// that goes wrong, and both are silent:
//
//   1. A documented endpoint that does not exist. Someone integrates it, gets a 404,
//      and the fault looks like their bug. (This happened in a sister product, where
//      a README named "POST /api/v1/ingest" after the internal ingest pipeline that
//      has no route at all.)
//   2. An implemented endpoint missing from the docs. Nothing breaks, so nobody
//      notices — but the capability is unsellable and unbilled. PATCH on a draft is
//      the human-in-the-loop edit; if it is not documented, the "you stay in control"
//      pitch has no page to point at.
//
// Run: node scripts/check-docs.mjs

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const README = readFileSync(join(ROOT, "README.md"), "utf8");

const VERBS = ["GET", "POST", "PATCH", "PUT", "DELETE"];
const passes = [];
const failures = [];
const check = (label, ok, detail = "") =>
  (ok ? passes : failures).push(ok ? label : `${label}${detail ? ` — ${detail}` : ""}`);

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, acc);
    else acc.push(full);
  }
  return acc;
}

// ── what the code really offers ────────────────────────────────────────────────
// Next resolves a route handler from its path on disk: src/app/api/v1/threads/[id]
// becomes /api/v1/threads/{anything}. The verb is the exported function name, which
// is the only thing that decides whether a request is answered or gets a 405.
const implemented = new Map();
for (const file of walk(join(ROOT, "src", "app", "api"))) {
  if (!file.endsWith("route.ts")) continue;
  const source = readFileSync(file, "utf8");
  const path =
    "/" +
    relative(join(ROOT, "src", "app"), file)
      .replace(/\/route\.ts$/, "")
      .replace(/\[[^\]]+\]/g, "{}");
  const verbs = [...source.matchAll(/^export async function (\w+)/gm)]
    .map((m) => m[1])
    .filter((v) => VERBS.includes(v));
  implemented.set(path, verbs);
}

check("route handlers were found", implemented.size > 0, `${implemented.size} paths`);

// ── 1. every documented call must exist ────────────────────────────────────────
const documented = [];
for (const line of README.split("\n")) {
  const m = line.match(
    new RegExp(`^\\s*(${VERBS.join("|")})\\s+(/api/[a-z0-9/_{}-]+)\\s*(#.*)?$`, "i"),
  );
  if (m) documented.push({ verb: m[1].toUpperCase(), path: m[2] });
}
check("the README documents at least one endpoint", documented.length > 0);

for (const { verb, path } of documented) {
  const normalised = path.replace(/\{[^}]*\}/g, "{}");
  const verbs = implemented.get(normalised);
  check(
    `documented ${verb} ${path} exists`,
    Boolean(verbs?.includes(verb)),
    verbs
      ? `route handler exports ${verbs.join(", ") || "nothing"}`
      : "no route handler at this path",
  );
}

// ── 2. every real call must be documented ──────────────────────────────────────
for (const [path, verbs] of implemented) {
  const shown = path.replace(/\{\}/g, "{id}");
  for (const verb of verbs) {
    check(
      `implemented ${verb} ${shown} is in the README`,
      documented.some(
        (d) => d.verb === verb && d.path.replace(/\{[^}]*\}/g, "{}") === path,
      ),
      "shipped but undiscoverable",
    );
  }
}

// ── 3. screens ─────────────────────────────────────────────────────────────────
// An endpoint nobody documents is an unsold feature; a screen nobody documents is a
// feature nobody finds. The team and invitation pages landed after the checks above
// were written, which is how a README ends up describing half the product, so page
// routes are held to the same rule as route handlers.
const APP = join(ROOT, "src", "app");
const pages = [];
for (const file of walk(APP)) {
  if (!file.endsWith("page.tsx")) continue;
  const route =
    file
      .slice(APP.length)
      .replace(/\\/g, "/")
      .replace(/\/page\.tsx$/, "")
      // /invite/[token] is documented as /invite: the README names the path, and no
      // real invitation token belongs in it.
      .replace(/\[[^\]]+\]/g, "")
      .replace(/\/$/, "") || "/";
  pages.push(route);
}

check("pages were found", pages.length > 0, `${pages.length} screens`);
for (const route of pages) {
  // The root page is the product itself, described in prose rather than as a URL —
  // and a substring test for "/" passes for any text whatsoever, which would make
  // this assertion decorative.
  if (route === "/") continue;
  check(
    `the ${route} screen is named in the README`,
    README.includes(route),
    "shipped but undiscoverable",
  );
}


// ── 4. environment ─────────────────────────────────────────────────────────────
// A variable the README tells you to set but no code reads is a decoy; one the code
// requires but the README never mentions is a deploy that fails on first boot.
const source = walk(join(ROOT, "src"))
  .filter((f) => /\.tsx?$/.test(f))
  .map((f) => readFileSync(f, "utf8"))
  .join("\n");
const schema = readFileSync(join(ROOT, "prisma", "schema.prisma"), "utf8");
const envExample = (() => {
  try {
    return readFileSync(join(ROOT, ".env.example"), "utf8");
  } catch {
    return "";
  }
})();

const readByCode = new Set(
  [...source.matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)].map((m) => m[1]),
);
const namedInReadme = new Set(
  [...README.matchAll(/\b([A-Z][A-Z0-9]{2,}(?:_[A-Z0-9]+)+)\b/g)].map((m) => m[1]),
);

for (const name of namedInReadme) {
  if (!/ENV|KEY|URL|TOKEN|SECRET|DATABASE|SITE/i.test(name)) continue;
  check(
    `README tells you to set ${name}, and something reads it`,
    readByCode.has(name) || schema.includes(name) || envExample.includes(name),
    "documented but unreferenced by code",
  );
}
for (const name of readByCode) {
  if (name.startsWith("NEXT_PUBLIC") || name === "NODE_ENV" || name === "PORT") continue;
  check(
    `${name} is read by the code and named in the README or .env.example`,
    namedInReadme.has(name) || envExample.includes(name),
    "required by a deploy that the instructions never mention",
  );
}

// ── report ─────────────────────────────────────────────────────────────────────
for (const label of failures) console.log(`FAIL  ${label}`);
console.log(
  `\nabetConnect docs check — ${passes.length} passed, ${failures.length} failed`,
);
console.log(`endpoints: ${implemented.size} implemented, ${documented.length} documented`);
console.log(`screens: ${pages.length} page routes checked against the README`);
if (failures.length) {
  console.log(
    "\nThe README is the integration contract for a paid product. Either delete the",
    "\nclaim or build the thing.",
  );
  process.exit(1);
}
