import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AuthForm } from "@/components/auth-form";
import { SiteFooter } from "@/components/site";
import { getSession } from "@/lib/session";

export const metadata: Metadata = {
  title: "Sign in — abetConnect",
};

// Reads the session cookie, so it can never be prerendered.
export const dynamic = "force-dynamic";

export default async function LoginPage() {
  if (await getSession()) redirect("/");

  return (
    <>
    <main className="flex h-full items-center justify-center overflow-y-auto px-6 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6">
          <h1 className="text-[15px] font-semibold tracking-tight text-foreground">Sign in</h1>
          <p className="mt-1.5 text-[12px] leading-relaxed text-muted">
            Welcome back to your queue.
          </p>
        </div>

        <AuthForm mode="login" />
      </div>
    </main>
    <SiteFooter />
    </>
  );
}
