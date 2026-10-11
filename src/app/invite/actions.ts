"use server";

import { redirect } from "next/navigation";
import { acceptInvite } from "@/lib/invites";
import { createSession, getSession } from "@/lib/session";

/**
 * Redeeming an invitation link.
 *
 * The token arrives bound by the client component rather than read from the
 * form, so it is not a field somebody can edit into a different invitation; and
 * the workspace the person ends up in comes from the invite row, never from
 * anything the browser sent.
 */

export type AcceptState = { error?: string };

export async function acceptInvitation(
  token: string,
  _previous: AcceptState,
  _form: FormData,
): Promise<AcceptState> {
  const session = await getSession();
  if (!session) {
    return {
      error: "Sign in with the invited address first, then open this link again.",
    };
  }

  const result = await acceptInvite({ token, userId: session.userId });
  if (!result.ok) return { error: result.error };

  // Move the browser into the workspace it just joined. The session record
  // carries the open workspace, so without this a person accepts an invitation
  // and is bounced back to whichever team they were last looking at — or to an
  // empty screen if this is the only one they belong to. createSession is the
  // same call signup makes, so this is one path to being signed into a team,
  // not a second one with its own rules.
  await createSession(session.userId, result.workspaceId);
  redirect("/");
}
