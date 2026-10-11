import { NextResponse } from "next/server";
import { authenticate, type AuthedWorkspace } from "@/lib/auth";
import { apiError, handleRouteError, readBody } from "@/lib/api";
import { AdapterError, getAdapter } from "@/lib/channels/adapters";
import { corsHeaders, preflightAny } from "@/lib/cors";
import { ingestMessage } from "@/lib/ingest";
import { isChannel, CHANNELS } from "@/lib/types";
import {
  MAX_PUBLISHABLE_INGESTS,
  PUBLISHABLE_WINDOW_SECS,
  clientAddress,
  gate,
  publishableIngestKey,
  tally,
} from "@/lib/throttle";

/**
 * POST /api/v1/messages
 *
 * The one endpoint that matters for integration. Post a message from any
 * channel and get back a scored thread.
 *
 *   {
 *     "channel": "EMAIL",
 *     "payload": { "from": "Jane Doe <jane@acme.com>", "subject": "...", "text": "..." }
 *   }
 *
 * `payload` is the provider's own shape — the matching adapter normalises it.
 * A pre-normalised message can be sent directly instead of `payload`.
 *
 * This is also the only endpoint a publishable key (`abc_pub_`) can reach, which is
 * what lets a customer's website post an enquiry without shipping a secret key to
 * every visitor who loads the page. The rules that make that safe sit below, next
 * to the code that enforces them.
 */
export async function OPTIONS(request: Request) {
  return preflightAny(request);
}

export async function POST(request: Request) {
  let workspace: AuthedWorkspace;
  try {
    workspace = await authenticate(request, { allowPublishable: true });
  } catch (error) {
    // Before a key resolves there is no allowlist to echo against, so a browser
    // sees this as a failed fetch rather than a readable 401. The same request in
    // curl shows the body, and nothing about a credential is safe to reflect.
    return handleRouteError(error);
  }

  // From here the workspace is known, so every response — including the refusals —
  // can carry the headers a browser needs to read it. A cross-origin form that gets
  // an unreadable 422 is indistinguishable from a server that is down.
  const cors: Record<string, string> =
    workspace.kind === "PUBLISHABLE" ? corsHeaders(request, workspace.allowedOrigins) : {};
  const withCors = <T extends Response>(response: T): T => {
    for (const [name, value] of Object.entries(cors)) response.headers.set(name, value);
    return response;
  };

  try {
    const body = await readBody(request);

    const channel = String(body.channel ?? "").toUpperCase();
    if (!isChannel(channel)) {
      return withCors(
        apiError(
          "invalid_request",
          422,
          `'channel' is required and must be one of: ${CHANNELS.join(", ")}`,
          { param: "channel" },
        ),
      );
    }

    const payload =
      body.payload && typeof body.payload === "object"
        ? (body.payload as Record<string, unknown>)
        : body;

    const adapter = getAdapter(channel);
    const normalized = adapter.normalize(payload);

    // Allow an explicit direction override so reps' own sent messages can be
    // logged through the same endpoint. Outbound needs a threadId, since the
    // sender of our own reply is us, not the prospect.
    const direction = String(body.direction ?? "").toUpperCase();
    if (direction === "OUTBOUND") normalized.direction = "OUTBOUND";

    const threadId = typeof body.threadId === "string" ? body.threadId : undefined;
    if (normalized.direction === "OUTBOUND" && !threadId) {
      return withCors(
        apiError(
          "invalid_request",
          422,
          "'threadId' is required for outbound messages. Prefer POST /api/v1/threads/{id}/reply.",
          { param: "threadId" },
        ),
      );
    }

    let skipDraft = body.skipDraft === true;

    if (workspace.kind === "PUBLISHABLE") {
      // A key printed into a public bundle is not a secret, so the door it opens has
      // a shape: a web form, into the workspace that minted it. Not EMAIL or SMS,
      // because a stranger could inject a conversation that outranks a real one in
      // someone's queue and fire their CRM webhooks doing it. Not outbound either —
      // a threadId is a way of talking inside somebody else's conversation.
      if (channel !== "WEBFORM") {
        return withCors(
          apiError(
            "permission_error",
            403,
            "A publishable key may only post WEBFORM messages. Another channel needs the secret key.",
            { param: "channel" },
          ),
        );
      }
      if (normalized.direction === "OUTBOUND") {
        return withCors(
          apiError("permission_error", 403, "A publishable key cannot record outbound messages.", {
            param: "direction",
          }),
        );
      }

      // Drafting costs a model call per message. Without this, one visitor holding
      // the public key and a for loop spends the workspace's LLM budget on junk.
      skipDraft = true;

      const bucket = publishableIngestKey(await clientAddress());
      const allowance = await gate(bucket);
      if (!allowance.allowed) {
        // Standard quota headers (IETF RateLimit fields) alongside Retry-After,
        // referencing the same reset moment: a form integration that backs off
        // on these never has to guess. Retry-After takes precedence per the spec.
        const retryAfterSecs = allowance.retryAfterMinutes * 60;
        const refused = apiError(
          "rate_limit_error",
          429,
          `Too many form submissions from this address. Try again in ${allowance.retryAfterMinutes} minute(s).`,
        );
        refused.headers.set("retry-after", String(retryAfterSecs));
        refused.headers.set("ratelimit", `"form-ingest";r=0;t=${retryAfterSecs}`);
        refused.headers.set(
          "ratelimit-policy",
          `"form-ingest";q=${MAX_PUBLISHABLE_INGESTS};w=${PUBLISHABLE_WINDOW_SECS}`,
        );
        return withCors(refused);
      }
      await tally(bucket, MAX_PUBLISHABLE_INGESTS);
    }

    const result = await ingestMessage(workspace, normalized, {
      skipDraft,
      threadId,
    });

    return withCors(
      NextResponse.json(
        {
          threadId: result.threadId,
          messageId: result.messageId,
          contactId: result.contactId,
          duplicate: result.duplicate,
          draftId: result.draftId ?? null,
          triage: {
            score: result.triage.score,
            bucket: result.triage.bucket,
            intent: result.triage.intent,
            reason: result.triage.reason,
            engine: result.triage.engine,
            estimatedValueCents: result.triage.estimatedValueCents ?? null,
            currency: result.triage.currency ?? null,
            signals: result.triage.signals,
          },
        },
        { status: result.duplicate ? 200 : 201 },
      ),
    );
  } catch (error) {
    if (error instanceof AdapterError)
      return withCors(apiError("invalid_request", 422, error.message));
    return withCors(handleRouteError(error));
  }
}