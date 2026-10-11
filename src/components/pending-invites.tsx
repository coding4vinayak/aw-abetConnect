"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { revokeInvitation, type MembersActionState } from "@/app/members/actions";

/**
 * Outstanding invitations, with a revoke control on each row.
 *
 * A client component rather than markup in the page so the result of a revoke is
 * actually visible: a bound server action inside a server component has nowhere
 * to put its return value, so "that invitation had already been used" would be
 * computed and thrown away.
 *
 * The expiry wording is computed on the server and passed in as text. Working it
 * out here from `Date.now()` would give the server render and the client render
 * different answers, which is a hydration warning at best and a stale countdown
 * at worst.
 */

const INITIAL: MembersActionState = {};

export type PendingInviteRow = {
  id: string;
  email: string;
  role: string;
  expires: string;
};

function RevokeButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md border border-line px-2 py-1 text-[11px] text-muted-dim transition hover:border-hot/40 hover:text-foreground disabled:opacity-60"
    >
      {pending ? "Revoking…" : "Revoke"}
    </button>
  );
}

export function PendingInvites({ invites }: { invites: PendingInviteRow[] }) {
  const [state, revoke] = useActionState(revokeInvitation, INITIAL);

  if (invites.length === 0) {
    return <p className="text-[12px] text-muted-dim">Nothing pending.</p>;
  }

  return (
    <div className="space-y-3">
      {state.error && (
        <p
          role="alert"
          className="rounded-md border border-hot/40 bg-hot/10 px-3 py-2 text-[12px] leading-relaxed text-foreground"
        >
          {state.error}
        </p>
      )}
      {state.notice && (
        <p
          role="status"
          className="rounded-md border border-line bg-surface px-3 py-2 text-[12px] leading-relaxed text-muted"
        >
          {state.notice}
        </p>
      )}

      <ul className="space-y-1">
        {invites.map((invite) => (
          <li key={invite.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[12px]">
            <span className="font-mono text-foreground">{invite.email}</span>
            <span className="text-muted">{invite.role}</span>
            <span className="text-muted-dim">{invite.expires}</span>
            {/* One form per row, carrying only the invite id. The server filters
                that id against the session's workspace, so it is a pointer and
                not a scope selector. */}
            <form action={revoke} className="ml-auto">
              <input type="hidden" name="id" value={invite.id} />
              <RevokeButton />
            </form>
          </li>
        ))}
      </ul>
    </div>
  );
}
