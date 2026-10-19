"use client";

import { useState } from "react";

/**
 * The resend door for the verification mail, for the one state where it
 * matters: a provider is configured (so sign-in will demand the click) and the
 * signed-in address is still unverified. It posts to the session-gated route
 * that has existed all along — what was missing was a place to press it.
 */
export function VerifyBanner() {
  const [state, setState] = useState<"idle" | "busy" | "sent" | "error">("idle");

  async function resend() {
    setState("busy");
    try {
      const res = await fetch("/api/auth/send-verification", { method: "POST" });
      setState(res.ok ? "sent" : "error");
    } catch {
      setState("error");
    }
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-amber-200 bg-amber-50 px-4 py-1.5 text-[11px] text-amber-900">
      <span>
        {state === "sent"
          ? "Verification email sent — check your inbox."
          : "Confirm your email address so signing in keeps working from other devices."}
      </span>
      {state !== "sent" && (
        <button
          type="button"
          onClick={resend}
          disabled={state === "busy"}
          className="rounded-md border border-amber-300 px-2 py-0.5 font-semibold transition hover:bg-amber-100 disabled:opacity-50"
        >
          {state === "busy" ? "Sending…" : state === "error" ? "Couldn't send — try again" : "Resend email"}
        </button>
      )}
    </div>
  );
}
