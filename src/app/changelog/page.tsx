import type { Metadata } from "next";
import { SiteNav, SiteFooter } from "@/components/site";

export const metadata: Metadata = {
  title: "Changelog — abetConnect",
  description: "What changed in abetConnect, newest first.",
};

export default function Page() {
  return (
    <div className="min-h-screen bg-surface text-foreground">
      <SiteNav />
      <main className="mx-auto max-w-4xl px-6 py-12">
        <h1 className="text-3xl font-bold tracking-tight">Changelog</h1>
        <p className="mt-2 text-muted">Newest first. Breaking changes are marked <strong>BREAKING</strong> and get 30 days&apos; notice here before they ship.</p>
        <div className="mt-8 space-y-8 border-l-2 border-blue-600 pl-6">
          <div>
            <p className="text-sm text-muted">October 2026</p>
            <h2 className="text-lg font-bold">v1.2.0 — See the demo without an account</h2>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-muted">
              <li>This app has no marketing page — the queue is the front door — so a visitor who was not signed in used to meet a login form and nothing else. Now they meet the demo: the example conversations, scored by the same engine a real message goes through, with a plain note saying which one they are looking at and a way to sign in.</li>
              <li>The sign-in page offers the same demo, so the promise is where the form is.</li>
              <li>Nothing else about access changed: another customer&apos;s workspace is still refused rather than served, and a deployment with no demo seeded sends visitors to sign in instead of showing an empty page.</li>
            </ul>
          </div>
          <div>
            <p className="text-sm text-muted">October 2026</p>
            <h2 className="text-lg font-bold">v1.1.0 — See the queue work</h2>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-muted">
              <li>An empty workspace can load a sample inbox in one click: six example conversations scored by the same engine a real message goes through, so the ranking and the reasons are the product&apos;s own — a cancellation threat at the top, a real enquiry next, a marketing blast at the floor.</li>
              <li>The sample is unmistakably example data (every address is on <code>example.com</code>) and one click removes it again: the example conversations and their threads, and nothing else.</li>
            </ul>
          </div>
          <div>
            <p className="text-sm text-muted">October 2026</p>
            <h2 className="text-lg font-bold">v1.0.2 — Your data leaves with you</h2>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-muted">
              <li>Owners and admins can download the whole workspace — contacts, conversations, messages, score signals, drafts, team, invitations and webhook settings — as one JSON file from Team → Your data.</li>
              <li>Credentials and billing are deliberately excluded: no passwords, sessions, API keys, invitation links, webhook signing secrets or Stripe ids.</li>
              <li>The pricing FAQ, terms and privacy page now point at the real export door.</li>
            </ul>
          </div>
          <div>
            <p className="text-sm text-muted">October 2026</p>
            <h2 className="text-lg font-bold">v1.0.1 — Seats that match the team</h2>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-muted">
              <li>Per-agent billing now bills every member and every live invitation at checkout — the team page shows the paid count, and the billing portal is where seats go up or down.</li>
              <li>Invitations stop at the paid count instead of promising access the invoice did not cover.</li>
              <li>Re-inviting an outstanding address rotates its link without costing another seat.</li>
            </ul>
          </div>
          <div>
            <p className="text-sm text-muted">September 2026</p>
            <h2 className="text-lg font-bold">v1.0.0 — Initial public release</h2>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-muted">
              <li>General availability: WhatsApp, email, and webchat land in one inbox — scored by buying intent, so your team answers the money first.</li>
              <li>Public pricing, terms, privacy, and support pages.</li>
              <li>Live demo workspace, no card required.</li>
            </ul>
          </div>
        </div>
        <p className="mt-8 text-muted">How we version: <code>major.minor.patch</code>. Minor adds features, patch fixes bugs, major is reserved for contract changes — and those are announced here first.</p>
      </main>
      <SiteFooter />
    </div>
  );
}
