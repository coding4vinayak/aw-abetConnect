import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { ApiErrorCode } from "./api";
import { matchedOrigin } from "./cors";
import { db } from "./db";

export type ApiKeyKind = "SECRET" | "PUBLISHABLE";

/**
 * Two prefixes, because the honest difference between "keep this in your server"
 * and "put this in your website" should be visible in the string itself. Someone
 * reading a leaked `abc_pub_` key can tell at a glance what it can do; someone
 * reading `abc_live_` knows they have to rotate it.
 */
export const KEY_PREFIXES: Record<ApiKeyKind, string> = {
  SECRET: "abc_live_",
  PUBLISHABLE: "abc_pub_",
};

export interface AuthedWorkspace {
  id: string;
  name: string;
  slug: string;
  sellsWhat: string | null;
  apiKeyId: string;
  kind: ApiKeyKind;
  /** Comma-separated origins, only meaningful for a publishable key. */
  allowedOrigins: string;
}

export function hashKey(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

/** Generate a key. The plaintext is returned once and never persisted. */
export function generateApiKey(
  kind: ApiKeyKind = "SECRET",
): { plaintext: string; hashedKey: string; prefix: string } {
  const keyPrefix = KEY_PREFIXES[kind];
  const plaintext = `${keyPrefix}${randomBytes(24).toString("base64url")}`;
  return {
    plaintext,
    hashedKey: hashKey(plaintext),
    prefix: plaintext.slice(0, keyPrefix.length + 6),
  };
}

function extractToken(request: Request): string | undefined {
  const header = request.headers.get("authorization");
  if (header?.toLowerCase().startsWith("bearer ")) {
    return header.slice(7).trim() || undefined;
  }
  // Webhook providers frequently cannot set an Authorization header, so a
  // header-or-query fallback is a practical necessity for channel endpoints.
  const alt = request.headers.get("x-api-key");
  if (alt?.trim()) return alt.trim();
  return undefined;
}

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status = 401,
    /**
     * Defaults to the 401 story, because that is what a missing or dead key is. A
     * 403 from here means the key is valid and simply does not reach this far.
     */
    readonly code: ApiErrorCode = "authentication_error",
  ) {
    super(message);
    this.name = "AuthError";
  }
}

export interface AuthenticateOptions {
  /**
   * Only POST /api/v1/messages sets this, and it has to be said out loud. The whole
   * value of a publishable key is that it cannot read anything, so "publishable
   * keys are allowed" must be a decision each endpoint makes rather than a
   * permission a new endpoint inherits by forgetting to opt out.
   */
  allowPublishable?: boolean;
}

/**
 * Resolve the workspace for a request from its API key.
 *
 * Lookup is by hash, so a database leak does not hand over working keys.
 */
export async function authenticate(
  request: Request,
  options: AuthenticateOptions = {},
): Promise<AuthedWorkspace> {
  const token = extractToken(request);
  if (!token) {
    throw new AuthError("Missing API key. Send 'Authorization: Bearer <key>'.");
  }

  const record = await db.apiKey.findUnique({
    where: { hashedKey: hashKey(token) },
    include: { workspace: true },
  });

  if (!record || record.revokedAt) {
    throw new AuthError("Invalid or revoked API key.");
  }

  // Constant-time confirmation of the hash we just looked up by. Redundant
  // given the unique index, but cheap and keeps the comparison path uniform.
  const expected = Buffer.from(record.hashedKey);
  const actual = Buffer.from(hashKey(token));
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new AuthError("Invalid API key.");
  }

  // Anything that is not exactly "SECRET" is treated as the weaker kind, so a
  // corrupt or hand-edited row cannot accidentally mint a full-access key.
  const kind: ApiKeyKind = record.kind === "SECRET" ? "SECRET" : "PUBLISHABLE";

  if (kind === "PUBLISHABLE") {
    if (!options.allowPublishable) {
      throw new AuthError(
        "This endpoint needs a secret key. A publishable key (abc_pub_) may only post messages to POST /api/v1/messages.",
        403,
        "permission_error",
      );
    }
    // A browser sends Origin on a cross-origin request and cannot choose it, which
    // is what makes an allowlist meaningful here. A server-to-server call has no
    // Origin at all and is not restricted by it — a publishable key is already
    // public, so the list exists to stop *another site* posting as this one, not to
    // keep the key secret from someone who already has it.
    const origin = request.headers.get("origin")?.trim();
    if (origin) {
      if (!record.allowedOrigins.trim()) {
        throw new AuthError(
          "This publishable key has no allowed origins, so no browser may use it. Add the site's origin under Integrations.",
          403,
          "permission_error",
        );
      }
      if (!matchedOrigin(request, record.allowedOrigins)) {
        throw new AuthError(
          `Origin '${origin}' is not allowed for this publishable key.`,
          403,
          "permission_error",
        );
      }
    }
  }

  // Fire-and-forget: last-used tracking must never delay ingest.
  void db.apiKey
    .update({ where: { id: record.id }, data: { lastUsedAt: new Date() } })
    .catch(() => undefined);

  return {
    id: record.workspace.id,
    name: record.workspace.name,
    slug: record.workspace.slug,
    sellsWhat: record.workspace.sellsWhat,
    apiKeyId: record.id,
    kind,
    allowedOrigins: record.allowedOrigins,
  };
}

// Note on where dashboard scoping lives: an API request authenticates by key
// (`authenticate` above), while a browser request authenticates by session
// cookie (`requireSession` in session.ts). The two paths are kept in separate
// files on purpose, so a future edit cannot let one credential type stand in
// for the other.
