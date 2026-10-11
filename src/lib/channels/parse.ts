import type { Seniority } from "@/lib/types";

/** Pull "Name <a@b.com>" apart. Falls back to using the local part as a name. */
export function parseAddress(input?: string | null): {
  name?: string;
  email?: string;
} {
  if (!input) return {};
  const bracketed = input.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (bracketed) {
    const name = bracketed[1].trim();
    return { name: name || undefined, email: bracketed[2].trim().toLowerCase() };
  }
  const bare = input.trim().toLowerCase();
  if (bare.includes("@")) {
    // No display name was sent, so the local part stands in: "jane.doe@…"
    // becomes "Jane Doe" rather than a blank row in the queue.
    const local = bare.split("@")[0] ?? "";
    const name =
      local
        .split(/[.+_-]+/)
        .filter(Boolean)
        .map(titleCase)
        .join(" ") || undefined;
    return { name, email: bare };
  }
  return { name: input.trim() };
}

/** Company guess from an email domain, ignoring the usual free providers. */
const FREE_EMAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "hotmail.com",
  "outlook.com",
  "live.com",
  "icloud.com",
  "proton.me",
  "protonmail.com",
  "aol.com",
  "mail.com",
  "gmx.com",
  "yandex.com",
  "zoho.com",
]);

/**
 * Words that domains commonly glue onto a company name. Splitting them back out
 * turns "meridiancorp.com" into "Meridian Corp" rather than "Meridiancorp",
 * which matters because this string is shown on every row of the queue and used
 * in drafted replies — a mangled company name makes the whole thing look
 * automated.
 */
const GLUED_SUFFIXES = [
  "technologies",
  "consulting",
  "corporation",
  "solutions",
  "logistics",
  "software",
  "holdings",
  "partners",
  "capital",
  "systems",
  "digital",
  "freight",
  "studios",
  "metrics",
  "studio",
  "health",
  "group",
  "media",
  "works",
  "labs",
  "tech",
  "care",
  "data",
  "corp",
  "soft",
  "bank",
  "app",
  "hq",
  "inc",
  "ltd",
  "llc",
  "plc",
];

function titleCase(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function prettifyDomainRoot(root: string): string {
  // Domains sometimes already separate words for us.
  if (root.includes("-")) {
    return root.split("-").filter(Boolean).map(titleCase).join(" ");
  }
  for (const suffix of GLUED_SUFFIXES) {
    if (root.length > suffix.length + 2 && root.endsWith(suffix)) {
      const stem = root.slice(0, -suffix.length);
      return `${titleCase(stem)} ${titleCase(suffix)}`;
    }
  }
  return titleCase(root);
}

export function companyFromEmail(email?: string): string | undefined {
  if (!email || !email.includes("@")) return undefined;
  const domain = email.split("@")[1]?.toLowerCase();
  if (!domain || FREE_EMAIL_DOMAINS.has(domain)) return undefined;
  const root = domain.split(".")[0];
  if (!root) return undefined;
  return prettifyDomainRoot(root);
}

/**
 * Look for a job title in the last few lines of a message — the signature
 * block. This is the cheapest reliable authority signal available, and it
 * needs no enrichment vendor.
 */
const TITLE_HINTS = [
  "ceo",
  "cto",
  "cfo",
  "coo",
  "cmo",
  "founder",
  "co-founder",
  "cofounder",
  "owner",
  "president",
  "partner",
  "vp",
  "vice president",
  "head of",
  "director",
  "chief",
  "manager",
  "lead",
  "procurement",
  "buyer",
  "engineer",
  "analyst",
  "coordinator",
  "specialist",
  "consultant",
];

export function extractTitle(body: string): string | undefined {
  const lines = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  // Signatures live at the end. Scan the tail first, then anywhere as a
  // fallback for one-line chat messages like "I'm the Head of Ops here".
  const tail = lines.slice(-6);
  for (const line of [...tail].reverse()) {
    if (line.length > 90) continue;
    const lower = line.toLowerCase();
    if (TITLE_HINTS.some((hint) => lower.includes(hint))) {
      // Signature lines are often "Jane Doe, VP Engineering | Acme".
      const segment =
        line
          .split(/[|·•]/)
          .find((part) => TITLE_HINTS.some((h) => part.toLowerCase().includes(h))) ?? line;
      const cleaned = segment.replace(/^[-–—\s]+/, "").trim();
      return cleaned.length > 80 ? cleaned.slice(0, 80) : cleaned;
    }
  }
  return undefined;
}

/** Map a free-text title onto a seniority band used by the scoring engine. */
export function inferSeniority(title?: string): Seniority {
  if (!title) return "UNKNOWN";
  const t = title.toLowerCase();
  if (
    /\b(ceo|cto|cfo|coo|cmo|chief|founder|co-?founder|owner|president|partner)\b/.test(t)
  ) {
    return "EXEC";
  }
  if (/\b(vp|vice president|svp|evp)\b/.test(t)) return "VP";
  if (/\b(director|head of)\b/.test(t)) return "DIRECTOR";
  if (/\b(manager|lead|principal)\b/.test(t)) return "MANAGER";
  return "IC";
}

/**
 * Strip quoted history and signature noise before the message goes to the
 * scoring engine. Without this, a single "pricing" mention gets re-counted on
 * every reply in the thread.
 */
export function stripQuotedText(body: string): string {
  const lines = body.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    // "On Mon, 3 Jun 2026 at 14:02, Jane <jane@acme.com> wrote:"
    if (/^on .+wrote:$/i.test(trimmed)) break;
    // Outlook-style divider
    if (/^-{2,}\s*original message\s*-{2,}$/i.test(trimmed)) break;
    if (/^_{5,}$/.test(trimmed)) break;
    if (/^from:\s/i.test(trimmed) && out.length > 0) break;
    // Signature delimiter
    if (trimmed === "--" || trimmed === "-- ") break;
    if (trimmed.startsWith(">")) continue;
    out.push(line);
  }
  return out.join("\n").trim() || body.trim();
}

/** First N characters of the body, used as a subject for channels without one. */
export function synthesiseSubject(body: string, limit = 60): string {
  const firstLine = stripQuotedText(body).split(/\r?\n/)[0]?.trim() ?? "";
  if (!firstLine) return "(no subject)";
  return firstLine.length > limit ? `${firstLine.slice(0, limit).trimEnd()}…` : firstLine;
}

/** Normalise a phone number to digits with a leading +, for dedupe. */
export function normalisePhone(input?: string | null): string | undefined {
  if (!input) return undefined;
  const digits = input.replace(/[^\d+]/g, "");
  if (!digits) return undefined;
  return digits.startsWith("+") ? digits : `+${digits}`;
}

/** Email subjects accumulate Re:/Fwd: prefixes; strip them for thread matching. */
export function normaliseSubject(subject?: string | null): string {
  if (!subject) return "";
  return subject
    .replace(/^\s*((re|fw|fwd|aw|sv)\s*:\s*)+/i, "")
    .trim()
    .toLowerCase();
}

export function coerceDate(input: unknown): Date {
  if (input instanceof Date && !Number.isNaN(input.getTime())) return input;
  if (typeof input === "number") {
    // Slack sends epoch seconds as a float string/number.
    const ms = input > 1e12 ? input : input * 1000;
    const d = new Date(ms);
    if (!Number.isNaN(d.getTime())) return d;
  }
  if (typeof input === "string" && input.trim()) {
    const asNumber = Number(input);
    if (!Number.isNaN(asNumber) && input.includes(".")) {
      return coerceDate(asNumber);
    }
    const d = new Date(input);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}
