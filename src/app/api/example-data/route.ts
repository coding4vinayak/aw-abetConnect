import { NextResponse } from "next/server";
import { authenticate } from "@/lib/auth";
import { db } from "@/lib/db";
import { getSession } from "@/lib/session";
import { loadExampleInbox, removeExampleInbox } from "@/lib/example-inbox";

export const dynamic = "force-dynamic";

/**
 * The sample inbox: `POST` loads it, `DELETE` removes it.
 *
 * The door is a **session or a key**, not a key only. The dashboard is the
 * browser and the API is the machine; a prospect who signs up on the web and a
 * developer who integrates the API are the same buyer, and neither should have
 * to wait for the other to see the product work.
 */
async function callerWorkspace(request: Request): Promise<string | null> {
  const session = await getSession();
  if (session) return session.workspaceId;
  try {
    const workspace = await authenticate(request);
    return workspace.id;
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  const workspaceId = await callerWorkspace(request);
  if (!workspaceId) {
    return NextResponse.json({ error: "Sign in, or send an API key." }, { status: 401 });
  }

  const workspace = await db.workspace.findUnique({
    where: { id: workspaceId },
    select: { id: true, name: true, sellsWhat: true },
  });
  if (!workspace) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const result = await loadExampleInbox(workspace);
  return NextResponse.json({ ok: true, ...result }, { status: result.created ? 201 : 200 });
}

export async function DELETE(request: Request) {
  const workspaceId = await callerWorkspace(request);
  if (!workspaceId) {
    return NextResponse.json({ error: "Sign in, or send an API key." }, { status: 401 });
  }

  const removed = await removeExampleInbox(workspaceId);
  return NextResponse.json({ ok: true, removed });
}
