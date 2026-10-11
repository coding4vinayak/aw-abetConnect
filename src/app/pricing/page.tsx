import type { Metadata } from "next";
import { SiteNav, SiteFooter } from "@/components/site";
import { BuyButton } from "@/components/buy-button";

export const metadata: Metadata = {
  title: "Pricing — abetConnect",
  description: "abetConnect pricing: $24 per agent/month.",
};

export default function Page() {
  return (
    <div className="min-h-screen bg-surface text-foreground">
      <SiteNav />
      <main className="mx-auto max-w-4xl px-6 py-12">
        <h1 className="text-3xl font-bold tracking-tight">Pricing</h1>
        <p className="mt-2 text-muted">One plan, everything included. Enterprise adds SSO, audit exports, and a 99.9% SLA.</p>
        <div className="mt-8 grid gap-6 sm:grid-cols-3">
          <div className="rounded-2xl border p-6 border-line bg-surface-raised">
            <p className="text-sm font-semibold uppercase tracking-wide text-muted">Monthly</p>
            <p className="mt-2 text-4xl font-bold">$24</p>
            <p className="mt-1 text-sm text-muted">per agent/month</p>
            <div className="mt-6"><BuyButton priceId="SEAT_MONTHLY" label="Start now" /></div>
          </div>
          <div className="rounded-2xl border-2 border-blue-600 p-6 bg-surface-raised">
            <p className="text-sm font-semibold uppercase tracking-wide text-blue-600">Annual — 2 months free</p>
            <p className="mt-2 text-4xl font-bold">$240</p>
            <p className="mt-1 text-sm text-muted">per agent/month, billed yearly</p>
            <div className="mt-6"><BuyButton priceId="SEAT_ANNUAL" label="Go annual" /></div>
          </div>
          <div className="rounded-2xl border p-6 border-line bg-surface-raised">
            <p className="text-sm font-semibold uppercase tracking-wide text-muted">Enterprise</p>
            <p className="mt-2 text-4xl font-bold">Custom</p>
            <p className="mt-1 text-sm text-muted">SSO, audit exports, SLA, onboarding</p>
            <a href="mailto:support@abetworks.in?subject=abetConnect%20enterprise" className="mt-6 block rounded-lg border border-blue-600 px-4 py-2 text-center text-sm font-semibold text-blue-600 hover:bg-blue-50 transition">Talk to us</a>
          </div>
        </div>
        <h2 className="mt-12 text-xl font-bold">Questions</h2>
        <div className="mt-4 space-y-4">
          <div><p className="font-semibold text-foreground">Is there a trial?</p><p className="mt-1 text-muted">Yes — sign in and the demo workspace walks you through a live queue. No card required.</p></div>
          <div><p className="font-semibold text-foreground">Can I cancel anytime?</p><p className="mt-1 text-muted">Yes. Plans are month-to-month; service runs to the end of your billing period.</p></div>
          <div><p className="font-semibold text-foreground">Who owns our conversation data?</p><p className="mt-1 text-muted">You do. Export anytime; we never sell data or train shared models on it.</p></div>
          <div><p className="font-semibold text-foreground">Do you offer annual billing?</p><p className="mt-1 text-muted">Yes — $240 per agent per year, two months free, one invoice.</p></div>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
