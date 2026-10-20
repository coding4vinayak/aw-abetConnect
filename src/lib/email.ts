/**
 * Outbound email.
 *
 * The rule this file exists to enforce: **the caller is always told which
 * transport actually ran.** `send` returns the channel it used, so a route can
 * distinguish "we emailed you" from "this deployment has no mail provider, so
 * the message was written to the server log instead". A `send` that quietly
 * logged to stdout while the API answered "check your inbox" is the failure
 * mode this replaces — it looks like the feature works right up until a
 * customer waits for a link that was never coming.
 *
 * The HTTP sender is deliberately dependency-free (`fetch` only). An owner who
 * prefers SMTP or SES calls `setEmailSender` with their own implementation;
 * no route changes.
 */

export type DeliveryChannel = "http" | "log" | "custom";

export interface EmailResult {
  channel: DeliveryChannel;
  /** Present only for "log": the full message, so a local run can copy the link. */
  log?: string;
}

export interface EmailSender {
  send(to: string, subject: string, html: string, text: string): Promise<EmailResult>;
}

/**
 * True when a real provider is configured. Callers use this to decide whether
 * verification is enforced at sign-in — see `verificationEnforced`.
 */
export function isMailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY || process.env.EMAIL_WEBHOOK_URL);
}

/**
 * Verification is only enforced when a message can actually arrive.
 *
 * Enforcing it without a provider would lock every new account out of its own
 * product on a deployment that was never configured for email, which is a far
 * worse failure than a typo'd signup address staying unverified. So the gate
 * follows the transport: configured, an unverified address cannot sign in; not
 * configured, it can, and the address is marked verified at signup.
 */
export function verificationEnforced(): boolean {
  return isMailConfigured();
}

/** Write the message to the server log, and say so. Never a silent no-op. */
function createLogEmailSender(): EmailSender {
  return {
    async send(to, subject, _html, text): Promise<EmailResult> {
      const line = "=".repeat(72);
      const body = [
        "",
        line,
        `EMAIL (not delivered — no mail provider configured) to: ${to}`,
        `Subject: ${subject}`,
        line,
        text,
        line,
        "",
      ].join("\n");
      console.log(body);
      return { channel: "log", log: text };
    },
  };
}

/**
 * Generic HTTP sender. Works with Resend and anything that takes the same
 * `{from, to, subject, html, text}` JSON, so switching provider is an env
 * change rather than a code change.
 */
function createHttpEmailSender(): EmailSender {
  const apiKey = process.env.RESEND_API_KEY;
  const endpoint = process.env.EMAIL_WEBHOOK_URL ?? "https://api.resend.com/emails";
  const from = process.env.EMAIL_FROM ?? "Abetworks <noreply@abetworks.in>";

  return {
    async send(to, subject, html, text): Promise<EmailResult> {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (apiKey && endpoint.includes("resend.com")) headers.authorization = `Bearer ${apiKey}`;
      if (process.env.EMAIL_WEBHOOK_TOKEN) headers.authorization = `Bearer ${process.env.EMAIL_WEBHOOK_TOKEN}`;

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10_000);
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          signal: ctrl.signal,
          headers,
          body: JSON.stringify({ from, to: [to], subject, html, text }),
        });
        if (!res.ok) {
          // Reported as a failure rather than swallowed: a provider rejecting
          // mail is an operational problem, and pretending otherwise means a
          // customer never gets the link and nobody is paged.
          throw new Error(`mail provider refused the message: ${res.status}`);
        }
        return { channel: "http" };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

let _sender: EmailSender | null = null;

export function setEmailSender(sender: EmailSender): void {
  _sender = sender;
}

export function getEmailSender(): EmailSender {
  if (!_sender) _sender = isMailConfigured() ? createHttpEmailSender() : createLogEmailSender();
  return _sender;
}

export function emailSenderChannel(): DeliveryChannel {
  if (_sender) return "custom";
  return isMailConfigured() ? "http" : "log";
}

// ------------------------------------------------------------- identity

/** The product's name as mail should say it. One source, env-overridable. */
export function productName(): string {
  return process.env.PRODUCT_NAME ?? "abetConnect";
}

/**
 * The base URL this deployment answers on. Mail links are the one place a
 * wrong origin is invisible until a customer clicks, so it is read in one
 * helper rather than pasted into each caller.
 */
export function appBaseUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/+$/, "");
}

// ---------------------------------------------------------------- templates

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function layout(
  product: string,
  heading: string,
  body: string,
  ctaLabel: string,
  url: string,
  note?: string,
): { html: string; text: string } {
  const text = [heading, "", body, "", `${ctaLabel}: ${url}`, ...(note ? ["", note] : [])].join("\n");

  const html = `<!doctype html>
<html><body style="margin:0;background:#f9fafb;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#111827">
  <div style="max-width:520px;margin:0 auto;padding:32px 16px">
    <div style="background:#fff;border:1px solid #e5e7eb;border-radius:16px;padding:32px">
      <p style="margin:0 0 4px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#9ca3af">Abetworks</p>
      <h1 style="margin:0 0 16px;font-size:20px;line-height:1.3">${escapeHtml(product)}</h1>
      <h2 style="margin:0 0 12px;font-size:17px">${escapeHtml(heading)}</h2>
      <p style="margin:0 0 24px;font-size:14px;line-height:1.6;color:#4b5563">${escapeHtml(body)}</p>
      <a href="${escapeHtml(url)}" style="display:inline-block;background:#111827;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-size:14px;font-weight:600">${escapeHtml(ctaLabel)}</a>
      <p style="margin:24px 0 0;font-size:12px;line-height:1.6;color:#6b7280;word-break:break-all">Or paste this into your browser:<br>${escapeHtml(url)}</p>
      ${note ? `<p style="margin:20px 0 0;font-size:12px;color:#9ca3af">${escapeHtml(note)}</p>` : ""}
    </div>
  </div>
</body></html>`;

  return { html, text };
}

export interface VerificationEmailData {
  name: string | null;
  verifyUrl: string;
  expiresHours: number;
}

export function renderVerificationEmail(data: VerificationEmailData): { html: string; text: string } {
  const greeting = data.name ? `Hi ${data.name},` : "Hi,";
  return layout(
    productName(),
    "Confirm your email address",
    `${greeting} thanks for signing up for abetConnect. Confirm this address to finish setting up your workspace. The link works once and expires in ${data.expiresHours} hours.`,
    "Confirm email address",
    data.verifyUrl,
    "If you didn't create an account, ignore this email and nothing changes.",
  );
}

export interface PasswordResetEmailData {
  name: string | null;
  resetUrl: string;
  expiresHours: number;
}

export function renderPasswordResetEmail(data: PasswordResetEmailData): { html: string; text: string } {
  const greeting = data.name ? `Hi ${data.name},` : "Hi,";
  return layout(
    productName(),
    "Set a new password",
    `${greeting} you requested a password reset for your abetConnect account. The link works once and expires in ${data.expiresHours} hour(s).`,
    "Set a new password",
    data.resetUrl,
    "If you didn't request this, ignore this email — your current password still works.",
  );
}

export function renderReceiptEmail(data: {
  product: string;
  name: string | null;
  planLabel: string;
  periodEnd: Date | null;
  portalUrl: string;
  trialing?: boolean;
}): { subject: string; html: string; text: string } {
  const greeting = data.name ? `Hi ${data.name},` : "Hi,";
  const renews = data.periodEnd
    ? new Intl.DateTimeFormat("en", { dateStyle: "long" }).format(data.periodEnd)
    : "your next billing date";
  if (data.trialing) {
    return {
      subject: `${data.product} — trial started`,
      ...layout(
        data.product,
        "Trial started",
        `${greeting} your ${data.planLabel} trial is active. Your first invoice is dated ${renews}. Cancel any time from the billing portal before then and you are not charged.`,
        "Billing portal",
        data.portalUrl,
      ),
    };
  }
  return {
    subject: `${data.product} — payment received`,
    ...layout(
      data.product,
      "Payment received",
      `${greeting} your ${data.planLabel} is active. Your next invoice is dated ${renews}. Manage your card, invoices or cancellation any time from the billing portal.`,
      "Billing portal",
      data.portalUrl,
    ),
  };
}

/**
 * Trial over, first real charge taken. The buyer could cancel here, so this is
 * the one email that has to remind them why they bought — no feature pitch,
 * just the plain fact that the trial converted and what the next invoice is.
 */
export function renderTrialEndedEmail(data: {
  product: string;
  name: string | null;
  periodEnd: Date | null;
  portalUrl: string;
}): { subject: string; html: string; text: string } {
  const greeting = data.name ? `Hi ${data.name},` : "Hi,";
  const next = data.periodEnd
    ? new Intl.DateTimeFormat("en", { dateStyle: "long" }).format(data.periodEnd)
    : "your next billing date";
  return {
    subject: `Your ${data.product} trial is now a paid plan`,
    ...layout(
      data.product,
      "Trial ended — paid plan active",
      `${greeting} your 14-day trial just converted and your first payment went through. Your next invoice is dated ${next}. Everything stays exactly as you left it; cancel any time from the portal and you are not billed again.`,
      "Billing portal",
      data.portalUrl,
    ),
  };
}

/**
 * Dunning. A declined card that nobody mentions is churn in slow motion: the
 * buyer thinks everything is fine until access stops. This email goes out on
 * every invoice.payment_failed that leaves the subscription in a dunning
 * status, so the last warning before Stripe gives up is always seen.
 */
export function renderPaymentFailedEmail(data: {
  product: string;
  name: string | null;
  portalUrl: string;
}): { subject: string; html: string; text: string } {
  const greeting = data.name ? `Hi ${data.name},` : "Hi,";
  return {
    subject: `Action needed — your ${data.product} payment failed`,
    ...layout(
      data.product,
      "We could not take your last payment",
      `${greeting} your most recent invoice was declined. Your card updates and retries automatically, but the fastest fix is to confirm a working card in the billing portal. If payment keeps failing, access to your workspace ends when Stripe cancels the subscription.`,
      "Update payment method",
      data.portalUrl,
    ),
  };
}

/**
 * The card worked again. Short, and says thank you — a customer who fixed a
 * failed payment is one support ticket away from churning, and this email is
 * the cheapest way to make sure they do not open it.
 */
export function renderPaymentRecoveredEmail(data: {
  product: string;
  name: string | null;
  appUrl: string;
}): { subject: string; html: string; text: string } {
  const greeting = data.name ? `Hi ${data.name},` : "Hi,";
  return {
    subject: `${data.product} — payment recovered, thanks for fixing it`,
    ...layout(
      data.product,
      "You are back in good standing",
      `${greeting} your last invoice has been paid and your workspace is back in good standing. Nothing changed while it was past due — your data, conversations and history are all where you left them.`,
      "Back to the queue",
      data.appUrl,
    ),
  };
}

/**
 * The cancellation confirmation. They already clicked cancel in the portal, so
 * this is not a retention attempt dressed as a receipt — asking twice in the
 * same email is what gets a billing message marked as spam. It answers the two
 * questions a cancellation actually raises: will I be charged again, and is my
 * data gone. Then one link, and no pressure.
 */
export function renderCancellationEmail(data: {
  product: string;
  name: string | null;
  pricingUrl: string;
}): { subject: string; html: string; text: string } {
  const greeting = data.name ? `Hi ${data.name},` : "Hi,";
  return {
    subject: `${data.product} — your subscription is canceled`,
    ...layout(
      data.product,
      "Canceled, and nothing was deleted",
      `${greeting} your ${data.product} subscription has ended. There is nothing left to cancel and no further charge will be made. Your workspace and everything in it are still there — sign in whenever you like. If it turns out to have earned its place, starting a new plan is one page.`,
      "Choose a plan",
      data.pricingUrl,
    ),
  };
}
