"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

/**
 * The sample inbox's two buttons: load it, and take it away again.
 *
 * It talks to `/api/example-data` over the session and then asks the server to
 * re-render, so what appears on screen is the queue the product computed —
 * scored by the engine, in the order the product would put it — and not
 * anything this component invented.
 */
export function ExampleInbox({ loaded }: { loaded: boolean }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function call(method: "POST" | "DELETE") {
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch("/api/example-data", { method });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setError(body.error || "Could not reach the server.");
          return;
        }
        router.refresh();
      } catch {
        setError("Network error — try again.");
      }
    });
  }

  if (loaded) {
    return (
      <div className="flex flex-wrap items-center gap-3 border-b border-line bg-amber-50 px-4 py-2 text-[12px] text-amber-900">
        <span>
          <strong>Sample inbox.</strong> These conversations are examples, from{" "}
          <code>@example.com</code> — the ranking and the reasons are the engine&rsquo;s.
        </span>
        <button
          type="button"
          onClick={() => call("DELETE")}
          disabled={pending}
          className="rounded-md border border-amber-300 bg-white px-2 py-1 text-[12px] font-medium text-amber-900 transition hover:bg-amber-100 disabled:opacity-50"
        >
          {pending ? "Working…" : "Remove the sample"}
        </button>
        {error && <span className="text-red-700">{error}</span>}
      </div>
    );
  }

  return (
    <div className="mt-4">
      <button
        type="button"
        onClick={() => call("POST")}
        disabled={pending}
        className="rounded-md border border-line px-3 py-1.5 text-[12px] font-medium text-foreground transition hover:bg-surface-raised disabled:opacity-50"
      >
        {pending ? "Loading…" : "Load a sample inbox"}
      </button>
      <p className="mt-2 text-[12px] leading-relaxed text-muted">
        Six example conversations, so you can see what the queue does — a real enquiry at the top, a
        churn risk that still outranks a newsletter, and the reason for each. One click removes it
        again.
      </p>
      {error && <p className="mt-2 text-[12px] text-red-700">{error}</p>}
    </div>
  );
}
