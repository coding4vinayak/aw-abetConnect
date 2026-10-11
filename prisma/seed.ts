/**
 * Seed a realistic multi-channel inbox.
 *
 * Every message is pushed through the real ingest pipeline rather than being
 * written straight to the database, so the scores, buckets, signals and drafts
 * you see are genuinely produced by the engine. If the ranking looks wrong
 * after seeding, the engine is wrong — which is the point.
 */

import { db } from "../src/lib/db";
import { generateApiKey } from "../src/lib/auth";
import { hashPassword } from "../src/lib/password";
import { getAdapter } from "../src/lib/channels/adapters";
import { ingestMessage } from "../src/lib/ingest";
import type { Channel, NormalizedMessage } from "../src/lib/types";

const HOURS = 60 * 60 * 1000;
const ago = (hours: number) => new Date(Date.now() - hours * HOURS).toISOString();

interface SeedEntry {
  channel: Channel;
  payload: Record<string, unknown>;
  direction?: "INBOUND" | "OUTBOUND";
  /** Adjust the normalised message — used to seed cross-channel identities. */
  patch?: (message: NormalizedMessage) => void;
  /** Tag an entry so a later outbound message can be attached to its thread. */
  key?: string;
  /** Attach this message to the thread created by the entry with this key. */
  replyTo?: string;
  /** What this row is here to demonstrate. Printed in the summary. */
  demonstrates: string;
}

const INBOX: SeedEntry[] = [
  // ------------------------------------------------------------------
  // Should land at the very top: senior buyer, real budget, hard deadline.
  // ------------------------------------------------------------------
  {
    channel: "WEBFORM",
    demonstrates: "VP, 40 seats, quarter-end deadline — should be the top of the queue",
    payload: {
      name: "Priya Raman",
      email: "priya.raman@northwind.io",
      company: "Northwind Logistics",
      jobTitle: "VP Operations",
      phone: "+1 415 555 0142",
      formName: "Request pricing",
      submittedAt: ago(2),
      message: `We're rolling this out to the dispatch team — 40 seats to start, likely 120 company-wide next year.

Budget has been approved and I need to get it through procurement before the quarter ends. What does 40 seats cost on an annual plan?

Priya Raman
VP Operations | Northwind Logistics`,
    },
  },
  {
    channel: "EMAIL",
    demonstrates: "Founder with a PO raised — paperwork stage",
    payload: {
      from: "Tomas Berg <tomas@heliostudio.se>",
      subject: "Ready to go ahead — need an invoice",
      date: ago(5),
      messageId: "<helio-001@heliostudio.se>",
      text: `Hi,

We're ready to move forward on the business plan. I've raised a PO on our side (PO-2291).

Can you send the contract and an invoice for €14,400? Our finance team closes the month on Friday so it would help to have it before then.

Thanks,
Tomas Berg
Founder & CEO, Helio Studio`,
    },
  },

  // ------------------------------------------------------------------
  // Churn risk: an existing customer about to leave. Negative sentiment,
  // but it must still surface high — this is revenue walking out.
  // ------------------------------------------------------------------
  {
    channel: "EMAIL",
    demonstrates: "Cancellation threat from a paying customer — urgent revenue, not noise",
    payload: {
      from: "Dana Whitfield <dana.whitfield@kestrelhealth.com>",
      subject: "Cancelling our subscription",
      date: ago(1),
      messageId: "<kestrel-882@kestrelhealth.com>",
      text: `I've raised the reporting issue three times now and nothing has changed.

We're paying $2,400 a month for something the team has stopped using. I'm frustrated and I'd like to cancel before the next billing date. I've also started looking at alternatives.

If someone wants to talk me out of it, today would be the day.

Dana Whitfield
Director of Clinical Operations`,
    },
  },

  // ------------------------------------------------------------------
  // Cross-channel: the same human emails, then chases on WhatsApp. The
  // contact must dedupe and the thread must merge.
  // ------------------------------------------------------------------
  {
    channel: "EMAIL",
    key: "marcus",
    demonstrates: "First touch by email (same person as the WhatsApp chase below)",
    payload: {
      from: "Marcus Oyelaran <marcus@brightpathedu.org>",
      subject: "Quote for 250 users",
      date: ago(30),
      messageId: "<brightpath-1@brightpathedu.org>",
      text: `Good afternoon,

We're comparing you against two other providers for a September rollout. Could you send a quote for 250 users?

Also — do you have SOC 2 documentation we can pass to our security team?

Marcus Oyelaran
Head of IT, Brightpath Education Trust`,
    },
    patch: (m) => {
      // Same human, both identifiers known. This is what lets the WhatsApp
      // message below merge into this conversation instead of starting a new one.
      m.contact.phone = "+2348031234567";
    },
  },
  {
    channel: "EMAIL",
    demonstrates: "Our own reply, so the transcript shows both sides",
    direction: "OUTBOUND",
    replyTo: "marcus",
    payload: {
      from: "sales@yourcompany.com",
      subject: "Re: Quote for 250 users",
      date: ago(26),
      messageId: "<our-reply-1@yourcompany.com>",
      text: `Hi Marcus,

Thanks for getting in touch. Putting the 250-user quote together now — I'll have it with you tomorrow along with our SOC 2 report.

Best,
Sam`,
    },
  },
  {
    channel: "WHATSAPP",
    demonstrates: "Same contact chasing on a second channel — multi-channel signal",
    payload: {
      From: "whatsapp:+2348031234567",
      ProfileName: "Marcus Oyelaran",
      MessageSid: "SM4471f2c9",
      timestamp: ago(3),
      Body: "Hi, following up on the quote for the 250 users - our board meets Thursday and I need a number before then. Can you send it today?",
    },
  },

  // ------------------------------------------------------------------
  // Renewal and expansion.
  // ------------------------------------------------------------------
  {
    channel: "EMAIL",
    demonstrates: "Renewal window with expansion interest",
    payload: {
      from: "Elena Rossi <e.rossi@ferrantegroup.it>",
      subject: "Our contract ends next month",
      date: ago(9),
      messageId: "<ferrante-55@ferrantegroup.it>",
      text: `Hello,

Our annual contract is up for renewal on the 30th. We'd like to renew and also add 15 seats for the new team in Milan.

Could you send updated terms?

Elena Rossi
Director of Revenue Operations`,
    },
  },
  {
    channel: "SMS",
    demonstrates: "Short-form high intent — brevity must not be read as low intent",
    payload: {
      From: "+14155550188",
      MessageSid: "SM99a1",
      timestamp: ago(7),
      Body: "Hi - how much for 5 users on the pro plan? Need to decide today.",
    },
  },

  // ------------------------------------------------------------------
  // Genuine but earlier-stage interest.
  // ------------------------------------------------------------------
  {
    channel: "LINKEDIN",
    demonstrates: "Demo request from a manager — warm, not hot",
    payload: {
      senderName: "Aisha Karim",
      senderHeadline: "Growth Marketing Manager at Loomly",
      companyName: "Loomly",
      conversationId: "li-conv-88213",
      messageId: "li-msg-4471",
      timestamp: ago(14),
      message:
        "Hi! Saw your post about inbound triage. Could we book a call next week to see a demo? Curious whether it works with our current stack.",
    },
  },
  {
    channel: "EMAIL",
    demonstrates: "Evaluating vendors, no budget confirmed yet",
    payload: {
      from: "Ben Kowalski <ben.kowalski@vertexmade.com>",
      subject: "Question about your platform",
      date: ago(20),
      messageId: "<vertex-12@vertexmade.com>",
      text: `Hi there,

We're putting together a shortlist and comparing you to a couple of alternatives. Is there a way to run a two-week pilot before committing?

Ben
Operations Lead`,
    },
  },
  {
    channel: "WEBFORM",
    demonstrates: "Small inbound lead from a personal address",
    payload: {
      name: "Sofia Almeida",
      email: "sofia.almeida.work@gmail.com",
      formName: "Contact us",
      submittedAt: ago(18),
      message: "Hi, I run a small studio with 3 people. Is there a plan that fits us?",
    },
  },

  // ------------------------------------------------------------------
  // Real work, but not revenue. Must not outrank a live deal.
  // ------------------------------------------------------------------
  {
    channel: "EMAIL",
    demonstrates: "Support issue from an existing user — real, but not a deal",
    payload: {
      from: "Raj Patel <raj.patel@quaymetrics.com>",
      subject: "Export is throwing a 500 error",
      date: ago(4),
      messageId: "<quay-401@quaymetrics.com>",
      text: `The CSV export has been failing since yesterday with a 500 error. I can't log in to the admin panel either.

How do I get this fixed?

Raj Patel
Data Analyst`,
    },
  },
  {
    channel: "SLACK",
    demonstrates: "Shared-channel product question — lowest channel bias",
    payload: {
      event: {
        text: "quick one - is there a way to bulk import contacts from a csv? checked the docs and couldn't find it",
        user_name: "Chloe Nguyen",
        thread_ts: "1721300000.000100",
        client_msg_id: "slack-msg-0091",
        ts: String(Math.floor((Date.now() - 11 * HOURS) / 1000)),
        user_profile: { real_name: "Chloe Nguyen", email: "chloe@tidalworks.com" },
      },
    },
  },

  // ------------------------------------------------------------------
  // Noise. The reason an unsorted shared inbox is useless. Note the first
  // one deliberately contains the word "pricing" — a naive keyword filter
  // would rank a marketing blast above a real buyer.
  // ------------------------------------------------------------------
  {
    channel: "EMAIL",
    demonstrates: 'Marketing blast containing the word "pricing" — must NOT rank as a lead',
    payload: {
      from: "SaaS Weekly <newsletter@saasweekly.co>",
      subject: "This week: pricing strategy, churn benchmarks and a free webinar",
      date: ago(6),
      messageId: "<news-9912@saasweekly.co>",
      text: `Hi there,

In this week's newsletter: how to rethink your pricing strategy, the latest churn benchmarks, and an invitation to our free webinar on Thursday.

Read online | Manage preferences | Unsubscribe`,
    },
  },
  {
    channel: "EMAIL",
    demonstrates: "Recruiter spam",
    payload: {
      from: "Gina Holloway <gina@apexplacements.net>",
      subject: "Exceptional candidates available immediately",
      date: ago(8),
      messageId: "<apex-77@apexplacements.net>",
      text: `Hello,

I came across your company and wanted to introduce our recruitment agency. We have several exceptional candidates available immediately and can offer very competitive placement fees.

Would you be open to a quick chat this week?

Gina Holloway
Senior Recruitment Consultant`,
    },
  },
  {
    channel: "EMAIL",
    demonstrates: "Cold agency pitch",
    payload: {
      from: "growth@rankboosters.biz",
      subject: "Your website could rank #1",
      date: ago(12),
      messageId: "<rank-1@rankboosters.biz>",
      text: `Hope this email finds you well.

I came across your website and noticed some issues holding back your rankings. We offer SEO services and link building starting at $299/month and can build your traffic within 90 days.

Interested in a free audit?`,
    },
  },
  {
    channel: "EMAIL",
    demonstrates: "Auto-reply",
    payload: {
      from: "Jonas Meyer <j.meyer@altmarkgmbh.de>",
      subject: "Automatic reply: Following up on our conversation",
      date: ago(10),
      messageId: "<altmark-oo1@altmarkgmbh.de>",
      text: `I am currently out of office and will return on the 14th. For urgent matters please contact my colleague.

This is an automated message — please do not reply.`,
    },
  },
];

async function main() {
  const slug = "demo";

  // Test isolation: smoke.sh draws its attack addresses from fixed documentation
  // ranges, so a second run can collide with the previous run's spent buckets and
  // fail for nothing. Throttle rows are ephemeral rate-limit state, not business
  // data, so a reseed starts them clean.
  await db.authThrottle.deleteMany({});

  // Idempotent: re-running the seed rebuilds the demo workspace cleanly rather
  // than stacking duplicate threads.
  const existing = await db.workspace.findUnique({ where: { slug } });
  if (existing) {
    console.log("Removing the previous demo workspace…");
    await db.workspace.delete({ where: { id: existing.id } });
  }

  const workspace = await db.workspace.create({
    data: {
      name: "Acme Revenue Team",
      slug,
      sellsWhat:
        "B2B SaaS for logistics and operations teams, sold per seat on annual contracts",
    },
  });

  const { plaintext, hashedKey, prefix } = generateApiKey();
  await db.apiKey.create({
    data: {
      workspaceId: workspace.id,
      name: "Seed key",
      hashedKey,
      prefix,
    },
  });

  // The dashboard is session-scoped, so a demo workspace nobody can sign in to
  // is a workspace nobody can look at. Upsert rather than create: deleting the
  // workspace above cascades its memberships and sessions, but the User row
  // stays, and `email` is unique.
  const demoEmail = "demo@abetconnect.dev";
  const demoPassword = process.env.SEED_PASSWORD ?? "demo-password";
  const demoPasswordHash = await hashPassword(demoPassword);

  const demoUser = await db.user.upsert({
    where: { email: demoEmail },
    // The seeded demo is a fixture, not a signup: there is no inbox to
    // click from, so it must verify itself. Real signups stay unverified
    // until they complete the email flow.
    update: { passwordHash: demoPasswordHash, name: "Demo Rep", emailVerified: true },
    create: {
      email: demoEmail,
      name: "Demo Rep",
      passwordHash: demoPasswordHash,
      emailVerified: true,
    },
  });

  await db.membership.upsert({
    where: { userId_workspaceId: { userId: demoUser.id, workspaceId: workspace.id } },
    update: { role: "OWNER" },
    create: { userId: demoUser.id, workspaceId: workspace.id, role: "OWNER" },
  });

  console.log(`\nWorkspace: ${workspace.name}`);
  console.log(`Sign in:   ${demoEmail} / ${demoPassword}`);
  console.log(`API key (shown once): ${plaintext}\n`);
  console.log(`Ingesting ${INBOX.length} messages through the real pipeline…\n`);

  const threadsByKey = new Map<string, string>();
  // What each thread is here to demonstrate, so the summary can be checked
  // against the engine's actual output rather than against intent.
  const notes = new Map<string, string[]>();

  for (const entry of INBOX) {
    const normalized = getAdapter(entry.channel).normalize(entry.payload);
    if (entry.direction) normalized.direction = entry.direction;
    entry.patch?.(normalized);

    const result = await ingestMessage(workspace, normalized, {
      threadId: entry.replyTo ? threadsByKey.get(entry.replyTo) : undefined,
    });
    if (entry.key) threadsByKey.set(entry.key, result.threadId);
    if (normalized.direction === "INBOUND") {
      notes.set(result.threadId, [
        ...(notes.get(result.threadId) ?? []),
        entry.demonstrates,
      ]);
    }
  }

  // Read the queue back in exactly the order the dashboard renders it. This is
  // the actual check on the engine, not the per-message return values.
  const queue = await db.thread.findMany({
    where: { workspaceId: workspace.id, status: "OPEN" },
    orderBy: [{ awaitingReply: "desc" }, { score: "desc" }, { lastMessageAt: "desc" }],
    include: { contact: true },
  });

  console.log("Ranked queue as produced by the engine:\n");
  for (const thread of queue) {
    const score = String(thread.score).padStart(3, " ");
    const bucket = thread.bucket.padEnd(7, " ");
    const intent = (thread.intent ?? "-").padEnd(10, " ");
    const channels = thread.channels.split(",").join("+").padEnd(16, " ");
    const who =
      thread.contact.name ?? thread.contact.email ?? thread.contact.phone ?? "unknown";
    console.log(`  ${score}  ${bucket} ${intent} ${channels} ${who}`);
    for (const note of notes.get(thread.id) ?? []) {
      console.log(`       ${note}`);
    }
  }

  const threads = await db.thread.count({ where: { workspaceId: workspace.id } });
  const drafts = await db.draft.count({
    where: { thread: { workspaceId: workspace.id }, status: "SUGGESTED" },
  });
  const contacts = await db.contact.count({ where: { workspaceId: workspace.id } });

  console.log(
    `\n${threads} threads, ${contacts} contacts, ${drafts} drafts ready. Start the app with: npm run dev\n`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
