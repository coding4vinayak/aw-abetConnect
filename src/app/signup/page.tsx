import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AuthForm } from "@/components/auth-form";
import { SiteFooter } from "@/components/site";
import { getSession } from "@/lib/session";

export const metadata: Metadata = {
  title: "Create your workspace — abetConnect",
  description:
    "One inbox for email, WhatsApp, SMS, Slack, LinkedIn and web forms, ranked by who is closest to buying.",
};

// Reads the session cookie, so it can never be prerendered.
export const dynamic = "force-dynamic";

export default async function SignUpPage() {
  // Someone already signed in does not want a signup form.
  if (await getSession()) redirect("/");

  return (
    <>
    <main className="flex h-full items-center justify-center overflow-y-auto px-6 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6">
          <h1 className="text-[15px] font-semibold tracking-tight text-foreground">
            Create your workspace
          </h1>
          <p className="mt-1.5 text-[12px] leading-relaxed text-muted">
            Your inbox, scored. Every conversation from every channel in one queue, ranked by
            who is closest to buying.
          </p>
        </div>

        <AuthForm mode="signup" />

        <p className="mt-5 text-[11px] leading-relaxed text-muted-dim">
          Signing up creates a private workspace. Nothing is shared with anyone else, and no
          inbox is connected until you connect it.
        </p>
      </div>
    </main>
    <SiteFooter />
    </>
  );
}
