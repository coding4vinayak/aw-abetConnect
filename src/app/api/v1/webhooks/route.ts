import { NextResponse } from "next/server";
import { authenticate } from "@/lib/auth";
import { apiError, handleRouteError, readBody } from "@/lib/api";
import { db } from "@/lib/db";
import {
  WEBHOOK_EVENTS,
  generateWebhookSecret,
  webhookEndpointJson,
  webhookEndpointWithPreview,
  webhookEventsProblem,
  webhookUrlProblem,
} from "@/lib/webhooks";
import { classifyTarget } from "@/lib/egress";

/** GET /api/v1/webhooks — list endpoints. Secrets are never returned in full. */
export async function GET(request: Request) {
  try {
    const workspace = await authenticate(request);
    const endpoints = await db.webhookEndpoint.findMany({
      where: { workspaceId: workspace.id },
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json({
      availableEvents: [...WEBHOOK_EVENTS],
      endpoints: endpoints.map(webhookEndpointWithPreview),
    });
  } catch (error) {
    return handleRouteError(error);
  }
}

/**
 * POST /api/v1/webhooks
 *
 * Subscribe an endpoint. The signing secret is returned once, here, and never
 * again — verify deliveries with HMAC-SHA256 over `{timestamp}.{body}`, both sent
 * as headers (`x-abetconnect-timestamp`, `x-abetconnect-signature`). Deliveries
 * also carry `x-webhook-signature: sha256=<hex HMAC(secret, rawBody)>`, the
 * generic spelling a nuCRM plugin webhook verifies natively.
 */
export async function POST(request: Request) {
  try {
    const workspace = await authenticate(request);
    const body = await readBody(request);

    const url = String(body.url ?? "").trim();
    const urlProblem = webhookUrlProblem(url);
    if (urlProblem) return apiError("invalid_request", 422, urlProblem, { param: "url" });

    const requested = Array.isArray(body.events)
      ? body.events.map((e) => String(e).trim()).filter(Boolean)
      : [];
    const eventsProblem = webhookEventsProblem(requested);
    if (eventsProblem) {
      return apiError("invalid_request", 422, eventsProblem, { param: "events" });
    }

    // The destination is refused here when it names an internal address — the
    // same rule `assertAllowedTarget` enforces immediately above the delivery
    // fetch — so an endpoint that could never deliver is not stored. The
    // documented local override (ABET_ALLOW_PRIVATE_TARGETS=1) still applies.
    const target = await classifyTarget(url, "url");
    if (!target.ok) return apiError("invalid_request", 422, target.reason, { param: "url" });

    const secret = generateWebhookSecret();
    const endpoint = await db.webhookEndpoint.create({
      data: {
        workspaceId: workspace.id,
        url,
        // Empty string means "all events", including ones added later.
        events: requested.join(","),
        secret,
      },
    });

    return NextResponse.json(
      {
        endpoint: webhookEndpointJson(endpoint),
        // Shown once.
        secret,
        verification: "HMAC-SHA256 of `{x-abetconnect-timestamp}.{raw body}`",
      },
      { status: 201 },
    );
  } catch (error) {
    return handleRouteError(error);
  }
}