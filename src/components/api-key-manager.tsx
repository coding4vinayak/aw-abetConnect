"use client";

import { useActionState, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { createApiKey, revokeApiKey, type KeyState } from "@/app/integrations/actions";

/**
 * The workspace's API keys: list, create, revoke.
 *
 * Rows arrive already formatted from the server. Dates are deliberately passed
 * as strings so the client never re-formats them and disagrees with what was
 * rendered on the page.
 */
export interface KeyRow {
  id: string;
  name: string;
  prefix: string;
  lastUsed: string | null;
  created: string;
  /**
   * Which door this key opens. Shown because the two kinds are not interchangeable
   * and the difference is invisible in a list of prefixes: one can read the whole
   * workspace, the other can only post a web form into it.
   */
  kind: "SECRET" | "PUBLISHABLE";
  /** Origins allowed to use a publishable key. Empty for a secret one. */
  origins: string[];
}

const INITIAL: KeyState = {};

const INPUT_CLASS =
  "w-full rounded-md border border-line bg-surface px-3 py-2 text-[13px] text-foreground placeholder:text-muted-dim focus:border-muted-dim focus:outline-none";

function CreateButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="shrink-0 rounded-md bg-foreground px-3 py-2 text-[12px] font-medium text-background transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {pending ? "Creating…" : "Create key"}
    </button>
  );
}

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

/**
 * The one-time reveal.
 *
 * `navigator.clipboard` needs a secure context, which plain http://192.168.x.x
 * during a demo is not, so the fallback selects the text instead of failing
 * silently and leaving the customer with nothing.
 */
function RevealedKey({
  name,
  plaintext,
  kind,
}: {
  name: string;
  plaintext: string;
  kind: "SECRET" | "PUBLISHABLE";
}) {
  const field = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(plaintext);
      setCopied(true);
    } catch {
      field.current?.select();
    }
  }

  return (
    <div className="rounded-lg border border-line bg-surface-raised p-3.5">
      <p className="text-[12px] font-medium text-foreground">
        Copy <span className="font-mono">{name}</span> now
      </p>
      <p className="mt-1 text-[12px] leading-relaxed text-muted">
        Only the hash of this key is stored, so this is the only time it is ever shown. Close
        the page and the next step is creating a new key.
      </p>
      <p className="mt-1.5 text-[12px] leading-relaxed text-muted">
        {kind === "PUBLISHABLE" ? (
          <>
            This one is <span className="text-foreground">publishable</span>: it belongs in your
            site&apos;s JavaScript, where it can only post a web form into this workspace, from the
            origins you listed. It cannot read a single thread.
          </>
        ) : (
          <>
            This one is <span className="text-foreground">secret</span>: server-side only. Put it in
            website or mobile code and everyone who loads the page holds a key that can read the
            whole workspace.
          </>
        )}
      </p>
      <div className="mt-2.5 flex items-center gap-2">
        <input
          ref={field}
          readOnly
          value={plaintext}
          onFocus={(e) => e.currentTarget.select()}
          className={`${INPUT_CLASS} font-mono text-[12px]`}
        />
        <button
          type="button"
          onClick={copy}
          className="shrink-0 rounded-md border border-line px-3 py-2 text-[12px] text-foreground transition hover:bg-surface"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

function Message({ tone, children }: { tone: "error" | "notice"; children: React.ReactNode }) {
  return (
    <p
      role={tone === "error" ? "alert" : "status"}
      className={`rounded-md border px-3 py-2 text-[12px] leading-relaxed ${
        tone === "error"
          ? "border-hot/40 bg-hot/10 text-foreground"
          : "border-line bg-surface text-muted"
      }`}
    >
      {children}
    </p>
  );
}

export function ApiKeyManager({
  keys,
  canManage,
}: {
  keys: KeyRow[];
  /**
   * Whether the viewer may see or manage keys at all.
   *
   * This is presentation, not the security boundary: the actions refuse a member
   * whatever the page renders. It exists because a form that is certain to fail is
   * worse than a sentence saying who to ask — and because key names and prefixes are
   * one person's map of another's integrations.
   */
  canManage: boolean;
}) {
  const [created, create] = useActionState(createApiKey, INITIAL);
  const [revoked, revoke] = useActionState(revokeApiKey, INITIAL);
  // Only drives which inputs the form shows. The server decides what a key really
  // is; a tampered form cannot make a publishable key into a secret one, because
  // an unknown `kind` value is refused outright in actions.ts.
  const [kind, setKind] = useState<"SECRET" | "PUBLISHABLE">("SECRET");

  if (!canManage) {
    return (
      <p className="text-[12px] leading-relaxed text-muted">
        Only an owner or an admin can see or manage API keys, because a key outlives the
        session that made it. Ask whoever owns this workspace for one — keys are separate
        from your login, so receiving one never means handing over your access.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {created.revealed && <RevealedKey {...created.revealed} />}
      {created.error && <Message tone="error">{created.error}</Message>}
      {revoked.error && <Message tone="error">{revoked.error}</Message>}
      {revoked.notice && <Message tone="notice">{revoked.notice}</Message>}

      {keys.length === 0 ? (
        <p className="text-[12px] text-muted-dim">
          No keys yet. Create one, then point a channel at the ingest endpoint above — or a
          website form at a publishable key, which is the only kind that belongs in browser code.
        </p>
      ) : (
        <ul className="space-y-1">
          {keys.map((key) => (
            <li
              key={key.id}
              className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[12px]"
            >
              <code className="font-mono text-foreground">{key.prefix}…</code>
              <span className="text-muted">{key.name}</span>
              <span
                className={`rounded-full border px-1.5 py-px text-[10px] ${
                  key.kind === "PUBLISHABLE"
                    ? "border-line text-muted"
                    : "border-hot/30 text-hot"
                }`}
                title={
                  key.kind === "PUBLISHABLE"
                    ? "Safe in browser code. Posts web forms only."
                    : "Server-side only. Reads and writes everything."
                }
              >
                {key.kind === "PUBLISHABLE" ? "publishable" : "secret"}
              </span>
              {key.kind === "PUBLISHABLE" && (
                <span className="text-muted-dim">
                  {key.origins.length > 0 ? `from ${key.origins.join(", ")}` : "no origins"}
                </span>
              )}
              <span className="text-muted-dim">
                {key.lastUsed ? `last used ${key.lastUsed}` : `created ${key.created}, never used`}
              </span>
              {/* One form per row, carrying only the key's id. The server
                  ignores that id as a scope selector and filters it against the
                  session's workspace. */}
              <form action={revoke} className="ml-auto">
                <input type="hidden" name="id" value={key.id} />
                <RevokeButton />
              </form>
            </li>
          ))}
        </ul>
      )}

      <form action={create} className="space-y-2">
        <div className="flex items-center gap-2">
          <select
            name="kind"
            aria-label="Key type"
            value={kind}
            onChange={(e) => setKind(e.currentTarget.value === "PUBLISHABLE" ? "PUBLISHABLE" : "SECRET")}
            className={`${INPUT_CLASS} w-auto`}
          >
            <option value="SECRET">Secret — server-side</option>
            <option value="PUBLISHABLE">Publishable — website form</option>
          </select>
          {/* maxLength mirrors MAX_NAME_LENGTH in actions.ts as a literal because a
              "use server" module may only export async functions. The server still
              validates; this just stops an over-long keystroke. */}
          <input
            name="name"
            type="text"
            maxLength={40}
            placeholder="Production ingest"
            aria-label="Key name"
            className={INPUT_CLASS}
          />
          <CreateButton />
        </div>
        {kind === "PUBLISHABLE" && (
          <div className="flex flex-wrap items-center gap-2">
            <input
              name="origins"
              type="text"
              placeholder="https://your-site.com"
              aria-label="Allowed origins"
              className={INPUT_CLASS}
            />
            <span className="text-[11px] text-muted-dim">
              comma-separated; nothing else may post with this key
            </span>
          </div>
        )}
      </form>

      <p className="text-[12px] leading-relaxed text-muted-dim">
        Keys authenticate the REST API — <code className="font-mono">Authorization: Bearer</code>{" "}
        or <code className="font-mono">?key=</code> on the channel webhooks. They are separate
        from your login, so revoking one never locks a person out of the dashboard. A publishable
        key reaches <code className="font-mono">POST /api/v1/messages</code> and nothing else.
      </p>
    </div>
  );
}
