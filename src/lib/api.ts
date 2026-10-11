import { NextResponse } from "next/server";
import { AuthError } from "./auth";
import { AdapterError } from "./channels/adapters";

/**
 * Machine-readable error codes.
 *
 * `message` is written for a person and is free to be reworded; `code` is what an
 * integration branches on, so it is a promise. A consumer that has to match on the
 * English cannot upgrade anything: the day somebody improves a sentence, every
 * `if (msg.includes("required"))` in their codebase breaks at once and silently.
 *
 * Only codes something here can actually return are listed. A catalogue of states
 * the server never sends is worse than none, because somebody will write a handler
 * for the one they needed and never find out it was unreachable.
 */
export const API_ERROR_CODES = [
  /** No credential, or one that no longer resolves. */
  "authentication_error",
  /** The credential resolves, and simply does not reach this far. */
  "permission_error",
  /** Too much from this address for the kind of key that was used. */
  "rate_limit_error",
  /** The request was well-formed but the content was not. */
  "invalid_request",
  /** A `cursor` this server cannot honour — expired, malformed, or from another query. */
  "invalid_cursor",
  /** A channel segment in the URL that is not a channel we speak. */
  "unknown_channel",
  /** The object named in the path does not exist in this workspace. */
  "not_found",
  /** The object exists but its state forbids the action. */
  "conflict",
  /** Ours. Safe to retry; the message will not be more specific, on purpose. */
  "internal_error",
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

/**
 * The envelope, uniform for every failure the API returns:
 *
 *   { "error": { "code": "invalid_request", "message": "…", "param": "channel" } }
 *
 * `param` names the field at fault when there is one, so a client can put the
 * message next to the right input instead of guessing from the prose.
 */
export function apiError(
  code: ApiErrorCode,
  status: number,
  message: string,
  extra?: Record<string, unknown>,
) {
  return NextResponse.json({ error: { code, message, ...extra } }, { status });
}

export function handleRouteError(error: unknown) {
  if (error instanceof AuthError) return apiError(error.code, error.status, error.message);
  if (error instanceof AdapterError) return apiError("invalid_request", 422, error.message);
  console.error("[api] unhandled error:", error);
  return apiError("internal_error", 500, "Internal error");
}

/**
 * Read a request body as JSON, tolerating the form-encoded payloads that
 * Twilio and several email providers send. Channel webhooks are not a place
 * where we get to insist on a content type.
 */
export async function readBody(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    try {
      const parsed = await request.json();
      if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
      return {};
    } catch {
      throw new AdapterError("Request body is not valid JSON");
    }
  }

  if (
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data")
  ) {
    const form = await request.formData();
    const out: Record<string, unknown> = {};
    for (const [key, value] of form.entries()) {
      out[key] = typeof value === "string" ? value : value.name;
    }
    return out;
  }

  // No content type at all: try JSON, then give up with a useful message.
  const text = await request.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new AdapterError(
      `Unsupported content-type '${contentType || "none"}'. Send JSON or form-encoded data.`,
    );
  }
}
