"use client";

import Link from "next/link";
import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { signIn, signUp, type AuthState } from "@/app/auth-actions";

const INITIAL: AuthState = {};

const FIELD_CLASS =
  "w-full rounded-md border border-line bg-surface px-3 py-2 text-[13px] text-foreground placeholder:text-muted-dim focus:border-muted-dim focus:outline-none";

function SubmitButton({ label }: { label: string }) {
  // useFormStatus has to live inside the <form>, so the button is its own
  // component rather than inline markup.
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="w-full rounded-md bg-foreground px-3 py-2 text-[13px] font-medium text-background transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {pending ? "Working…" : label}
    </button>
  );
}

function Field({
  label,
  name,
  type,
  autoComplete,
  placeholder,
  required,
  autoFocus,
  invalid,
  errorId,
}: {
  label: string;
  name: string;
  type: string;
  autoComplete?: string;
  placeholder?: string;
  required?: boolean;
  autoFocus?: boolean;
  invalid?: boolean;
  errorId?: string;
}) {
  const fieldId = `field-${name}`;
  return (
    <label htmlFor={fieldId} className="block">
      <span className="mb-1.5 block text-[11px] font-medium uppercase tracking-wide text-muted-dim">
        {label}
      </span>
      <input
        id={fieldId}
        name={name}
        type={type}
        autoComplete={autoComplete}
        placeholder={placeholder}
        required={required}
        autoFocus={autoFocus}
        aria-invalid={invalid || undefined}
        aria-describedby={errorId}
        className={`${FIELD_CLASS} ${invalid ? "border-hot" : ""}`}
      />
      {invalid && errorId && (
        <p id={errorId} className="mt-1 text-[11px] text-hot" role="alert" aria-live="polite">
          {errorId}
        </p>
      )}
    </label>
  );
}

export function AuthForm({ mode }: { mode: "signup" | "login" }) {
  const isSignup = mode === "signup";
  const [state, action] = useActionState(isSignup ? signUp : signIn, INITIAL);

  // Generate unique error IDs for accessibility
  const nameErrorId = state.field === "name" && state.error ? "name-error" : undefined;
  const workspaceErrorId = state.field === "workspace" && state.error ? "workspace-error" : undefined;
  const emailErrorId = state.field === "email" && state.error ? "email-error" : undefined;
  const passwordErrorId = state.field === "password" && state.error ? "password-error" : undefined;

  return (
    <form action={action} className="space-y-3.5" noValidate>
      {state.error && (
        <p
          role="alert"
          className="rounded-md border border-hot/40 bg-hot/10 px-3 py-2 text-[12px] leading-relaxed text-foreground"
        >
          {state.error}
        </p>
      )}

      {isSignup && (
        <>
          <Field
            label="Your name"
            name="name"
            type="text"
            autoComplete="name"
            placeholder="Priya Raman"
            required
            autoFocus
            invalid={state.field === "name"}
            errorId={nameErrorId}
          />
          <Field
            label="Team or company"
            name="workspace"
            type="text"
            autoComplete="organization"
            placeholder="Northwind Logistics"
            invalid={state.field === "workspace"}
            errorId={workspaceErrorId}
          />
        </>
      )}

      <Field
        label="Work email"
        name="email"
        type="email"
        autoComplete="email"
        placeholder="you@company.com"
        required
        autoFocus={!isSignup}
        invalid={state.field === "email"}
        errorId={emailErrorId}
      />
      <Field
        label="Password"
        name="password"
        type="password"
        autoComplete={isSignup ? "new-password" : "current-password"}
        placeholder={isSignup ? "At least 8 characters" : "••••••••"}
        required
        invalid={state.field === "password"}
        errorId={passwordErrorId}
      />

      <SubmitButton label={isSignup ? "Create workspace" : "Sign in"} />

      {!isSignup && (
        <p className="pt-1 text-center text-[12px] text-muted-dim">
          <Link href="/reset-password" className="text-foreground underline underline-offset-2">
            Forgot password?
          </Link>
        </p>
      )}

      <p className="pt-1 text-center text-[12px] text-muted-dim">
        {!isSignup ? (
          <>
            Already have an account?{" "}
            <Link href="/login" className="text-foreground underline underline-offset-2">
              Sign in
            </Link>
          </>
        ) : (
          <>
            No account yet?{" "}
            <Link href="/signup" className="text-foreground underline underline-offset-2">
              Create one
            </Link>
          </>
        )}
      </p>
    </form>
  );
}