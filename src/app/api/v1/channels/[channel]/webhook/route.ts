import { NextResponse } from "next/server";
import { authenticate } from "@/lib/auth";
import { apiError, handleRouteError, readBody } from "@/lib/api";
import { AdapterError, getAdapter } from "@/lib/channels/adapters";
import { ingestMessage } from "@/lib/ingest";
import { CHANNELS, isChannel } from "@/lib/types";

/**
 * POST /api/v1/channels/{channel}/webhook
 *
 * A per-channel URL to paste straight into Twilio, SendGrid, Slack or a form
 * builder. Same pipeline as /messages, but the channel comes from the path so
 * providers that cannot shape a JSON body still work.
 *
 * Authenticate with `?key=` when the provider cannot set headers.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ channel: string }> },
) {
  try {
    const { channel: raw } = await params;
    const channel = raw.toUpperCase();
    if (!isChannel(channel)) {
      return apiError(
        "unknown_channel",
        404,
        `Unknown channel '${raw}'. Supported: ${CHANNELS.join(", ")}`,
        { param: "channel" },
      );
    }

    // Providers vary wildly in what headers they permit; accept a query key.
    const url = new URL(request.url);
    const queryKey = url.searchParams.get("key");
    const authedRequest = queryKey
      ? new Request(request.url, {
          method: request.method,
          headers: (() => {
            const h = new Headers(request.headers);
            h.set("authorization", `Bearer ${queryKey}`);
            return h;
          })(),
        })
      : request;

    const workspace = await authenticate(authedRequest);
    const payload = await readBody(request);

    // Slack requires echoing back the url_verification challenge before it
    // will enable an endpoint.
    if (payload.type === "url_verification" && typeof payload.challenge === "string") {
      return NextResponse.json({ challenge: payload.challenge });
    }

    // Ignore Slack's own bot echoes, or we would score our own replies.
    const event = payload.event as Record<string, unknown> | undefined;
    if (event?.bot_id || event?.subtype === "bot_message") {
      return NextResponse.json({ ignored: "bot message" });
    }

    const normalized = getAdapter(channel).normalize(payload);
    const result = await ingestMessage(workspace, normalized);

    return NextResponse.json({
      threadId: result.threadId,
      duplicate: result.duplicate,
      score: result.triage.score,
      bucket: result.triage.bucket,
      intent: result.triage.intent,
    });
  } catch (error) {
    if (error instanceof AdapterError) return apiError("invalid_request", 422, error.message);
    return handleRouteError(error);
  }
}

/** Some providers GET the URL to verify it before sending events. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ channel: string }> },
) {
  const { channel } = await params;
  const upper = channel.toUpperCase();
  if (!isChannel(upper))
    return apiError("unknown_channel", 404, `Unknown channel '${channel}'`, {
      param: "channel",
    });
  return NextResponse.json({ ok: true, channel: upper });
}
