import Link from "next/link";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { canEditRole, canManageRoles } from "@/lib/roles";
import { listPendingInvites } from "@/lib/invites";
import { seatSummary, seatUsage } from "@/lib/seats";
import { SUBSCRIPTION_STATUS_OPEN } from "@/lib/stripe";
import { InviteForm } from "@/components/invite-form";
import { ManageBillingButton } from "@/components/manage-billing";
import { MemberRole } from "@/components/member-role";
import { PendingInvites } from "@/components/pending-invites";

export const dynamic = "force-dynamic";

/** Owner at the top, then admin, then member — sorting by name buries the owner. */
const RANK: Record<string, number> = { OWNER: 0, ADMIN: 1, MEMBER: 2 };

const ROLE_LABEL: Record<string, string> = {
  OWNER: "Owner",
  ADMIN: "Admin",
  MEMBER: "Member",
};

function Section({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-t border-line py-6">
      <h2 className="text-[13px] font-semibold tracking-tight text-foreground">{title}</h2>
      {note && <p className="mt-1 max-w-2xl text-[12px] leading-relaxed text-muted">{note}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

/** UTC to the minute, stamped the way key rows are on /integrations. */
function stamp(value: Date): string {
  return `${value.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** Relative, because the question a sender asks is "is this still usable". */
function expiresIn(expiresAt: Date): string {
  const hours = Math.floor((expiresAt.getTime() - Date.now()) / 3_600_000);
  if (hours < 1) return "expires within the hour";
  if (hours < 24) return "expires today";
  const days = Math.floor(hours / 24);
  return days === 1 ? "expires tomorrow" : `expires in ${days} days`;
}

/**
 * The roles this viewer may set on a seat that currently has `target`.
 *
 * canEditRole decides whether the seat is editable at all; canGrant's rules are
 * the ones that decide which roles may be handed out, so a dropdown cannot
 * sidestep them. This only chooses what to offer — the action re-checks both.
 */
function roleOptionsFor(actor: string, target: string): Array<{ value: string; label: string }> {
  if (!canEditRole(actor, target)) return [];
  const options: Array<{ value: string; label: string }> = [];
  if (target !== "MEMBER") options.push({ value: "MEMBER", label: "Member" });
  if (actor === "OWNER" && target !== "ADMIN") options.push({ value: "ADMIN", label: "Admin" });
  options.push({ value: "REMOVE", label: "No access" });
  return options;
}

const isOpen = (status: string) => (SUBSCRIPTION_STATUS_OPEN as readonly string[]).includes(status);

/**
 * Where the plan lives when the buyer is back in the app: card changes,
 * the renewal date, and — after checkout or the portal — the confirmation
 * that the round trip worked. The pricing page already refuses a second
 * checkout for a live subscription; this banner carries the same fact to
 * the screen the buyer actually works from.
 */
function PlanBanner({
  billing,
  subscription,
}: {
  billing?: string;
  subscription: { status: string; stripeCurrentPeriodEnd: Date | null } | null;
}) {
  const justBack = billing === "success" || billing === "portal";
  const renews = subscription?.stripeCurrentPeriodEnd
    ? new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(subscription.stripeCurrentPeriodEnd)
    : null;

  if (subscription && isOpen(subscription.status) && (subscription.status === "active" || subscription.status === "trialing")) {
    const trialing = subscription.status === "trialing";
    return (
      <div className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-green-200 bg-green-50 p-4 text-[13px] text-green-900">
        <span>
          {justBack ? (trialing ? "Trial started — welcome aboard. " : "Payment received — welcome aboard. ") : ""}
          {trialing ? (
            <>Trial active{renews ? <> — first charge {renews}</> : null}.</>
          ) : (
            <>Plan active{renews ? <>, renews {renews}</> : null}.</>
          )}
        </span>
        <ManageBillingButton />
      </div>
    );
  }

  if (subscription && isOpen(subscription.status) && (subscription.status === "past_due" || subscription.status === "unpaid")) {
    const declined = subscription.status === "past_due";
    return (
      <div className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-[13px] text-amber-900">
        <span>
          {declined
            ? "Your last payment was declined. Updating your card in the portal is the fix — access continues while Stripe retries."
            : "Your payments have run out. The portal is where the open invoice gets settled — a new subscription would not pay it."}
        </span>
        <ManageBillingButton label="Update card" />
      </div>
    );
  }

  return (
    <div className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface-raised p-4 text-[13px] text-muted">
      <span>No plan yet — $24 per agent/month, cancel any time.</span>
      <Link
        href="/pricing"
        className="shrink-0 rounded-md bg-blue-600 px-3 py-1.5 text-[11px] font-semibold text-white transition hover:bg-blue-700"
      >
        See pricing
      </Link>
    </div>
  );
}

export default async function MembersPage({ searchParams }: { searchParams: Promise<{ billing?: string }> }) {
  const session = await requireSession();
  const { billing } = await searchParams;

  const [memberships, invites, subscription, seats] = await Promise.all([
    db.membership.findMany({
      where: { workspaceId: session.workspaceId },
      include: { user: { select: { email: true, name: true } } },
    }),
    listPendingInvites(session.workspaceId),
    db.subscription.findUnique({
      where: { workspaceId: session.workspaceId },
      select: { status: true, stripeCurrentPeriodEnd: true },
    }),
    seatUsage(session.workspaceId),
  ]);

  const members = memberships.sort(
    (a, b) =>
      (RANK[a.role] ?? 9) - (RANK[b.role] ?? 9) ||
      a.createdAt.getTime() - b.createdAt.getTime(),
  );

  const seatLine = seatSummary(seats);
  const isManager = canManageRoles(session.role);
  // An admin is offered one role because an admin cannot hand out admin. The
  // rule is canGrant's, enforced on the server whatever this list says.
  const roles =
    session.role === "OWNER"
      ? [
          { value: "MEMBER", label: "Member" },
          { value: "ADMIN", label: "Admin" },
        ]
      : [{ value: "MEMBER", label: "Member" }];

  return (
    <div className="h-full overflow-y-auto">
      <header className="sticky top-0 z-10 flex items-center justify-between border-b border-line bg-background px-4 py-2.5">
        <div className="flex items-baseline gap-2.5">
          <Link
            href="/"
            className="text-[13px] font-semibold tracking-tight text-foreground hover:opacity-80"
          >
            abetConnect
          </Link>
          <span className="text-[11px] text-muted-dim">Team</span>
        </div>
        <Link
          href="/"
          className="rounded-md border border-line px-2 py-1 text-[11px] text-muted-dim transition hover:bg-surface-raised hover:text-foreground"
        >
          Back to queue
        </Link>
      </header>

      <main className="mx-auto max-w-3xl px-6 pb-16">
        <div className="py-8">
          <h1 className="text-xl font-semibold tracking-tight text-foreground">
            {session.workspaceName}
          </h1>
          <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-muted">
            Everyone who can open this workspace and read its customers&rsquo; conversations. Seats
            are invited by an owner or an admin, and an invitation names one address and works once,
            so it cannot be forwarded to whoever happens to click it first.
          </p>
          {seatLine ? (
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface-raised px-4 py-3 text-[12px] text-muted">
              <span>{seatLine}</span>
              {seats.cap !== null && seats.used >= seats.cap ? (
                <ManageBillingButton label="Add seats in the portal" />
              ) : null}
            </div>
          ) : null}
          <PlanBanner billing={billing} subscription={subscription} />
        </div>

        <Section
          title="People with access"
          note={
            isManager
              ? "Owners and admins invite people and manage API keys. Members work the queue and reply, and cannot see or revoke credentials."
              : "You can work the queue and reply. Invitations and API keys are managed by an owner or admin."
          }
        >
          <ul className="space-y-1.5">
            {members.map((membership) => {
              const options = roleOptionsFor(session.role, membership.role);
              const email = membership.user.email;
              return (
                <li
                  key={membership.id}
                  className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[12px]"
                >
                  <span className="font-medium text-foreground">
                    {membership.user.name || email}
                    {membership.userId === session.userId ? " (you)" : ""}
                  </span>
                  <span className="font-mono text-[11px] text-muted-dim">{email}</span>
                  {/* Where the viewer can act on the seat, the dropdown replaces
                      the static label; the seat's role is stated once per row. */}
                  {options.length > 0 ? (
                    <MemberRole
                      membershipId={membership.id}
                      role={membership.role}
                      label={email}
                      options={options}
                    />
                  ) : (
                    <span
                      className={
                        membership.role === "OWNER" ? "ml-auto text-warm" : "ml-auto text-muted-dim"
                      }
                    >
                      {ROLE_LABEL[membership.role] ?? membership.role}
                    </span>
                  )}
                  <span className="w-full text-[11px] text-muted-dim sm:w-auto">
                    joined {stamp(membership.createdAt)}
                  </span>
                </li>
              );
            })}
          </ul>
        </Section>

        {isManager && (
          <Section
            title="Invite someone"
            note="They sign up first if they have no account, then open the link. Nothing joins the workspace until they accept."
          >
            <InviteForm roles={roles} />
          </Section>
        )}

        {isManager && (
          <Section
            title="Outstanding invitations"
            note={
              invites.length === 0
                ? undefined
                : "Revoking stops a link that has already been sent from working."
            }
          >
            <PendingInvites
              invites={invites.map((invite) => ({
                id: invite.id,
                email: invite.email,
                role: ROLE_LABEL[invite.role] ?? invite.role,
                expires: expiresIn(invite.expiresAt),
              }))}
            />
          </Section>
        )}

        {isManager && (
          <Section
            title="Your data"
            note="Everything this workspace holds — contacts, conversations, messages, score signals, drafts, team and webhook settings — in one JSON file. Passwords, sessions, API keys, invitation links and billing are not included."
          >
            <a
              href="/api/export"
              className="inline-flex rounded-md bg-blue-600 px-3 py-2 text-[12px] font-semibold text-white transition hover:bg-blue-700"
            >
              Download workspace export (JSON)
            </a>
          </Section>
        )}
      </main>
    </div>
  );
}
