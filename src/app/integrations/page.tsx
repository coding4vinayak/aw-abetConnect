import Link from "next/link";
import { normaliseOrigins } from "@/lib/cors";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { ADAPTERS } from "@/lib/channels/adapters";
import { canManageRoles } from "@/lib/roles";
import { ApiKeyManager } from "@/components/api-key-manager";
import { CHANNELS } from "@/lib/types";

export const dynamic = "force-dynamic";

const EVENTS: Array<{ name: string; when: string }> = [
  { name: "thread.created", when: "a new conversation opens" },
  { name: "thread.scored", when: "any inbound message re-scores a conversation" },
  { name: "thread.hot", when: "a conversation crosses 70 — page the rep" },
  { name: "thread.at_risk", when: "churn language is detected on an account" },
  { name: "draft.created", when: "a reply has been drafted" },
  { name: "reply.sent", when: "a rep sends — this is where you deliver the message" },
];

function Section({
  title,
  children,
  note,
}: {
  title: string;
  children: React.ReactNode;
  note?: string;
}) {
  return (
    <section className="border-t border-line py-6">
      <h2 className="text-[13px] font-semibold tracking-tight text-foreground">{title}</h2>
      {note && <p className="mt-1 max-w-2xl text-[12px] leading-relaxed text-muted">{note}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <pre className="overflow-x-auto rounded-lg border border-line bg-surface px-3.5 py-3 font-mono text-[12px] leading-relaxed text-foreground">
      {children}
    </pre>
  );
}

/** UTC to the minute, so a key row and a server log line can be compared. */
function stamp(value: Date | null): string | null {
  return value ? `${value.toISOString().slice(0, 16).replace("T", " ")} UTC` : null;
}

export default async function IntegrationsPage() {
  // This page shows live API keys, so it is gated like the dashboard rather
  // than rendering an empty shell to signed-out visitors.
  const session = await requireSession();
  const workspaceId = session.workspaceId;

  const [keys, endpoints] = await Promise.all([
    db.apiKey.findMany({
      where: { workspaceId, revokedAt: null },
      orderBy: { createdAt: "asc" },
    }),
    db.webhookEndpoint.findMany({ where: { workspaceId } }),
  ]);

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
          <span className="text-[11px] text-muted-dim">Integrations</span>
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
            Connect a channel, or bolt this onto something bigger
          </h1>
          <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-muted">
            abetConnect does one job: rank inbound conversations by how close the
            sender is to buying, and draft the reply. Messages come in through one
            endpoint; results go out through webhooks. That is the entire surface —
            which is what lets it run standalone or as the triage layer inside a
            larger stack.
          </p>
        </div>

        <Section
          title="Send a message in"
          note="One endpoint, any channel. Post the provider's own payload shape and the matching adapter normalises it."
        >
          <Code>{`curl -X POST ${"$"}{BASE_URL}/api/v1/messages \\
  -H "Authorization: Bearer ${keys[0]?.prefix ?? "abc_live_..."}..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "channel": "EMAIL",
    "payload": {
      "from": "Priya Raman <priya@northwind.io>",
      "subject": "Pricing for 40 seats",
      "text": "We need this rolled out before the quarter ends. What does 40 seats cost?"
    }
  }'`}</Code>
          <p className="mt-2 text-[12px] text-muted">
            Returns the thread id, the score, the bucket and every signal behind
            the number.
          </p>
        </Section>

        <Section
          title="Or paste a webhook URL into your provider"
          note="One URL per channel. Authenticate with a header, or ?key= for providers that cannot set headers."
        >
          <div className="overflow-hidden rounded-lg border border-line">
            <table className="w-full text-left text-[12px]">
              <thead className="bg-surface text-muted-dim">
                <tr>
                  <th className="px-3 py-2 font-medium">Channel</th>
                  <th className="px-3 py-2 font-medium">Webhook path</th>
                  <th className="px-3 py-2 font-medium">Known providers</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {CHANNELS.map((channel) => (
                  <tr key={channel}>
                    <td className="px-3 py-2 text-foreground">{ADAPTERS[channel].label}</td>
                    <td className="px-3 py-2 font-mono text-[11px] text-muted">
                      /api/v1/channels/{channel.toLowerCase()}/webhook
                    </td>
                    <td className="px-3 py-2 text-muted-dim">
                      {ADAPTERS[channel].providers.join(", ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>

        <Section
          title="Get results out"
          note="Subscribe an endpoint and every scoring decision is pushed to you, signed with HMAC-SHA256 over `{timestamp}.{body}`."
        >
          <div className="overflow-hidden rounded-lg border border-line">
            <table className="w-full text-left text-[12px]">
              <thead className="bg-surface text-muted-dim">
                <tr>
                  <th className="px-3 py-2 font-medium">Event</th>
                  <th className="px-3 py-2 font-medium">Fires when</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {EVENTS.map((event) => (
                  <tr key={event.name}>
                    <td className="px-3 py-2 font-mono text-[11px] text-foreground">
                      {event.name}
                    </td>
                    <td className="px-3 py-2 text-muted">{event.when}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="mt-3 text-[12px] leading-relaxed text-muted">
            Note that <code className="font-mono text-foreground">reply.sent</code> is
            an outbound event, not a send. abetConnect never delivers mail or
            messages itself — owning delivery would mean owning deliverability and
            compliance, which is a different product. Your existing provider sends;
            this decides what to send and to whom first.
          </p>

          {endpoints.length > 0 && (
            <div className="mt-4">
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-dim">
                Subscribed endpoints
              </h3>
              <ul className="mt-1.5 space-y-1">
                {endpoints.map((e) => (
                  <li key={e.id} className="font-mono text-[11px] text-muted">
                    {e.url}{" "}
                    <span className="text-muted-dim">
                      ({e.events || "all events"})
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Section>

        <Section
          title="Read the queue programmatically"
          note="The same ranking the dashboard shows, as JSON. Useful for pushing the top of the queue into a dialer or CRM task list."
        >
          <Code>{`GET /api/v1/threads?bucket=HOT&awaitingReply=true
GET /api/v1/threads/{id}
PATCH /api/v1/threads/{id}          # status, snooze, or score override
POST  /api/v1/threads/{id}/draft    # regenerate the reply
POST  /api/v1/threads/{id}/reply    # record a sent reply`}</Code>
        </Section>

        <Section
          title="Scoring engine"
          note="Runs deterministically with no API key and no per-message cost. Set LLM_API_KEY to upgrade scoring and drafting to a model — the heuristic result is passed in as a prior and used as the fallback if the model is slow, down or returns junk, so triage never stops working."
        >
          <Code>{`# .env
LLM_API_KEY=sk-...
LLM_BASE_URL=https://api.openai.com/v1   # any OpenAI-compatible endpoint
LLM_MODEL=gpt-4o-mini`}</Code>
        </Section>

        <Section
          title="API keys"
          note="One key per integration, so a staging script and a production webhook can be revoked independently."
        >
          <ApiKeyManager
            canManage={canManageRoles(session.role)}
            keys={keys.map((k) => ({
              id: k.id,
              name: k.name,
              prefix: k.prefix,
              lastUsed: stamp(k.lastUsedAt),
              created: stamp(k.createdAt) ?? "unknown",
              // The same fail-closed reading lib/auth.ts uses: anything that is not
              // exactly SECRET is displayed as the weaker kind, so a row cannot be
              // mislabelled as safe when it is not.
              kind: k.kind === "PUBLISHABLE" ? ("PUBLISHABLE" as const) : ("SECRET" as const),
              origins: normaliseOrigins(k.allowedOrigins),
            }))}
          />
        </Section>
      </main>
    </div>
  );
}
