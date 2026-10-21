import { db } from "./db";
import { getAdapter } from "./channels/adapters";
import { ingestMessage } from "./ingest";

/**
 * A sample inbox: six conversations, so a new workspace can see what the
 * product is for before it connects a channel.
 *
 * The reason this exists is the same one the analytics first run has: a
 * workspace with no messages has nothing to rank, so the product's whole
 * opinion — a 40-seat enquiry at the top, a marketing blast at the floor, a
 * churn risk that still outranks a newsletter — is invisible. A buyer who
 * cannot see it cannot value it.
 *
 * Three rules keep it honest:
 *
 * 1. **The scores are the engine's, not ours.** Every message goes through
 *    `ingestMessage` — the same path a real inbound message takes — so the
 *    ranking on screen is the ranking the product would give. Nothing here
 *    writes a score.
 * 2. **It is unmistakably example data.** The addresses are on `example.com`
 *    (reserved for exactly this, RFC 2606), so a visitor can never mistake a
 *    sample conversation for a real one — and the removal can be surgical:
 *    every example contact, and only those.
 * 3. **It is removable in one click**, and the workspace is empty again
 *    afterwards.
 */

/** The domain every example contact lives on. */
export const EXAMPLE_EMAIL_DOMAIN = "example.com";

/** True when an address belongs to the sample inbox. */
export function isExampleEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return email.trim().toLowerCase().endsWith(`@${EXAMPLE_EMAIL_DOMAIN}`);
}

const HOUR = 3600 * 1000;
const ago = (hours: number) => new Date(Date.now() - hours * HOUR).toISOString();

type ExampleMessage = {
  channel: "EMAIL" | "WEBFORM";
  /** What this conversation is here to show, for the reader of the code. */
  demonstrates: string;
  payload: Record<string, unknown>;
  /** Append to this earlier message's thread instead of starting a new one. */
  replyTo?: number;
};

export const EXAMPLE_INBOX: ExampleMessage[] = [
  {
    channel: "WEBFORM",
    demonstrates: "a senior buyer with a budget and a deadline — the top of the queue",
    payload: {
      name: "Priya Raman",
      email: "priya.raman@example.com",
      company: "Northwind Logistics",
      jobTitle: "VP Operations",
      phone: "+1 415 555 0142",
      formName: "Request pricing",
      submittedAt: ago(2),
      message: `We're rolling this out to the dispatch team — 40 seats to start, likely 120 company-wide next year.

Budget is approved and I need it through procurement before the quarter ends. What do 40 seats cost on an annual plan?

Priya Raman
VP Operations | Northwind Logistics`,
    },
  },
  {
    channel: "WEBFORM",
    demonstrates: "a demo request — real interest, not a deadline",
    payload: {
      name: "Tomas Berg",
      email: "tomas.berg@example.com",
      company: "Helio Studio",
      jobTitle: "Founder",
      formName: "Book a demo",
      submittedAt: ago(9),
      message: `We build motion-graphics tools and we are drowning in support email.

Can we see a demo of how the queue would look with our own inbox? Happy to talk next week.

Tomas Berg
Founder | Helio Studio`,
    },
  },
  {
    channel: "EMAIL",
    demonstrates: "a cancellation threat from a paying customer — urgent revenue, not noise",
    payload: {
      from: "Dana Whitfield <dana.whitfield@example.com>",
      subject: "Cancelling our subscription",
      date: ago(20),
      messageId: "<example-churn-001@example.com>",
      text: `I've raised the reporting issue three times now and nothing has changed.

We're paying $2,400 a month for something the team has stopped using. I'm frustrated and I'd like to cancel before the next billing date. I've also started looking at alternatives.

If someone wants to talk me out of it, today would be the day.

Dana Whitfield
Director of Clinical Operations`,
    },
  },
  {
    channel: "EMAIL",
    demonstrates: "a support question from a real customer — not a buying signal",
    payload: {
      from: "Sam Okafor <sam.okafor@example.com>",
      subject: "Export is stuck",
      date: ago(27),
      messageId: "<example-support-001@example.com>",
      text: `The CSV export has been running for about twenty minutes and nothing has come down. Is there a limit on how many rows I can pull at once?

Sam Okafor
Reporting | Tidewell`,
    },
  },
  {
    channel: "EMAIL",
    // The word "pricing" is the point: a blast that talks about pricing must
    // not rank as a lead, or the scoring is just keyword matching.
    demonstrates: "a marketing blast, mentioning pricing — it must sit at the floor",
    payload: {
      from: "SaaS Weekly <newsletter@example.com>",
      subject: "This week in SaaS",
      date: ago(31),
      messageId: "<example-blast-001@example.com>",
      text: `In this week's newsletter: how to rethink your pricing strategy, the latest churn benchmarks, and an invitation to our free webinar on Thursday.

Read the archive, or forward this to a colleague.

SaaS Weekly`,
    },
  },
  {
    channel: "EMAIL",
    demonstrates: "a reply to the first conversation — a thread with more than one message",
    payload: {
      from: "Priya Raman <priya.raman@example.com>",
      subject: "Re: Request pricing",
      date: ago(1),
      messageId: "<example-reply-001@example.com>",
      text: `One more thing before I take this to procurement — if we go past 40 seats next year, is the price per seat or per workspace?

Priya`,
    },
    replyTo: 0,
  },
];

/**
 * Load the sample inbox into a workspace.
 *
 * Idempotent: a second call finds the example contacts already there and
 * changes nothing, so a double-click cannot double the inbox.
 */
export async function loadExampleInbox(workspace: {
  id: string;
  name: string;
  sellsWhat?: string | null;
}) {
  const existing = await db.contact.findFirst({
    where: { workspaceId: workspace.id, email: { endsWith: `@${EXAMPLE_EMAIL_DOMAIN}` } },
    select: { id: true },
  });
  if (existing) return { created: false, threads: 0 };

  const threadByMessage = new Map<number, string>();
  let count = 0;
  for (const [index, entry] of EXAMPLE_INBOX.entries()) {
    const normalized = getAdapter(entry.channel).normalize(entry.payload);
    const result = await ingestMessage(workspace, normalized, {
      threadId: entry.replyTo === undefined ? undefined : threadByMessage.get(entry.replyTo),
    });
    threadByMessage.set(index, result.threadId);
    count += 1;
  }
  return { created: true, threads: count };
}

/**
 * Remove the sample inbox, and only the sample inbox.
 *
 * The contacts are deleted by their example domain; their threads and messages
 * cascade with them. A real contact — even one who wrote in this week — is not
 * touched.
 */
export async function removeExampleInbox(workspaceId: string) {
  const contacts = await db.contact.findMany({
    where: { workspaceId, email: { endsWith: `@${EXAMPLE_EMAIL_DOMAIN}` } },
    select: { id: true },
  });
  const ids = contacts.map((c) => c.id);
  const threads = await db.thread.count({ where: { workspaceId, contactId: { in: ids } } });
  if (ids.length) await db.contact.deleteMany({ where: { id: { in: ids } } });
  return { contacts: ids.length, threads };
}

/** Whether a workspace is currently showing the sample inbox. */
export async function hasExampleInbox(workspaceId: string): Promise<boolean> {
  const contact = await db.contact.findFirst({
    where: { workspaceId, email: { endsWith: `@${EXAMPLE_EMAIL_DOMAIN}` } },
    select: { id: true },
  });
  return Boolean(contact);
}
