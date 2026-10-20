import { db } from "./db";
import { canEditRole, canGrant } from "./roles";
import { SUBSCRIPTION_STATUS_ACTIVE } from "./stripe";

/**
 * The seat meter, which is the half of a per-agent price that closes the loop.
 *
 * Checkout bills the members in the workspace plus the invitations still
 * outstanding, and every subscription sync stores the line-item quantity here.
 * Without this, "$24 per agent/month" was only true for a team of one: an owner
 * could invite thirty colleagues and neither the product nor the invoice would
 * notice. The cap is what turns an invitation into the repeat transaction the
 * price describes.
 */
export type SeatUsage = {
  /** What the subscription is billed for, or null when the workspace has no
   *  number this app can trust — no paid plan, or a subscription that has not
   *  synced since the column existed. */
  cap: number | null;
  /** Seats already occupied or promised: every member, plus every invite that
   *  has not been accepted and has not expired. A pending link is a seat
   *  committed the moment somebody says yes, so counting members alone would
   *  let an owner hand out links all afternoon and leave the invoice behind. */
  used: number;
};

/**
 * The count in one sentence, next to the rule it describes: the banner a manager
 * reads and the error an invite form returns must not be free to word the same
 * limit differently. Null when there is nothing to compare against — an unknown
 * cap has no number to spell out, and inventing one here would be the same lie
 * the meter refuses.
 */
export function seatSummary(usage: SeatUsage): string | null {
  const { cap, used } = usage;
  if (cap === null) return null;
  if (used > cap)
    return (
      `${used} of ${cap} paid seats are taken — the team is bigger than the plan, ` +
      `and the invoice is short ${used - cap} ${used - cap === 1 ? "seat" : "seats"}.`
    );
  if (used === cap)
    return cap === 1
      ? "The only paid seat is taken or already invited — the next person needs another seat."
      : `All ${cap} paid seats are taken or already invited — the next person needs another seat.`;
  const open = cap - used;
  return `${used} of ${cap} paid seats taken, ${open} ${open === 1 ? "is" : "are"} still open.`;
}

/**
 * The rule as plain arithmetic, so it can be driven with real numbers and no
 * database.
 *
 * An unknown cap is not a zero cap. Refusing to let a paying team invite anybody
 * because a column this app only just started writing was never populated is a
 * support ticket and a churn risk, not a billing win — so the meter fails open
 * on `null` and the next sync closes it.
 *
 * The refusal is the summary sentence plus the way out, built from the same
 * call: a banner that says one thing and an error that says another is how a
 * limit reads like a bug.
 */
export function seatDecision(usage: SeatUsage): { allowed: true } | { allowed: false; error: string } {
  if (usage.cap === null || usage.used < usage.cap) return { allowed: true };
  return {
    allowed: false,
    error:
      `${seatSummary(usage)} The plan is priced per agent, so the way past the limit is to buy ` +
      `another seat — the billing portal changes the quantity in one click, and the invoice ` +
      `scales with it.`,
  };
}

export async function seatUsage(workspaceId: string, now: Date = new Date()): Promise<SeatUsage> {
  const [subscription, members, pending] = await Promise.all([
    db.subscription.findUnique({
      where: { workspaceId },
      select: { status: true, stripeSeats: true },
    }),
    db.membership.count({ where: { workspaceId } }),
    db.invite.count({ where: { workspaceId, acceptedAt: null, expiresAt: { gt: now } } }),
  ]);
  const cap = subscription
    ? (SUBSCRIPTION_STATUS_ACTIVE as readonly string[]).includes(subscription.status)
      ? subscription.stripeSeats
      : null
    : null;
  return { cap, used: members + pending };
}

/**
 * Changing or ending an existing seat.
 *
 * Invitations only ever *add* access, so this is the half that fixes a mistake:
 * the member who should have been an admin, the colleague who has left. It lives in
 * lib rather than in the server action for the same reason the invite rules do — it
 * is the most powerful thing an owner can click, and it has to be drivable from a
 * script against a real database instead of read and hoped over.
 *
 * Three rules hold it together:
 *
 *   - The workspace comes from the caller's session, and the seat is looked up by
 *     id *within* it. A membership id from another tenant resolves to nothing.
 *   - canEditRole decides whether this seat is yours to touch, so an admin cannot
 *     re-role another admin, and nobody can touch an owner from inside the product.
 *   - canGrant decides which roles may be handed out, so the dropdown cannot
 *     sidestep "only an owner may make an admin" — an invite and a role change are
 *     the same privilege wearing different clothes.
 */

/** Not a role. An instruction to take the seat away, kept out of the role
 *  namespace so a made-up role can never be spelled like a verb. */
export const REMOVE = "REMOVE";

/** The role names go into sentences, so the article has to follow them rather
 *  than being hardcoded to "a". */
function article(role: string): string {
  return role === "ADMIN" || role === "OWNER" ? "an" : "a";
}

export type SeatOutcome =
  | { ok: true; action: "role" | "removed" | "unchanged"; who: string; role?: string }
  | { ok: false; error: string };

export async function editSeat(input: {
  workspaceId: string;
  membershipId: string;
  actorRole: string;
  role: string;
}): Promise<SeatOutcome> {
  const seat = await db.membership.findFirst({
    where: { id: input.membershipId, workspaceId: input.workspaceId },
    include: { user: { select: { name: true, email: true } } },
  });
  if (!seat) return { ok: false, error: "That seat is not in your workspace." };

  if (!canEditRole(input.actorRole, seat.role)) {
    return {
      ok: false,
      error:
        `As ${article(input.actorRole)} ${input.actorRole.toLowerCase()}, ` +
        `you cannot change ${article(seat.role)} ${seat.role.toLowerCase()} seat.`,
    };
  }

  const who = seat.user.name || seat.user.email;

  if (input.role === REMOVE) {
    await db.$transaction([
      db.membership.delete({ where: { id: seat.id } }),
      // Their cookie was minted in this workspace. Delete the seat alone and the
      // browser keeps a workspace it has been removed from until something else
      // reloads: the row is gone but the session still names the id. Other
      // workspaces this account belongs to are untouched, which is why the filter
      // is the pair rather than the user alone.
      db.session.deleteMany({
        where: { userId: seat.userId, workspaceId: seat.workspaceId },
      }),
    ]);
    return { ok: true, action: "removed", who };
  }

  const grantable = canGrant(input.actorRole, input.role);
  if (!grantable.ok) return { ok: false, error: grantable.error };
  if (input.role === seat.role) return { ok: true, action: "unchanged", who, role: input.role };

  await db.membership.update({ where: { id: seat.id }, data: { role: input.role } });
  return { ok: true, action: "role", who, role: input.role };
}
