/**
 * Shared vocabulary for the whole product.
 *
 * These string unions are mirrored as plain strings in the Prisma schema
 * because SQLite has no native enum type. Keeping the source of truth here
 * means Postgres migration later is a schema change, not a code change.
 */

export const CHANNELS = [
  "EMAIL",
  "WHATSAPP",
  "SMS",
  "SLACK",
  "LINKEDIN",
  "WEBFORM",
] as const;
export type Channel = (typeof CHANNELS)[number];

export function isChannel(value: unknown): value is Channel {
  return typeof value === "string" && (CHANNELS as readonly string[]).includes(value);
}

export type Direction = "INBOUND" | "OUTBOUND";

export const BUCKETS = ["HOT", "WARM", "NURTURE", "NOISE"] as const;
export type Bucket = (typeof BUCKETS)[number];

export const INTENTS = [
  "PRICING",
  "DEMO",
  "RENEWAL",
  "CHURN_RISK",
  "SUPPORT",
  "INTRO",
  "NOISE",
] as const;
export type Intent = (typeof INTENTS)[number];

export const SIGNAL_KINDS = [
  "BUYING_INTENT",
  "URGENCY",
  "AUTHORITY",
  "DEAL_SIZE",
  "ENGAGEMENT",
  "MULTI_CHANNEL",
  "CHURN_RISK",
  "NOISE",
  // Not signals of the message: the score's own bookkeeping, shown so the
  // rows in the explanation always add up to the score they explain.
  "BASE",
  "ADJUSTMENT",
] as const;
export type SignalKind = (typeof SIGNAL_KINDS)[number];

export type Seniority = "IC" | "MANAGER" | "DIRECTOR" | "VP" | "EXEC" | "UNKNOWN";

export type ThreadStatus = "OPEN" | "SNOOZED" | "WON" | "LOST" | "CLOSED";

/**
 * The canonical inbound message. Every channel adapter's job is to turn a
 * provider-specific payload into exactly this shape — after this boundary,
 * nothing in the system knows or cares which channel a message came from.
 */
export interface NormalizedMessage {
  channel: Channel;
  direction: Direction;
  body: string;
  sentAt: Date;
  /** Provider-side identifier, used to make ingest idempotent. */
  externalId?: string;
  /** Subject line, or a synthesised one for channels that have none. */
  subject?: string;
  contact: {
    name?: string;
    email?: string;
    phone?: string;
    company?: string;
    title?: string;
  };
  /** Provider hint for stitching messages into an existing conversation. */
  conversationRef?: string;
  /** Original payload, retained so adapters can be improved retroactively. */
  raw?: unknown;
}

export interface ScoredSignal {
  kind: SignalKind;
  label: string;
  weight: number;
  evidence?: string;
}

export interface TriageResult {
  score: number;
  bucket: Bucket;
  intent: Intent;
  reason: string;
  signals: ScoredSignal[];
  estimatedValueCents?: number;
  currency?: string;
  engine: string;
}
