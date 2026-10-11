"use server";

import { revalidatePath } from "next/cache";
import { generateApiKey, type ApiKeyKind } from "@/lib/auth";
import { normaliseOrigins } from "@/lib/cors";
import { db } from "@/lib/db";
import { getSession } from "@/lib/session";
import { canManageRoles } from "@/lib/roles";

/**
 * API key management, driven from the integrations page.
 *
 * Three rules hold this file together:
 *
 * 1. Scope comes from the session, never from the form. The only workspace these
 *    actions can touch is the one the signed-in user is in, so there is no id
 *    for an attacker to swap out.
 * 2. A key is revealed exactly once. Only its sha256 is stored (see
 *    `generateApiKey` in lib/auth.ts), so the plaintext returned here exists in
 *    this response and nowhere else — not on the page, not in the database.
 * 3. The kind is chosen here and cannot be changed afterwards. A key that starts
 *    publishable must never be promotable into a secret one by editing a row,
 *    because the whole point is that its value is already printed in public code.
 */

export interface KeyState {
  error?: string;
  notice?: string;
  /** Present only in the response of the action that just created the key. */
  revealed?: { name: string; plaintext: string; kind: ApiKeyKind };
}

/** Enough for a production key, a staging key and a scratch one. */
const MAX_ACTIVE_KEYS = 10;
const MAX_NAME_LENGTH = 40;
const KINDS: readonly ApiKeyKind[] = ["SECRET", "PUBLISHABLE"];

/**
 * The session, if it may manage credentials.
 *
 * Reads with `getSession` rather than `requireSession` on purpose: inside a form
 * action a redirect to /login is a confusing non-answer, whereas a validation
 * error renders next to the button that caused it.
 */
async function authorise(): Promise<{ workspaceId: string } | { error: string }> {
  const session = await getSession();
  if (!session) return { error: "Your session has expired. Sign in again." };
  // The predicate is shared with the invite flow (lib/roles.ts), so "can this
  // seat mint a credential" and "can this seat invite a person" cannot drift
  // apart, and both are covered by the same check script.
  if (!canManageRoles(session.role)) {
    return { error: "Only an owner or admin can manage API keys." };
  }
  return { workspaceId: session.workspaceId };
}

export async function createApiKey(_previous: KeyState, formData: FormData): Promise<KeyState> {
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { error: "Give the key a name, so you know what it is in a year." };
  if (name.length > MAX_NAME_LENGTH) {
    return { error: `Keep the name to ${MAX_NAME_LENGTH} characters.` };
  }

  const kind = String(formData.get("kind") ?? "SECRET").toUpperCase() as ApiKeyKind;
  if (!KINDS.includes(kind)) {
    return { error: "Choose either a secret key or a publishable one." };
  }

  const asked = String(formData.get("origins") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const origins = kind === "PUBLISHABLE" ? normaliseOrigins(asked) : [];
  if (asked.length > 10) {
    return { error: "Keep a publishable key to 10 origins or fewer." };
  }
  if (asked.length !== origins.length) {
    return {
      error: "One of those origins could not be read. Use a full origin, like https://acme.com.",
    };
  }
  if (kind === "PUBLISHABLE" && origins.length === 0) {
    // Refused rather than stored empty: an allowlist of nothing is a key that no
    // browser can use, and the person who minted it would only find out from a
    // customer's complaint about a form that never sends.
    return {
      error: "A publishable key needs at least one origin, or no browser may use it at all.",
    };
  }

  const auth = await authorise();
  if ("error" in auth) return auth;

  const active = await db.apiKey.count({
    where: { workspaceId: auth.workspaceId, revokedAt: null },
  });
  if (active >= MAX_ACTIVE_KEYS) {
    return { error: `This workspace already has ${MAX_ACTIVE_KEYS} active keys. Revoke one first.` };
  }

  const { plaintext, hashedKey, prefix } = generateApiKey(kind);
  await db.apiKey.create({
    data: {
      workspaceId: auth.workspaceId,
      name,
      hashedKey,
      prefix,
      kind,
      allowedOrigins: origins.join(","),
    },
  });

  revalidatePath("/integrations");
  return { revealed: { name, plaintext, kind } };
}

export async function revokeApiKey(_previous: KeyState, formData: FormData): Promise<KeyState> {
  const id = String(formData.get("id") ?? "");
  if (!id) return { error: "No key was selected." };

  const auth = await authorise();
  if ("error" in auth) return auth;

  // The workspace filter is the whole security model: a key id from another
  // tenant simply does not match, so this cannot revoke anything you do not own,
  // and the identical message for both cases means it never reveals whether an
  // id belongs to somebody else.
  const revoked = await db.apiKey.updateMany({
    where: { id, workspaceId: auth.workspaceId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  if (revoked.count === 0) {
    return { error: "That key is not in your workspace, or it is already revoked." };
  }

  revalidatePath("/integrations");
  return { notice: "Key revoked. Anything still sending with it will start getting 401s." };
}
