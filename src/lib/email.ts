/**
 * Email sender abstraction.
 *
 * In development this logs to console with the full email content so you can
 * copy the verification/reset links. In production swap `createEmailSender`
 * for a real provider (Resend, SendGrid, Postmark, SES, etc.).
 */
export interface EmailSender {
  send(to: string, subject: string, html: string, text: string): Promise<void>;
}

export interface VerificationEmailData {
  name: string | null;
  verifyUrl: string;
  expiresHours: number;
}

export interface PasswordResetEmailData {
  name: string | null;
  resetUrl: string;
  expiresHours: number;
}

export function renderVerificationEmail(data: VerificationEmailData): { html: string; text: string } {
  const { name, verifyUrl, expiresHours } = data;
  const greeting = name ? `Hi ${name},` : "Hi,";

  const html = `
<!DOCTYPE html>
<html>
  <body style="font-family: system-ui, sans-serif; line-height: 1.6; color: #111;">
    <p>${greeting}</p>
    <p>Thanks for signing up for abetConnect. Please verify your email address by clicking the link below:</p>
    <p style="margin: 24px 0;">
      <a href="${verifyUrl}" style="background: #2563eb; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; display: inline-block;">
        Verify email address
      </a>
    </p>
    <p style="color: #666; font-size: 14px;">This link expires in ${expiresHours} hours. If you didn't create an account, you can safely ignore this email.</p>
    <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;">
    <p style="color: #999; font-size: 12px;">If the button doesn't work, copy this link into your browser:<br>${verifyUrl}</p>
  </body>
</html>
  `.trim();

  const text = `
${greeting}

Thanks for signing up for abetConnect. Please verify your email address by visiting this link:

${verifyUrl}

This link expires in ${expiresHours} hours. If you didn't create an account, you can safely ignore this email.
  `.trim();

  return { html, text };
}

export function renderPasswordResetEmail(data: PasswordResetEmailData): { html: string; text: string } {
  const { name, resetUrl, expiresHours } = data;
  const greeting = name ? `Hi ${name},` : "Hi,";

  const html = `
<!DOCTYPE html>
<html>
  <body style="font-family: system-ui, sans-serif; line-height: 1.6; color: #111;">
    <p>${greeting}</p>
    <p>You requested a password reset for your abetConnect account. Click the link below to set a new password:</p>
    <p style="margin: 24px 0;">
      <a href="${resetUrl}" style="background: #dc2626; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; display: inline-block;">
        Reset password
      </a>
    </p>
    <p style="color: #666; font-size: 14px;">This link expires in ${expiresHours} hour(s). If you didn't request this, you can safely ignore this email — your password won't change.</p>
    <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;">
    <p style="color: #999; font-size: 12px;">If the button doesn't work, copy this link into your browser:<br>${resetUrl}</p>
  </body>
</html>
  `.trim();

  const text = `
${greeting}

You requested a password reset for your abetConnect account. Visit this link to set a new password:

${resetUrl}

This link expires in ${expiresHours} hour(s). If you didn't request this, you can safely ignore this email — your password won't change.
  `.trim();

  return { html, text };
}

let _emailSender: EmailSender | null = null;

export function setEmailSender(sender: EmailSender): void {
  _emailSender = sender;
}

export function getEmailSender(): EmailSender {
  if (!_emailSender) {
    _emailSender = createDevEmailSender();
  }
  return _emailSender;
}

function createDevEmailSender(): EmailSender {
  return {
    async send(to: string, subject: string, _html: string, text: string): Promise<void> {
      const line = "=".repeat(72);
      console.log(`\n${line}\n📧 DEV EMAIL to ${to}\nSubject: ${subject}\n${line}\n${text}\n${line}\n`);
    },
  };
}
