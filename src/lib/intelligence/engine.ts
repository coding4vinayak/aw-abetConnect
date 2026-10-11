import type { Bucket, Intent, NormalizedMessage, Seniority, TriageResult } from "@/lib/types";
export type { Intent };

/**
 * Everything the intelligence layer is allowed to see. Deliberately explicit:
 * the engine never reaches into the database itself, which keeps it pure and
 * makes swapping heuristics for an LLM a drop-in change.
 */
export interface TriageContext {
  message: NormalizedMessage;
  contact: {
    name?: string | null;
    company?: string | null;
    title?: string | null;
    seniority?: Seniority | null;
  };
  /** Thread state, absent when this is the first message. */
  thread?: {
    inboundCount: number;
    outboundCount: number;
    /** Distinct channels seen on this conversation so far. */
    channels: string[];
    firstMessageAt: Date;
    lastOutboundAt?: Date | null;
    /** Intent established by earlier messages, so a short follow-up on a live
     *  deal does not reset the conversation to "intro". */
    previousIntent?: Intent | null;
  };
  workspace: {
    name: string;
    /** What this customer sells, used as prompt context by the LLM engine. */
    sellsWhat?: string | null;
  };
}

export interface DraftResult {
  body: string;
  intent: Intent;
  engine: string;
}

export interface IntelligenceEngine {
  readonly name: string;
  /** Score a conversation and explain why. */
  triage(context: TriageContext): Promise<TriageResult>;
  /** Write a reply the rep can send or edit. */
  draft(context: TriageContext, triage: TriageResult): Promise<DraftResult>;
}

/** Bucket thresholds. One place, so the queue tabs and the API always agree. */
export const BUCKET_THRESHOLDS = {
  HOT: 70,
  WARM: 45,
  NURTURE: 15,
} as const;

export function bucketForScore(score: number): Bucket {
  if (score >= BUCKET_THRESHOLDS.HOT) return "HOT";
  if (score >= BUCKET_THRESHOLDS.WARM) return "WARM";
  if (score >= BUCKET_THRESHOLDS.NURTURE) return "NURTURE";
  return "NOISE";
}

export function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}
