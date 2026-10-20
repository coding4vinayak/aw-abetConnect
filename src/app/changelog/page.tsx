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
