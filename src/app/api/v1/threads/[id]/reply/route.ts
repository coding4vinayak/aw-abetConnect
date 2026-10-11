import { NextResponse } from "next/server";
import { authenticate } from "@/lib/auth";
import { apiError, handleRouteError, readBody } from "@/lib/api";
import { db } from "@/lib/db";
import { toThreadDetail } from "@/lib/serialize";
import { dispatch } from "@/lib/webhooks";

/**
 * POST /api/v1/threads/{id}/reply
 *
 * Record that a reply went out. abetConnect deliberately does not send the
 * message itself — you already have an email provider and a WhatsApp number,
 * and owning delivery would mean owning deliverability, compliance and
 * inbox reputation. It stays a triage layer.
 *
 * The `reply.sent` webhook is where an integration performs actual delivery.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const workspace = await authenticate(request);
    const { id } = await params;
    const body = await readBody(request);

    const thread = await db.thread.findFirst({
      where: { id, workspaceId: workspace.id },
      include: { contact: true },
    });
    if (!thread) return apiError("not_found", 404, "Thread not found");

    // Send explicit text, or fall back to whatever draft is pending.
    let text = typeof body.body === "string" ? body.body.trim() : "";
    let draftId: string | undefined;

    if (!text) {
      const draft = await db.draft.findFirst({
        where: { threadId: id, status: { in: ["SUGGESTED", "EDITED"] } },
        orderBy: { createdAt: "desc" },
      });
      if (!draft) {
        return apiError("invalid_request", 422, "No draft to send. Provide 'body' or generate a draft first.", {
          param: "body",
        });
      }
      text = draft.body;
      draftId = draft.id;
    }

    const channel = String(body.channel ?? thread.channel).toUpperCase();
    const sentAt = new Date();

    const message = await db.message.create({
      data: {
        threadId: id,
        direction: "OUTBOUND",
        channel,
        body: text,
        sentAt,
      },
    });

    if (draftId) {
      await db.draft.update({
        where: { id: draftId },
        data: { status: "SENT", sentAt },
      });
    } else {
      // A hand-written reply supersedes any pending suggestion.
      await db.draft.updateMany({
        where: { threadId: id, status: { in: ["SUGGESTED", "EDITED"] } },
        data: { status: "DISCARDED" },
      });
    }

    const updated = await db.thread.update({
      where: { id },
      data: {
        lastMessageAt: sentAt,
        lastOutboundAt: sentAt,
        // Answered: the ball is back in their court, so it drops down the queue.
        awaitingReply: false,
      },
      include: {
        contact: true,
        signals: { orderBy: { weight: "desc" } },
        messages: { orderBy: { sentAt: "asc" } },
        drafts: { orderBy: { createdAt: "desc" } },
        _count: { select: { messages: true } },
      },
    });

    void dispatch(workspace.id, "reply.sent", {
      threadId: id,
      messageId: message.id,
      channel,
      body: text,
      to: {
        name: thread.contact.name,
        email: thread.contact.email,
        phone: thread.contact.phone,
      },
      subject: thread.subject,
    });

    return NextResponse.json({ thread: toThreadDetail(updated) }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
