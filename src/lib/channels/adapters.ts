import type { Channel, NormalizedMessage } from "@/lib/types";
import {
  coerceDate,
  companyFromEmail,
  extractTitle,
  normalisePhone,
  parseAddress,
  synthesiseSubject,
} from "./parse";

/**
 * A channel adapter turns one provider's webhook payload into the canonical
 * NormalizedMessage. Adding a channel means adding one function here and
 * nothing else — the scoring engine, the API and the UI stay untouched.
 */
export interface ChannelAdapter {
  channel: Channel;
  /** Human label for the UI. */
  label: string;
  /** Provider names this adapter is known to accept. */
  providers: string[];
  normalize(payload: Record<string, unknown>): NormalizedMessage;
}

export class AdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdapterError";
  }
}

function str(payload: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = key.split(".").reduce<unknown>((acc, part) => {
      if (acc && typeof acc === "object") return (acc as Record<string, unknown>)[part];
      return undefined;
    }, payload);
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number") return String(value);
  }
  return undefined;
}

function requireBody(payload: Record<string, unknown>, ...keys: string[]): string {
  const body = str(payload, ...keys);
  if (!body) {
    throw new AdapterError(
      `message body is required (looked for: ${keys.join(", ")})`,
    );
  }
  return body;
}

/**
 * Email. Accepts the common shapes emitted by SendGrid inbound parse,
 * Postmark and Mailgun, plus a plain {from, subject, text} object.
 */
const emailAdapter: ChannelAdapter = {
  channel: "EMAIL",
  label: "Email",
  providers: ["generic", "sendgrid", "postmark", "mailgun"],
  normalize(payload) {
    const body = requireBody(payload, "text", "TextBody", "body-plain", "body", "html");
    const from = parseAddress(
      str(payload, "from", "From", "sender", "FromFull.Email") ?? undefined,
    );
    const name =
      from.name ?? str(payload, "FromName", "FromFull.Name", "from_name") ?? undefined;
    const subject = str(payload, "subject", "Subject");
    return {
      channel: "EMAIL",
      direction: "INBOUND",
      body,
      subject,
      sentAt: coerceDate(str(payload, "date", "Date", "timestamp", "sentAt")),
      externalId: str(payload, "messageId", "MessageID", "Message-Id", "message-id", "id"),
      conversationRef:
        str(payload, "threadId", "inReplyTo", "In-Reply-To", "references") ?? subject,
      contact: {
        name,
        email: from.email,
        company: companyFromEmail(from.email),
        title: extractTitle(body),
      },
      raw: payload,
    };
  },
};

/** WhatsApp. Handles Twilio's form-encoded shape and Meta Cloud API's JSON. */
const whatsappAdapter: ChannelAdapter = {
  channel: "WHATSAPP",
  label: "WhatsApp",
  providers: ["twilio", "meta", "generic"],
  normalize(payload) {
    const body = requireBody(payload, "Body", "text.body", "message", "body");
    const phone = normalisePhone(
      str(payload, "From", "from", "wa_id", "phone")?.replace(/^whatsapp:/i, ""),
    );
    const name = str(payload, "ProfileName", "profile.name", "name", "contactName");
    return {
      channel: "WHATSAPP",
      direction: "INBOUND",
      body,
      subject: synthesiseSubject(body),
      sentAt: coerceDate(str(payload, "timestamp", "sentAt")),
      externalId: str(payload, "MessageSid", "SmsMessageSid", "id", "messageId"),
      conversationRef: phone,
      contact: { name, phone, title: extractTitle(body) },
      raw: payload,
    };
  },
};

/** SMS. Same providers as WhatsApp, different channel semantics downstream. */
const smsAdapter: ChannelAdapter = {
  channel: "SMS",
  label: "SMS",
  providers: ["twilio", "vonage", "generic"],
  normalize(payload) {
    const body = requireBody(payload, "Body", "text", "message", "body");
    const phone = normalisePhone(str(payload, "From", "from", "msisdn", "phone"));
    return {
      channel: "SMS",
      direction: "INBOUND",
      body,
      subject: synthesiseSubject(body),
      sentAt: coerceDate(str(payload, "timestamp", "sentAt", "message-timestamp")),
      externalId: str(payload, "MessageSid", "messageId", "id"),
      conversationRef: phone,
      contact: { name: str(payload, "ProfileName", "name"), phone },
      raw: payload,
    };
  },
};

/** Slack Events API. Unwraps the `event` envelope when present. */
const slackAdapter: ChannelAdapter = {
  channel: "SLACK",
  label: "Slack",
  providers: ["slack"],
  normalize(payload) {
    const envelope =
      (payload.event as Record<string, unknown> | undefined) ?? payload;
    const body = requireBody(envelope, "text", "message.text");
    const userName =
      str(envelope, "user_name", "username", "user_profile.real_name") ??
      str(payload, "user_name");
    const email = str(envelope, "user_profile.email");
    return {
      channel: "SLACK",
      direction: "INBOUND",
      body,
      subject: synthesiseSubject(body),
      sentAt: coerceDate(str(envelope, "ts", "event_ts", "timestamp")),
      externalId: str(envelope, "client_msg_id", "ts"),
      // Slack threads hang off the parent message ts, falling back to channel.
      conversationRef: str(envelope, "thread_ts", "channel"),
      contact: {
        name: userName,
        email,
        company: companyFromEmail(email),
        title: extractTitle(body),
      },
      raw: payload,
    };
  },
};

/** LinkedIn. No official inbound webhook, so this accepts a generic shape. */
const linkedinAdapter: ChannelAdapter = {
  channel: "LINKEDIN",
  label: "LinkedIn",
  providers: ["generic", "unipile", "phantombuster"],
  normalize(payload) {
    const body = requireBody(payload, "message", "text", "body");
    const name = str(payload, "senderName", "from.name", "name", "sender");
    const title = str(payload, "senderHeadline", "headline", "title");
    return {
      channel: "LINKEDIN",
      direction: "INBOUND",
      body,
      subject: synthesiseSubject(body),
      sentAt: coerceDate(str(payload, "timestamp", "sentAt", "createdAt")),
      externalId: str(payload, "messageId", "id", "conversationId"),
      conversationRef: str(payload, "conversationId", "profileUrl", "senderId"),
      contact: {
        name,
        email: parseAddress(str(payload, "email")).email,
        company: str(payload, "companyName", "company"),
        title: title ?? extractTitle(body),
      },
      raw: payload,
    };
  },
};

/** Web form. The highest-intent channel: they came looking for you. */
const webformAdapter: ChannelAdapter = {
  channel: "WEBFORM",
  label: "Web form",
  providers: ["generic"],
  normalize(payload) {
    const body = requireBody(payload, "message", "notes", "comments", "body", "text");
    const email = parseAddress(str(payload, "email", "workEmail")).email;
    return {
      channel: "WEBFORM",
      direction: "INBOUND",
      body,
      subject: str(payload, "subject", "formName") ?? synthesiseSubject(body),
      sentAt: coerceDate(str(payload, "submittedAt", "timestamp", "sentAt")),
      externalId: str(payload, "submissionId", "id"),
      conversationRef: email,
      contact: {
        name: str(payload, "name", "fullName", "firstName"),
        email,
        phone: normalisePhone(str(payload, "phone", "phoneNumber")),
        company: str(payload, "company", "companyName") ?? companyFromEmail(email),
        title: str(payload, "jobTitle", "title") ?? extractTitle(body),
      },
      raw: payload,
    };
  },
};

export const ADAPTERS: Record<Channel, ChannelAdapter> = {
  EMAIL: emailAdapter,
  WHATSAPP: whatsappAdapter,
  SMS: smsAdapter,
  SLACK: slackAdapter,
  LINKEDIN: linkedinAdapter,
  WEBFORM: webformAdapter,
};

export function getAdapter(channel: Channel): ChannelAdapter {
  const adapter = ADAPTERS[channel];
  if (!adapter) throw new AdapterError(`no adapter registered for channel ${channel}`);
  return adapter;
}
