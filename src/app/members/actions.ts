"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { getSession, type ActiveSession } from "@/lib/session";
import { canGrant, canManageRoles } from "@/lib/roles";
import { createInvite, revokeInvite } from "@/lib/invites";
import { editSeat } from "@/lib/seats";

/**
 * Team seats: inviting people in, withdrawing invitations.
 *
 * The rules live in `lib/invites.ts`, so the parts that matter security-wise are
 * ordinary functions a script can drive against a real database. What is here is
 * only the part that exists for a browser: resolving whose session this is,
 * reading a form, and turning a token into an absolute link.
 *
 * Scope comes from the session, never from the form — the same rule as the API
 * key actions beside these. There is no workspace id in any of these inputs for
 * somebody to swap out.
 */

export type MembersActionState = {
  error?: string;
  notice?: string;
  /** The one-time accept link, revealed in this response and stored nowhere. */
  revealed?: { email: string; role: string; link: string };
};

/**
 * The session, if it may manage people.
 *
 * `getSession` rather than `requireSession`, as in the key actions: a redirect to
 * /login out of a form submission is a non-answer, whereas an error renders next
 * to the button that caused it.
 */
async function authorise(): Promise<{ session: ActiveSession } | { error: string }> {
  const session = await getSession();
  if (!session) return { error: "Your session has expired. Sign in again." };
  if (!canManageRoles(session.role)) {
    return { error: "Only an owner or admin can change who is on this team." };
  }
  return { session };
}

/**
 * This request's origin.
 *
 * From the incoming Host rather than a config value, so a link generated on
 * staging points at staging and a link from production points at production, and
 * a deployment that never sets a public URL still sends working invitations.
 */
async function requestOrigin(): Promise<string> {
  const bag = await headers();
  const host = bag.get("x-forwarded-host") ?? bag.get("host") ?? "localhost:3000";
  const forwardedProto = bag.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const secure = forwardedProto === "https" || host.endsWith(".vercel.app");
  return `${secure ? "https" : "http"}://${host}`;
}

export async function inviteMember(
  _previous: MembersActionState,
  formData: FormData,
): Promise<MembersActionState> {
  const email = String(formData.get("email") ?? "").trim();
  const role = String(formData.get("role") ?? "").trim().toUpperCase();
  if (!email) return { error: "Enter the email address to invite." };
  if (!role) return { error: "Choose the access that person needs." };

  const auth = await authorise();
  if ("error" in auth) return auth;

  // canGrant is also applied inside createInvite, and that is the copy that
  // matters: this one exists so the message arrives next to the role control
  // that caused it. The duplicate is deliberate — the lib cannot be trusted to
  // remember who called it.
  const grantable = canGrant(auth.session.role, role);
  if (!grantable.ok) return { error: grantable.error };

  const invite = await createInvite({
    workspaceId: auth.session.workspaceId,
    email,
    role,
    createdById: auth.session.userId,
  });
  if (!invite.ok) return { error: invite.error };

  revalidatePath("/members");
  return {
    revealed: {
      email: invite.email,
      role: invite.role,
      link: `${await requestOrigin()}/invite/${invite.token}`,
    },
  };
}

export async function revokeInvitation(
  _previous: MembersActionState,
  formData: FormData,
): Promise<MembersActionState> {
  const id = String(formData.get("id") ?? "");
  if (!id) return { error: "No invitation was selected." };

  const auth = await authorise();
  if ("error" in auth) return auth;

  const result = await revokeInvite({
    workspaceId: auth.session.workspaceId,
    inviteId: id,
  });
  if (!result.ok) return { error: result.error };

  revalidatePath("/members");
  return { notice: "That invitation no longer works." };
}

/**
 * Changing or ending someone's access.
 *
 * Everything that decides anything lives in editSeat (lib/seats.ts), where
 * scripts/check-invites.mts can drive it against a real database. This is the
 * form-shaped wrapper around it: read two fields, ask the session who is making
 * the request, turn the outcome into a sentence.
 */
export async function changeMemberRole(
  _previous: MembersActionState,
  formData: FormData,
): Promise<MembersActionState> {
  const membershipId = String(formData.get("membership") ?? "");
  const role = String(formData.get("role") ?? "").trim().toUpperCase();
  if (!membershipId) return { error: "No seat was selected." };
  if (!role) return { error: "Choose what this person should have access to." };

  const auth = await authorise();
  if ("error" in auth) return auth;

  const result = await editSeat({
    workspaceId: auth.session.workspaceId,
    membershipId,
    actorRole: auth.session.role,
    role,
  });
  if (!result.ok) return { error: result.error };

  revalidatePath("/members");
  if (result.action === "removed") {
    return { notice: result.who + " no longer has access to this workspace." };
  }
  if (result.action === "unchanged") return { notice: "Nothing changed." };
  const asRole = result.role === "ADMIN" ? "an admin" : "a member";
  return { notice: result.who + " is now " + asRole + "." };
}
