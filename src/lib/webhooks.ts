import { createHmac, randomBytes } from "node:crypto";
import { db } from "./db";
import { assertAllowedTarget } from "./egress";

/**
 * Outbound webhooks — the seam that makes this composable.
 *
 * Sold on its own, abetConnect is a triage inbox. Bolted onto something else,
 * it becomes the scoring layer feeding a CRM, a dialer, or the rest of a suite.
 * That difference is entirely these events.
 *
 * The list lives here and nowhere else. It used to be duplicated as a string
 * array in the route that validated subscriptions, which is how a documented
 * event and an accepted event quietly stop being the same set.
 */
export const WEBHOOK_EVENTS = [
  "thread.created",
  "thread.scored",
  "thread.hot",
  "thread.at_risk",
  "draft.created",
  "reply.sent",
] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

/** Empty/absent `events` on an endpoint means "everything", including later additions. */
export function subscribes(endpointEvents: string, event: WebhookEvent): boolean {
  if (!endpointEvents.trim()) return true;
  return endpointEvents
    .split(",")
    .map((s) => s.trim())
    .includes(event);
}

/**
 * One rule for both subscribing and editing, so PATCH cannot accept a URL that
 * POST would have refused. Receivers must be HTTPS; localhost stays open so a
 * developer can point a webhook at their own machine.
 *
 * Returns the reason to show the caller, or null when the URL is usable.
 */
export function webhookUrlProblem(raw: string): string | null {
  if (!raw) return "'url' is required";
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return "'url' must be a valid absolute URL";
  }
  if (parsed.protocol !== "https:" && parsed.hostname !== "localhost") {
    return "Webhook URLs must use HTTPS";
  }
  return null;
}

/** Same, for the event list. Empty means "all events" and is valid. */
export function webhookEventsProblem(requested: string[]): string | null {
  const invalid = requested.filter((e) => !(WEBHOOK_EVENTS as readonly string[]).includes(e));
  if (invalid.length === 0) return null;
  return `Unknown events: ${invalid.join(", ")}. Valid events: ${WEBHOOK_EVENTS.join(", ")}`;
}

export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(24).toString("base64url")}`;
}

/**
 * Sign a delivery the way Stripe does: HMAC-SHA256 over `{timestamp}.{body}`,
 * with the timestamp inside the signed string so a captured delivery cannot be
 * replayed forever. Receivers must check the timestamp themselves — a valid
 * signature only proves who wrote it, not when.
 */
export function signPayload(secret: string, body: string, timestamp: number): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

/**
 * The same key signing only the body — the generic spelling, sent alongside
 * the Stripe-style one on every delivery.
 *
 * `sha256=<hex HMAC(secret, rawBody)>` is GitHub's convention and, more to the
 * point here, exactly what an inbound nuCRM plugin webhook verifies. Pointing
 * one at `/api/tenant/plugins/webhook/{id}` with this endpoint's secret accepts
 * abetConnect deliveries with no adapter between the products. It is a second
 * header on the same request, not a replacement: the `x-abetconnect-signature`
 * above stays byte-identical for receivers that already verify it.
 *
 * The generic digest has no timestamp inside it. nuCRM checks freshness only
 * when a delivery carries `x-webhook-timestamp`, and this one does not — which
 * is the right answer for a fire-and-forget sender whose receiver should apply
 * its own replay window (or verify the Stripe-style pair instead).
 */
export function signBody(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

/**
 * Deliver an event to every subscribed endpoint.
 *
 * Deliberately fire-and-forget with a short timeout: a customer's broken webhook
 * receiver must never make their inbox stop ingesting. A production deployment
 * would put this on a queue with retries; the contract here is already the right
 * one for that upgrade.
 *
 * `id` is stable across every endpoint for one logical event, so a receiver that
 * dedupes on it is already correct on the day delivery grows retries.
 */
/**
 * The public shape of a subscription. `secret` is never in here — it is returned
 * once, at creation, and afterwards only a preview you can match against the one
 * you stored.
 */
export function webhookEndpointJson(endpoint: {
  id: string;
  url: string;
  events: string;
  active: boolean;
  createdAt: Date;
}) {
  return {
    id: endpoint.id,
    url: endpoint.url,
    events: endpoint.events
      ? endpoint.events.split(",").map((s) => s.trim())
      : [...WEBHOOK_EVENTS],
    active: endpoint.active,
    createdAt: endpoint.createdAt.toISOString(),
  };
}

/** Same, for reads that are allowed to reveal which secret this endpoint signs with. */
export function webhookEndpointWithPreview(
  endpoint: { id: string; url: string; events: string; active: boolean; createdAt: Date; secret: string },
) {
  return { ...webhookEndpointJson(endpoint), secretPreview: `${endpoint.secret.slice(0, 12)}…` };
}

export async function dispatch(
  workspaceId: string,
  event: WebhookEvent,
  data: unknown,
): Promise<void> {
  let endpoints;
  try {
    endpoints = await db.webhookEndpoint.findMany({
      where: { workspaceId, active: true },
    });
  } catch (error) {
    console.warn("[webhooks] could not load endpoints:", error);
    return;
  }

  const subscribed = endpoints.filter((e) => subscribes(e.events, event));
  if (subscribed.length === 0) return;

  const timestamp = Math.floor(Date.now() / 1000);
  const id = `evt_${randomBytes(12).toString("base64url")}`;
  const body = JSON.stringify({ id, event, timestamp, data });

  await Promise.allSettled(
    subscribed.map(async (endpoint) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5_000);
      try {
        // The stored URL was classified at write time; this is the address DNS
        // answers with right now — judged per delivery, like every other
        // sender in the suite. A refusal lands in the catch below as a failed
        // delivery, the same shape a connection error takes.
        await assertAllowedTarget(endpoint.url, "url");
        const res = await fetch(endpoint.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-abetconnect-event": event,
            "x-abetconnect-event-id": id,
            "x-abetconnect-timestamp": String(timestamp),
            "x-abetconnect-signature": signPayload(endpoint.secret, body, timestamp),
            // The body-only digest under the generic name — what a nuCRM
            // plugin webhook verifies natively. See signBody.
            "x-webhook-signature": `sha256=${signBody(endpoint.secret, body)}`,
          },
          body,
          signal: controller.signal,
        });
        if (!res.ok) {
          console.warn(`[webhooks] ${endpoint.url} responded ${res.status} for ${event}`);
        }
      } catch (error) {
        console.warn(
          `[webhooks] delivery to ${endpoint.url} failed:`,
          error instanceof Error ? error.message : error,
        );
      } finally {
        clearTimeout(timer);
      }
    }),
  );
}
