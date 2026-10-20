// The mail transport and the billing templates, offline.
//
// The property that keeps "check your inbox" from being a lie: the sender says
// which transport actually ran. The property that keeps billing mail honest:
// every subject names the event it reports, and every link points at a page
// on this deployment.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  emailSenderChannel,
  getEmailSender,
  isMailConfigured,
  renderCancellationEmail,
  renderPasswordResetEmail,
  renderPaymentFailedEmail,
  renderPaymentRecoveredEmail,
  renderReceiptEmail,
  renderTrialEndedEmail,
  renderTrialEndingEmail,
  renderVerificationEmail,
  setEmailSender,
  verificationEnforced,
  type EmailSender,
} from "../../src/lib/email";

describe("mail transport honesty", () => {
  it("reports no provider when none is configured", () => {
    if (isMailConfigured()) return; // an operator configured one; nothing to assert
    assert.equal(verificationEnforced(), false);
    assert.equal(emailSenderChannel(), "log");
  });

  it("logs the message and says so when no provider exists", async () => {
    if (isMailConfigured()) return;
    const result = await getEmailSender().send("buyer@sim.test", "Subject line", "<p>html</p>", "plain body");
    // The caller can therefore tell the user the message was logged, not sent.
    assert.equal(result.channel, "log");
    assert.equal(result.log, "plain body");
  });

  it("enforces verification exactly when a provider exists", () => {
    assert.equal(verificationEnforced(), isMailConfigured());
  });

  it("a provider failure is an error, not a swallowed no-op", async () => {
    // Swallowing this is how a customer waits for a link that was never sent.
    const failing: EmailSender = {
      async send() {
        throw new Error("provider refused the message");
      },
    };
    setEmailSender(failing);
    assert.equal(emailSenderChannel(), "custom");
    await assert.rejects(getEmailSender().send("a@b.test", "s", "h", "t"), /provider refused/);
  });
});

describe("the billing templates say the event, and link home", () => {
  it("a receipt for a payment, with the portal link", () => {
    const { subject, text } = renderReceiptEmail({
      product: "abetConnect",
      name: "Ada",
      planLabel: "abetConnect subscription",
      periodEnd: new Date("2026-11-19T00:00:00Z"),
      portalUrl: "https://connect.test/members",
    });
    assert.match(subject, /payment received/);
    assert.match(text, /Billing portal: https:\/\/connect\.test\/members/);
  });

  it("a receipt for a trial says trial started, not payment received", () => {
    const { subject, text } = renderReceiptEmail({
      product: "abetConnect",
      name: "Ada",
      planLabel: "abetConnect subscription",
      periodEnd: new Date("2026-11-19T00:00:00Z"),
      portalUrl: "https://connect.test/members",
      trialing: true,
    });
    assert.match(subject, /trial started/);
    assert.doesNotMatch(subject, /payment received/);
    assert.match(text, /first invoice is dated/);
    assert.match(text, /Billing portal: https:\/\/connect\.test\/members/);
  });

  it("the conversion mail names the trial and the next invoice", () => {
    const { subject, text } = renderTrialEndedEmail({
      product: "abetConnect",
      name: "Ada",
      periodEnd: new Date("2026-12-03T00:00:00Z"),
      portalUrl: "https://connect.test/members",
    });
    assert.match(subject, /trial is now a paid plan/);
    assert.match(text, /Billing portal: https:\/\/connect\.test\/members/);
  });

  it("the three-day warning says when the charge lands and how to avoid it", () => {
    const { subject, text } = renderTrialEndingEmail({
      product: "abetConnect",
      name: "Ada",
      daysLeft: 3,
      periodEnd: new Date("2026-11-02T00:00:00Z"),
      portalUrl: "https://connect.test/members",
    });
    assert.match(subject, /trial ends in 3 days/);
    assert.match(text, /first invoice is dated/);
    assert.match(text, /cancel from the billing portal/i);
    assert.match(text, /Billing portal: https:\/\/connect\.test\/members/);
  });

  it("dunning names the payment, and points at the card", () => {
    const { subject, text } = renderPaymentFailedEmail({
      product: "abetConnect",
      name: null,
      portalUrl: "https://connect.test/members",
    });
    assert.match(subject, /payment failed/);
    assert.match(text, /Update payment method: https:\/\/connect\.test\/members/);
  });

  it("recovery thanks the buyer and sends them back to the queue", () => {
    const { subject, text } = renderPaymentRecoveredEmail({
      product: "abetConnect",
      name: "Ada",
      appUrl: "https://connect.test/",
    });
    assert.match(subject, /payment recovered/);
    assert.match(text, /Back to the queue/);
  });

  it("cancellation answers the two questions a cancellation raises", () => {
    const { subject, text } = renderCancellationEmail({
      product: "abetConnect",
      name: null,
      pricingUrl: "https://connect.test/pricing",
    });
    assert.match(subject, /subscription is canceled/);
    assert.match(text, /no further charge/);
    assert.match(text, /Choose a plan: https:\/\/connect\.test\/pricing/);
  });

  it("verification carries the link and the expiry the caller stated", () => {
    const { html, text } = renderVerificationEmail({
      name: "Ada",
      verifyUrl: "https://connect.test/verify-email?token=t0k",
      expiresHours: 24,
    });
    assert.match(text, /https:\/\/connect\.test\/verify-email\?token=t0k/);
    assert.match(text, /24 hours/);
    assert.match(html, /Confirm email address/);
  });

  it("escapes what a buyer typed — a mail is not a script tag", () => {
    const { html } = renderPasswordResetEmail({
      name: '<script>alert("x")</script>',
      resetUrl: "https://connect.test/reset-password?token=t",
      expiresHours: 1,
    });
    assert.doesNotMatch(html, /<script>alert/);
  });
});
