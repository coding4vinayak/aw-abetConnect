/**
 * The OpenAPI 3.1 description of everything /api/v1 offers.
 *
 * Why a spec at all: a README is prose, and prose cannot be checked. This module is
 * TypeScript, so `npm run typecheck` catches a malformed schema, and
 * `scripts/check-contract.mjs` proves that every operation here has a route handler,
 * that every handler appears here, that every parameter claimed below is actually
 * read by the code serving it, and that every error code the routes can return is
 * listed. The spec is therefore an assertion about the source, not a description
 * somebody hoped was accurate.
 *
 * Enums are imported from the modules that enforce them, so a channel added to
 * lib/types.ts appears here in the same commit it starts working — and a channel
 * listed here alone fails the check.
 */
import { API_ERROR_CODES } from "./api";
import { BUCKETS, CHANNELS, INTENTS } from "./types";
import { WEBHOOK_EVENTS } from "./webhooks";

type Schema = Record<string, unknown>;

const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });

const media = (schema: Schema): Schema => ({
  content: { "application/json": { schema } },
});

const ok = (description: string, schema: Schema): Schema => ({ description, ...media(schema) });

/** Every failure is the same envelope. */
const fails = (description: string): Schema => ({ description, ...media(ref("Error")) });

const query = (name: string, schema: Schema, description: string): Schema => ({
  name,
  in: "query",
  description,
  required: false,
  schema,
});

const pathParam = (name: string, schema: Schema, description: string): Schema => ({
  name,
  in: "path",
  description,
  required: true,
  schema,
});

const stringEnum = (values: readonly string[]) => ({
  type: "string",
  enum: [...values],
});

const body = (required: string[], properties: Record<string, unknown>): Schema => ({
  required: true,
  content: {
    "application/json": {
      schema: { type: "object", required, properties },
    },
  },
});

const schemas: Record<string, Schema> = {
  Error: {
    type: "object",
    description:
      "The one envelope every non-2xx response uses. Branch on `code`; `message` is " +
      "written for a human and may be reworded without notice.",
    required: ["error"],
    properties: {
      error: {
        type: "object",
        required: ["code", "message"],
        properties: {
          code: {
            type: "string",
            enum: [...API_ERROR_CODES],
            description: "Stable machine-readable code; see the table in the README.",
          },
          message: { type: "string" },
          param: { type: "string", description: "The field at fault, when one field caused it." },
        },
      },
    },
  },

  Triage: {
    type: "object",
    description: "Why a conversation ranks where it ranks.",
    properties: {
      score: { type: "integer", minimum: 0, maximum: 100 },
      bucket: stringEnum(BUCKETS),
      intent: stringEnum(INTENTS),
      reason: { type: ["string", "null"] },
      engine: {
        type: "string",
        description:
          "Which scorer ran. Matters when a score looks wrong: it tells you which " +
          "system to go look at.",
      },
      estimatedValueCents: { type: ["integer", "null"] },
      currency: { type: ["string", "null"] },
      signals: {
        type: "array",
        items: {
          type: "object",
          properties: {
            kind: { type: "string" },
            label: { type: "string" },
            weight: { type: "number" },
            evidence: { type: ["string", "null"] },
          },
        },
      },
    },
  },

  Contact: {
    type: "object",
    properties: {
      id: { type: "string" },
      name: { type: ["string", "null"] },
      email: { type: ["string", "null"] },
      phone: { type: ["string", "null"] },
      company: { type: ["string", "null"] },
      title: { type: ["string", "null"] },
      seniority: { type: ["string", "null"] },
    },
  },
  ThreadSummary: {
    type: "object",
    description: "A row of the queue.",
    properties: {
      id: { type: "string" },
      subject: { type: ["string", "null"] },
      channel: stringEnum(CHANNELS),
      channels: { type: "array", items: stringEnum(CHANNELS) },
      score: { type: "integer" },
      bucket: stringEnum(BUCKETS),
      scoreReason: { type: ["string", "null"] },
      intent: { type: ["string", "null"] },
      status: { type: "string" },
      awaitingReply: { type: "boolean" },
      lastMessageAt: { type: "string", format: "date-time" },
      estimatedValueCents: { type: ["integer", "null"] },
      currency: { type: ["string", "null"] },
      messageCount: { type: "integer" },
      contact: ref("Contact"),
      preview: { type: ["string", "null"] },
    },
  },

  ThreadDetail: {
    allOf: [
      ref("ThreadSummary"),
      {
        type: "object",
        description: "The queue row plus the whole conversation, oldest message first.",
        properties: {
          signals: { type: "array", items: { type: "object" } },
          messages: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                direction: { type: "string", enum: ["INBOUND", "OUTBOUND"] },
                channel: stringEnum(CHANNELS),
                body: { type: "string" },
                sentAt: { type: "string", format: "date-time" },
              },
            },
          },
          draft: {
            type: ["object", "null"],
            properties: {
              id: { type: "string" },
              body: { type: "string" },
              intent: { type: ["string", "null"] },
              status: { type: "string" },
              generatedBy: { type: "string" },
            },
          },
        },
      },
    ],
  },

  Draft: {
    type: "object",
    properties: {
      id: { type: "string" },
      body: { type: "string" },
      intent: { type: ["string", "null"] },
      status: { type: "string", enum: ["SUGGESTED", "EDITED", "SENT", "DISCARDED"] },
      generatedBy: {
        type: "string",
        description: 'Which engine wrote it, or "human" when a rep typed it.',
      },
    },
  },

  IngestResult: {
    type: "object",
    description:
      "The thread a message landed in, already scored. A duplicate delivery of the " +
      "same message returns the same thread with `duplicate: true` and HTTP 200.",
    properties: {
      threadId: { type: "string" },
      messageId: { type: "string" },
      contactId: { type: "string" },
      duplicate: { type: "boolean" },
      draftId: { type: ["string", "null"] },
      triage: ref("Triage"),
    },
  },

  WebhookEndpoint: {
    type: "object",
    description:
      "A subscription. `secret` is returned once, by the call that creates it; after " +
      "that only `secretPreview`. Losing it means resubscribing, which is deliberate: " +
      "a read endpoint that hands back signing keys turns one leaked token into every " +
      "delivery you will ever send.",
    properties: {
      id: { type: "string" },
      url: { type: "string", format: "uri" },
      events: { type: "array", items: stringEnum(WEBHOOK_EVENTS) },
      active: { type: "boolean" },
      createdAt: { type: "string", format: "date-time" },
      secretPreview: { type: "string" },
    },
  },

  WebhookDelivery: {
    type: "object",
    description:
      "What abetConnect POSTs to your endpoint. Verify with HMAC-SHA256 over " +
      "`${x-abetconnect-timestamp}.${rawBody}`, compared against x-abetconnect-signature, " +
      "and reject deliveries whose timestamp is older than you are willing to replay. " +
      "The same delivery also carries `x-webhook-signature: sha256=<hex HMAC(secret, rawBody)>` — " +
      "the body-only generic spelling a nuCRM plugin webhook verifies natively.",
    properties: {
      id: {
        type: "string",
        description: "Stable across every endpoint for one logical event. Dedupe on it.",
      },
      event: stringEnum(WEBHOOK_EVENTS),
      timestamp: { type: "integer", description: "Seconds, and inside the signed string." },
      data: { type: "object" },
    },
  },
};
const paths: Record<string, Schema> = {
  "/api/v1/messages": {
    post: {
      operationId: "ingestMessage",
      summary: "Post a message from any channel and get back a scored thread",
      description:
        "`payload` is the provider's own shape and the matching adapter normalises it. " +
        "A pre-normalised message may be sent as the top-level body instead. Re-posting " +
        "a message the provider already delivered is answered with the original thread " +
        "and `duplicate: true`, so an at-least-once provider cannot double-count a lead.\n\n" +
        "This is the only endpoint a publishable key reaches, which is what makes it " +
        "usable from a website form: `abc_pub_` may post WEBFORM messages into the " +
        "workspace that minted it, from an allowlisted origin, never outbound, never " +
        "with a draft (drafting costs a model call, and a public key would otherwise " +
        "be a way to spend someone's LLM budget). It is throttled per address. " +
        "Cross-origin browser calls are supported: OPTIONS answers a preflight, and " +
        "responses echo the caller's origin when the key allows it.",
      security: [{ bearerAuth: [] }, { apiKeyHeader: [] }, { publishableIngest: [] }],
      requestBody: body(["channel"], {
        channel: { ...stringEnum(CHANNELS), description: "Which adapter parses `payload`." },
        payload: {
          type: "object",
          description: "Untouched provider body: SendGrid, Twilio, Slack, or your own form.",
        },
        direction: {
          type: "string",
          enum: ["INBOUND", "OUTBOUND"],
          description: "Defaults to INBOUND. OUTBOUND requires `threadId`.",
        },
        threadId: { type: "string" },
        skipDraft: {
          type: "boolean",
          description: "Backfills set this; a draft for a two-year-old message is noise.",
        },
      }),
      responses: {
        201: ok("Scored thread created", ref("IngestResult")),
        200: ok("Already ingested — the original result", ref("IngestResult")),
        401: fails("No API key, or one that does not resolve"),
        403: fails(
          "A publishable key posted a channel other than WEBFORM, or an outbound message, " +
            "or came from an origin the key does not list",
        ),
        422: fails("`channel` missing, or the payload could not be normalised"),
        429: {
          ...fails("Too many form submissions from this address for a publishable key"),
          description: "Too many form submissions from this address for a publishable key",
          headers: {
            "retry-after": {
              description: "Seconds to wait before this address may post again.",
              schema: { type: "integer" },
            },
            ratelimit: {
              description:
                'IETF RateLimit quota state, same reset moment as retry-after: e.g. "form-ingest";r=0;t=900.',
              schema: { type: "string" },
            },
            "ratelimit-policy": {
              description:
                'The quota behind it, e.g. "form-ingest";q=30;w=900 — 30 posts per 15 minutes per address.',
              schema: { type: "string" },
            },
          },
        },
      },
    },
  },

  "/api/v1/threads": {
    get: {
      operationId: "listThreads",
      summary: "The ranked queue",
      description:
        "Ordered awaiting-reply first, then score, then recency, then id — a total " +
        "order, so paging is deterministic. Filters combine with the cursor in one AND, " +
        "which is why `cursor` keeps working when `q` is set.",
      parameters: [
        query("bucket", stringEnum(BUCKETS), "Only this bucket."),
        query("intent", stringEnum(INTENTS), "Only this intent."),
        query(
          "status",
          { type: "string" },
          "Defaults to OPEN. A queue that shows closed threads is not a queue.",
        ),
        query("channel", stringEnum(CHANNELS), "Conversations that touched this channel."),
        query("awaitingReply", { type: "boolean" }, "The ball is in their court."),
        query("minScore", { type: "integer" }, "Drop everything below this score."),
        query("q", { type: "string" }, "Substring search across subject, contact and bodies."),
        query("limit", { type: "integer", minimum: 1, maximum: 200, default: 50 }, "Clamped."),
        query(
          "cursor",
          { type: "string" },
          "Opaque. Send back `nextCursor` from the previous page; null ends the walk.",
        ),
      ],
      responses: {
        200: ok("A page of the queue", {
          type: "object",
          properties: {
            threads: { type: "array", items: ref("ThreadSummary") },
            counts: {
              type: "object",
              description: "Open threads per bucket, unfiltered — the tab badges.",
              additionalProperties: { type: "integer" },
            },
            nextCursor: { type: ["string", "null"] },
          },
        }),
        401: fails("No API key"),
        422: fails("`cursor` is not one this server can honour"),
      },
    },
  },
  "/api/v1/threads/{id}": {
    get: {
      operationId: "getThread",
      summary: "One conversation with its signals and current draft",
      parameters: [pathParam("id", { type: "string" }, "Thread id.")],
      responses: {
        200: ok("The thread", { type: "object", properties: { thread: ref("ThreadDetail") } }),
        401: fails("No API key"),
        404: fails("No such thread in this workspace"),
      },
    },
    patch: {
      operationId: "updateThread",
      summary: "Status, snooze, or override the score",
      description:
        "The override matters. A rep who cannot correct the ranking stops trusting it, " +
        "and the corrections are the only honest training set for the next scorer.",
      parameters: [pathParam("id", { type: "string" }, "Thread id.")],
      requestBody: body([], {
        status: { type: "string", enum: ["OPEN", "SNOOZED", "WON", "LOST", "CLOSED"] },
        snoozedUntil: { type: "string", format: "date-time" },
        score: { type: "integer", minimum: 0, maximum: 100 },
        reason: { type: "string", description: "Why the human overrode the machine." },
      }),
      responses: {
        200: ok("Updated", { type: "object", properties: { thread: ref("ThreadDetail") } }),
        401: fails("No API key"),
        404: fails("No such thread"),
        422: fails("Nothing to update, or a field was out of range"),
      },
    },
  },

  "/api/v1/threads/{id}/draft": {
    post: {
      operationId: "generateDraft",
      summary: "Regenerate the suggested reply",
      parameters: [pathParam("id", { type: "string" }, "Thread id.")],
      responses: {
        201: ok("Draft written", { type: "object", properties: { draft: ref("Draft") } }),
        401: fails("No API key"),
        404: fails("No such thread"),
        409: fails("Nothing inbound to reply to"),
      },
    },
    patch: {
      operationId: "updateDraft",
      summary: "Save a rep's edits without sending",
      description:
        "The human-in-the-loop half of the product, and the reason a draft is an object " +
        "rather than a string in a text box.",
      parameters: [pathParam("id", { type: "string" }, "Thread id.")],
      requestBody: body(["body"], { body: { type: "string" } }),
      responses: {
        200: ok("Saved", { type: "object", properties: { draft: ref("Draft") } }),
        401: fails("No API key"),
        404: fails("No such thread"),
        422: fails("`body` was empty"),
      },
    },
  },

  "/api/v1/threads/{id}/reply": {
    post: {
      operationId: "sendReply",
      summary: "Record that a reply went out",
      description:
        "abetConnect does not send the message. You already have an email provider and a " +
        "WhatsApp number, and owning delivery would mean owning deliverability, " +
        "compliance and inbox reputation. The `reply.sent` webhook is where an " +
        "integration performs the actual send.",
      parameters: [pathParam("id", { type: "string" }, "Thread id.")],
      requestBody: body([], {
        body: { type: "string", description: "Omit to send the pending draft as-is." },
        channel: stringEnum(CHANNELS),
      }),
      responses: {
        201: ok("Recorded", { type: "object", properties: { thread: ref("ThreadDetail") } }),
        401: fails("No API key"),
        404: fails("No such thread"),
        422: fails("No draft pending and no `body` given"),
      },
    },
  },
  "/api/v1/webhooks": {
    get: {
      operationId: "listWebhookEndpoints",
      summary: "Subscriptions, with the event catalogue",
      responses: {
        200: ok("Endpoints", {
          type: "object",
          properties: {
            availableEvents: { type: "array", items: stringEnum(WEBHOOK_EVENTS) },
            endpoints: { type: "array", items: ref("WebhookEndpoint") },
          },
        }),
        401: fails("No API key"),
      },
    },
    post: {
      operationId: "createWebhookEndpoint",
      summary: "Subscribe an endpoint",
      description:
        "The signing secret is returned here once and never again. HTTPS is required; " +
        "localhost is exempt so a developer can point a webhook at their own machine.",
      requestBody: body(["url"], {
        url: { type: "string", format: "uri" },
        events: {
          type: "array",
          items: stringEnum(WEBHOOK_EVENTS),
          description: "Omit or send [] to receive everything, including events added later.",
        },
      }),
      responses: {
        201: ok("Subscribed", {
          type: "object",
          properties: {
            endpoint: ref("WebhookEndpoint"),
            secret: { type: "string" },
            verification: { type: "string" },
          },
        }),
        401: fails("No API key"),
        422: fails("`url` unusable or an event name we do not emit"),
      },
    },
  },

  "/api/v1/webhooks/{id}": {
    get: {
      operationId: "getWebhookEndpoint",
      summary: "One subscription",
      parameters: [pathParam("id", { type: "string" }, "Endpoint id.")],
      responses: {
        200: ok("Endpoint", {
          type: "object",
          properties: { endpoint: ref("WebhookEndpoint") },
        }),
        401: fails("No API key"),
        404: fails("No such endpoint in this workspace"),
      },
    },
    patch: {
      operationId: "updateWebhookEndpoint",
      summary: "Move, re-scope, or silence a subscription",
      description:
        "The same URL and event rules as subscribing, so an edit cannot leave an " +
        "endpoint in a state POST would have refused. The secret does not rotate.",
      parameters: [pathParam("id", { type: "string" }, "Endpoint id.")],
      requestBody: body([], {
        url: { type: "string", format: "uri" },
        events: { type: "array", items: stringEnum(WEBHOOK_EVENTS) },
        active: { type: "boolean", description: "false keeps the row and stops deliveries." },
      }),
      responses: {
        200: ok("Updated", { type: "object", properties: { endpoint: ref("WebhookEndpoint") } }),
        401: fails("No API key"),
        404: fails("No such endpoint"),
        422: fails("Nothing to update, or a field broke a rule"),
      },
    },
    delete: {
      operationId: "deleteWebhookEndpoint",
      summary: "Unsubscribe",
      parameters: [pathParam("id", { type: "string" }, "Endpoint id.")],
      responses: {
        200: ok("Gone", {
          type: "object",
          properties: { deleted: { type: "boolean" }, id: { type: "string" } },
        }),
        401: fails("No API key"),
        404: fails("No such endpoint"),
      },
    },
  },

  "/api/billing/checkout": {
    post: {
      operationId: "createBillingCheckout",
      summary: "Start a Stripe Checkout subscription",
      description:
        "Session-gated (browser buyer, not an API key). Returns the Stripe-hosted " +
        "URL to redirect to. Prices live in Stripe; the workspace is stamped on " +
        "the subscription metadata so the webhook can credit it.",
      requestBody: body(["priceId", "returnUrl"], {
        priceId: stringEnum(["SEAT_MONTHLY", "SEAT_ANNUAL"]),
        returnUrl: { type: "string", format: "uri" },
      }),
      responses: {
        200: ok("Checkout", {
          type: "object",
          properties: { url: { type: "string", format: "uri" } },
        }),
        401: fails("No session"),
        500: fails("Stripe not configured or unreachable"),
      },
    },
  },

  "/api/billing/portal": {
    post: {
      operationId: "createBillingPortal",
      summary: "Open the Stripe Customer Portal",
      description:
        "Session-gated. Plan changes, payment-method updates, and cancellation " +
        "happen on Stripe's hosted page; the webhook syncs the outcome back.",
      requestBody: body(["returnUrl"], {
        returnUrl: { type: "string", format: "uri" },
      }),
      responses: {
        200: ok("Portal", {
          type: "object",
          properties: { url: { type: "string", format: "uri" } },
        }),
        401: fails("No session"),
        500: fails("No Stripe customer for this workspace"),
      },
    },
  },

  "/api/billing/webhook": {
    post: {
      operationId: "receiveBillingWebhook",
      summary: "Stripe event receiver",
      security: [],
      description:
        "No API key and no session: authenticity comes from the Stripe signature " +
        "header, verified before anything else. Handles checkout completion, " +
        "subscription lifecycle, and failed payments.",
      responses: {
        200: ok("Received", {
          type: "object",
          properties: { received: { type: "boolean" } },
        }),
        400: fails("Invalid Stripe signature"),
      },
    },
  },

  "/api/v1/channels/{channel}/webhook": {
    post: {
      operationId: "receiveChannelWebhook",
      summary: "A URL to paste straight into the provider",
      security: [{ bearerAuth: [] }, { apiKeyHeader: [] }, { channelQueryKey: [] }],
      description:
        "Same pipeline as POST /api/v1/messages, with the channel taken from the path so " +
        "providers that cannot shape a JSON body still work. Slack's url_verification " +
        "challenge is echoed, and Slack's own bot messages are ignored so our replies are " +
        "not scored as leads.",
      parameters: [
        pathParam("channel", stringEnum(CHANNELS), "One of the channels we speak."),
        query(
          "key",
          { type: "string" },
          "API key, for providers that cannot set headers. Prefer the header: query " +
            "strings land in access logs and browser history.",
        ),
      ],
      responses: {
        200: ok(
          "Ingested, or the challenge echoed back",
          {
            type: "object",
            properties: {
              threadId: { type: "string" },
              duplicate: { type: "boolean" },
              score: { type: "integer" },
              bucket: stringEnum(BUCKETS),
              intent: stringEnum(INTENTS),
              challenge: { type: "string" },
              ignored: { type: "string" },
            },
          },
        ),
        401: fails("No key, or a key that does not resolve"),
        404: fails("That channel does not exist"),
        422: fails("The body could not be normalised for this channel"),
      },
    },
    get: {
      operationId: "verifyChannelWebhook",
      summary: "Handshake — proves the URL is live",
      security: [],
      description:
        "Some providers GET the URL before they will send events. No authentication: this " +
        "reveals only that a channel name is one we support.",
      parameters: [pathParam("channel", stringEnum(CHANNELS), "Channel being verified.")],
      responses: {
        200: ok(
          "We speak this channel",
          { type: "object", properties: { ok: { type: "boolean" }, channel: stringEnum(CHANNELS) } },
        ),
        404: fails("Unknown channel"),
      },
    },
  },

  "/api/health": {
    get: {
      operationId: "getHealth",
      summary: "Liveness probe with a database ping",
      description:
        "Unauthenticated: a load balancer cannot hold an API key. A 200 means " +
        "this instance can serve traffic; a 503 means the database is unreachable.",
      security: [],
      responses: {
        200: ok("Healthy", {
          type: "object",
          properties: {
            ok: { type: "boolean" },
            db: { type: "string" },
            time: { type: "string", format: "date-time" },
          },
        }),
        503: fails("The database did not answer"),
      },
    },
  },

  "/api/auth/send-verification": {
    post: {
      operationId: "sendVerificationEmail",
      summary: "Resend the verification email to the current user",
      description:
        "Requires an active session. The user must not already be verified.",
      responses: {
        200: ok("Verification email sent", {
          type: "object",
          properties: {
            ok: { type: "boolean" },
            sent: { type: "boolean" },
            alreadyVerified: { type: "boolean" },
          },
        }),
        401: fails("No active session"),
        404: fails("User not found"),
      },
    },
  },

  "/api/auth/verify-email": {
    get: {
      operationId: "verifyEmail",
      summary: "Consume an email verification token",
      description:
        "Public endpoint. Marks the user's email as verified and returns an HTML page.",
      security: [],
      parameters: [
        {
          name: "token",
          in: "query",
          required: true,
          schema: { type: "string" },
          description: "The verification token sent by email.",
        },
      ],
      responses: {
        200: {
          description: "Email verified — HTML page with success message",
          content: { "text/html": { schema: { type: "string" } } },
        },
        400: {
          description: "Invalid or expired token — HTML page with error",
          content: { "text/html": { schema: { type: "string" } } },
        },
      },
    },
  },

  "/api/auth/forgot-password": {
    post: {
      operationId: "requestPasswordReset",
      summary: "Request a password reset email",
      description:
        "Public endpoint. Always returns 200 to prevent email enumeration. The reset email is sent if the account exists.",
      security: [],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["email"],
              properties: {
                email: { type: "string", format: "email", description: "The account email address." },
              },
            },
          },
        },
      },
      responses: {
        200: ok("Reset email sent (if account exists)", { type: "object", properties: { ok: { type: "boolean" } } }),
        422: fails("Invalid email"),
        429: {
          ...fails("Too many reset requests. Try again later."),
          description: "Too many reset requests from this address",
          headers: {
            "retry-after": {
              description: "Seconds to wait before this address may request again.",
              schema: { type: "integer" },
            },
          },
        },
      },
    },
  },

  "/api/auth/reset-password": {
    post: {
      operationId: "resetPassword",
      summary: "Consume a reset token and set a new password",
      description:
        "Public endpoint. Consumes the token from the reset email and sets a new password.",
      security: [],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["token", "password"],
              properties: {
                token: { type: "string", description: "The reset token from the email link." },
                password: { type: "string", minLength: 8, description: "New password (min 8 chars)." },
              },
            },
          },
        },
      },
      responses: {
        200: ok("Password reset", { type: "object", properties: { ok: { type: "boolean" } } }),
        422: fails("Invalid or expired token, or password too short"),
      },
    },
  },

  "/api/v1/openapi": {
    get: {
      operationId: "getOpenApiSpec",
      summary: "This document",
      description:
        "Machine-readable, and the input to the contract check that runs in CI. Public: an " +
        "integrator evaluates the API before they are allowed to hold a key.",
      security: [],
      responses: {
        200: ok("The OpenAPI 3.1 document", { type: "object" }),
      },
    },
  },
};

 /**
 * The document. `info.version` is asserted against package.json by
 * scripts/check-contract.mjs, because a spec that claims a version the build does
 * not carry is the same category of lie as a parameter the route never reads.
 */
export const openapiSpec = {
  openapi: "3.1.0",
  info: {
    title: "abetConnect",
    version: "0.1.0",
    description:
      "Six channels in, one ranked queue out. Everything the dashboard can do is here: " +
      "the product is the API, and the inbox is a client of it.\n\n" +
      "Auth is a workspace key in `Authorization: Bearer abc_live_…`, or the same key in " +
      "`x-api-key`. Keys are stored hashed and are scoped to one workspace — a key never " +
      "sees another tenant's threads.\n\n" +
      "A second kind exists for browser code: `abc_pub_`, a publishable key, reaches " +
      "`POST /api/v1/messages` and nothing else. Anywhere else it is refused with 403 " +
      "`permission_error`, which is the whole reason it is safe to put in a page.",
    // No termsOfService or contact block: neither repo documents a terms page or a
    // support address, and a spec that publishes a URL nobody owns is the same
    // mistake as a parameter the route never reads.
  },
  // The app is served from its own origin, so paths are relative rather than a host
  // this file has no business asserting. The deployment's URL goes here at release.
  servers: [{ url: "/", description: "The deployment serving the dashboard." }],
  tags: [
    { name: "Ingest", description: "Getting messages in." },
    { name: "Queue", description: "Reading and acting on scored threads." },
    { name: "Webhooks", description: "Getting events out." },
    { name: "Discovery", description: "This document, and the provider handshake." },
  ],
  security: [{ bearerAuth: [] }, { apiKeyHeader: [] }],
  paths,
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "abc_live_…",
        description:
          "Workspace API key. Shown once at creation; only its hash is stored. This is the " +
          "secret kind: it reaches every endpoint, so it belongs on a server, never in a page.",
      },
      publishableIngest: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "abc_pub_…",
        description:
          "Browser-safe key, minted under Integrations with the origins allowed to use it. It " +
          "may post a WEBFORM message into its own workspace and nothing else: no reads, no " +
          "outbound, no draft, and a per-address rate limit. An `Origin` header is checked " +
          "against the key's allowlist when present; a server-to-server call sends none and " +
          "is unaffected by it.",
      },
      apiKeyHeader: {
        type: "apiKey",
        in: "header",
        name: "x-api-key",
        description: "Same key, for clients that cannot set Authorization.",
      },
      channelQueryKey: {
        type: "apiKey",
        in: "query",
        name: "key",
        description:
          "Only accepted on channel webhook endpoints, where the provider controls the " +
          "request. Prefer a header: query strings are logged by every proxy between here " +
          "and there.",
      },
    },
    schemas,
  },
} as const;

export type OpenApiSpec = typeof openapiSpec;
