import { NextResponse } from "next/server";
import { authenticate } from "@/lib/auth";
import { apiError, handleRouteError, readBody } from "@/lib/api";
import { db } from "@/lib/db";
import {
  webhookEndpointJson,
  webhookEndpointWithPreview,
  webhookEventsProblem,
  webhookUrlProblem,
} from "@/lib/webhooks";
import { classifyTarget } from "@/lib/egress";

/**
 * One lookup, always filtered by workspace.
 *
 * The id alone is never enough: a cuid is not a capability. Every verb below uses
 * this, so a future handler cannot forget the scope and read a neighbour's
 * subscription.
 */
async function findEndpoint(workspaceId: string, id: string) {
  return db.webhookEndpoint.findFirst({ where: { id, workspaceId } });
}

/** GET /api/v1/webhooks/{id} — one subscription, secret as a preview only. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const workspace = await authenticate(request);
    const { id } = await params;
    const endpoint = await findEndpoint(workspace.id, id);
    if (!endpoint) return apiError("not_found", 404, "Webhook endpoint not found");

    return NextResponse.json({ endpoint: webhookEndpointWithPreview(endpoint) });
  } catch (error) {
    return handleRouteError(error);
  }
}

/**
 * PATCH /api/v1/webhooks/{id}
 *
 * Move a subscription to a new URL, change which events it receives, or silence
 * it without deleting it. Same validation as subscribing — a rule that only lived
 * in POST would let an edit downgrade an endpoint to plaintext HTTP.
 *
 * The signing secret does not rotate here. An endpoint that keeps its secret
 * across a URL change is the behaviour integrators expect from `whsec_`; rotation
 * needs its own verb, and until it exists this endpoint will not pretend.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const workspace = await authenticate(request);
    const { id } = await params;
    const body = await readBody(request);

    const endpoint = await findEndpoint(workspace.id, id);
    if (!endpoint) return apiError("not_found", 404, "Webhook endpoint not found");

    const data: Record<string, unknown> = {};

    if (body.url !== undefined) {
      const url = String(body.url).trim();
      const problem = webhookUrlProblem(url);
      if (problem) return apiError("invalid_request", 422, problem, { param: "url" });
      // Same refusal as POST when the patch repoints the endpoint.
      const target = await classifyTarget(url, "url");
      if (!target.ok) return apiError("invalid_request", 422, target.reason, { param: "url" });
      data.url = url;
    }

    if (body.events !== undefined) {
      if (!Array.isArray(body.events)) {
        return apiError("invalid_request", 422, "'events' must be a list of event names", {
          param: "events",
        });
      }
      const requested = body.events.map((e) => String(e).trim()).filter(Boolean);
      const problem = webhookEventsProblem(requested);
      if (problem) return apiError("invalid_request", 422, problem, { param: "events" });
      data.events = requested.join(",");
    }

    if (body.active !== undefined) {
      if (typeof body.active !== "boolean") {
        return apiError("invalid_request", 422, "'active' must be true or false", {
          param: "active",
        });
      }
      data.active = body.active;
    }

    if (Object.keys(data).length === 0) {
      return apiError("invalid_request", 422, "Nothing to update. Send url, events or active.");
    }

    const updated = await db.webhookEndpoint.update({ where: { id: endpoint.id }, data });
    return NextResponse.json({ endpoint: webhookEndpointJson(updated) });
  } catch (error) {
    return handleRouteError(error);
  }
}

/**
 * DELETE /api/v1/webhooks/{id}
 *
 * Unsubscribe. Until this existed, a subscription could be created and listed but
 * never removed — which meant a customer integrating us could not disconnect us.
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const workspace = await authenticate(request);
    const { id } = await params;
    const endpoint = await findEndpoint(workspace.id, id);
    if (!endpoint) return apiError("not_found", 404, "Webhook endpoint not found");

    await db.webhookEndpoint.delete({ where: { id: endpoint.id } });
    return NextResponse.json({ deleted: true, id: endpoint.id });
  } catch (error) {
    return handleRouteError(error);
  }
}