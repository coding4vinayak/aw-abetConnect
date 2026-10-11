import { stripQuotedText } from "@/lib/channels/parse";
import { BUCKETS, INTENTS, SIGNAL_KINDS } from "@/lib/types";
import type { Bucket, Intent, ScoredSignal, SignalKind, TriageResult } from "@/lib/types";
import {
  bucketForScore,
  clampScore,
  type DraftResult,
  type IntelligenceEngine,
  type TriageContext,
} from "./engine";
import { HeuristicEngine } from "./heuristic";

/**
 * LLM-backed engine, active only when LLM_API_KEY is configured.
 *
 * The heuristic engine always runs first and its output is passed to the model
 * as a prior. Two reasons: the model has something concrete to agree or
 * disagree with instead of inventing a number from nothing, and if the API is
 * slow, down, rate-limited or returns junk, we still have a real score to fall
 * back to. Triage must never fail closed — an inbox that stops sorting is
 * worse than one sorted slightly less well.
 */
export class LlmEngine implements IntelligenceEngine {
  readonly name: string;
  private readonly fallback = new HeuristicEngine();

  constructor(
    private readonly config: {
      apiKey: string;
      baseUrl: string;
      model: string;
      timeoutMs?: number;
    },
  ) {
    this.name = `llm/${config.model}`;
  }

  async triage(context: TriageContext): Promise<TriageResult> {
    const prior = await this.fallback.triage(context);

    try {
      const response = await this.complete([
        {
          role: "system",
          content: [
            "You triage inbound messages for a sales team and return strict JSON only.",
            "Score 0-100 for how close the sender is to buying, where 100 is a signed-ready buyer and 0 is automated noise.",
            "Cancellation and complaint threats from existing customers score high: they are urgent revenue, not noise.",
            "Newsletters, auto-replies, job applications and cold pitches aimed at the business score under 10.",
            "Be sceptical of enthusiasm without commitment. Words are cheap; deadlines, budgets and paperwork are not.",
            `Valid intents: ${INTENTS.join(", ")}.`,
            `Valid signal kinds: ${SIGNAL_KINDS.join(", ")}.`,
            `Valid buckets: ${BUCKETS.join(", ")}.`,
            'Reply with: {"score":number,"bucket":string,"intent":string,"reason":string,"signals":[{"kind":string,"label":string,"weight":number,"evidence":string}]}',
            "reason must be one sentence under 120 characters explaining the score.",
          ].join("\n"),
        },
        {
          role: "user",
          content: JSON.stringify({
            weSell: context.workspace.sellsWhat ?? "unspecified",
            channel: context.message.channel,
            subject: context.message.subject ?? null,
            body: stripQuotedText(context.message.body).slice(0, 6000),
            sender: {
              name: context.contact.name ?? null,
              company: context.contact.company ?? null,
              title: context.contact.title ?? null,
              seniority: context.contact.seniority ?? "UNKNOWN",
            },
            conversationSoFar: context.thread
              ? {
                  theirMessages: context.thread.inboundCount,
                  ourMessages: context.thread.outboundCount,
                  channelsUsed: context.thread.channels,
                }
              : null,
            heuristicPrior: {
              score: prior.score,
              intent: prior.intent,
              signals: prior.signals.map((s) => `${s.label} (${s.weight})`),
            },
          }),
        },
      ]);

      const parsed = this.parseTriage(response);
      if (!parsed) return prior;

      return {
        ...parsed,
        // Deal size comes from deterministic parsing, not the model — there is
        // no upside to letting an LLM guess at currency amounts.
        estimatedValueCents: prior.estimatedValueCents,
        currency: prior.currency,
        engine: this.name,
      };
    } catch (error) {
      console.warn(
        `[intelligence] LLM triage failed, using ${this.fallback.name}:`,
        error instanceof Error ? error.message : error,
      );
      return prior;
    }
  }

  async draft(context: TriageContext, triage: TriageResult): Promise<DraftResult> {
    if (triage.intent === "NOISE") return this.fallback.draft(context, triage);

    try {
      const response = await this.complete([
        {
          role: "system",
          content: [
            "You write the first draft of a sales reply for a human to review and send.",
            "Rules:",
            "- Answer the question that was actually asked. No preamble, no brochure copy.",
            "- Propose exactly one next step.",
            "- Never invent prices, dates, discounts, features or commitments. Use [BRACKETED] placeholders for anything the rep must supply.",
            "- Match the channel: WHATSAPP, SMS and SLACK get two or three short lines with no signature. EMAIL gets a short paragraph structure and signs off with [YOUR NAME].",
            "- Plain, direct language. No 'I hope this finds you well', no exclamation marks, no emoji.",
            "Return the message body only, no subject line, no commentary.",
          ].join("\n"),
        },
        {
          role: "user",
          content: JSON.stringify({
            weSell: context.workspace.sellsWhat ?? "unspecified",
            channel: context.message.channel,
            detectedIntent: triage.intent,
            keySignals: triage.signals.filter((s) => s.weight > 0).map((s) => s.label),
            theirName: context.contact.name ?? null,
            theirCompany: context.contact.company ?? null,
            theirMessage: stripQuotedText(context.message.body).slice(0, 4000),
          }),
        },
      ]);

      const body = response.trim();
      if (!body) return this.fallback.draft(context, triage);
      return { body, intent: triage.intent, engine: this.name };
    } catch (error) {
      console.warn(
        `[intelligence] LLM draft failed, using ${this.fallback.name}:`,
        error instanceof Error ? error.message : error,
      );
      return this.fallback.draft(context, triage);
    }
  }

  private async complete(
    messages: Array<{ role: "system" | "user"; content: string }>,
  ): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 12_000);
    try {
      const res = await fetch(`${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model,
          messages,
          temperature: 0.2,
          max_tokens: 700,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`${res.status} ${res.statusText}: ${(await res.text()).slice(0, 300)}`);
      }
      const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      return json.choices?.[0]?.message?.content ?? "";
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Validate hard. An LLM returning a plausible-looking wrong shape is the
   *  most common way this kind of feature silently degrades. */
  private parseTriage(
    raw: string,
  ): Omit<TriageResult, "engine" | "estimatedValueCents" | "currency"> | undefined {
    const jsonText = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      return undefined;
    }
    if (!parsed || typeof parsed !== "object") return undefined;
    const obj = parsed as Record<string, unknown>;

    if (typeof obj.score !== "number" || !Number.isFinite(obj.score)) return undefined;
    const score = clampScore(obj.score);

    const intent = (INTENTS as readonly string[]).includes(String(obj.intent))
      ? (obj.intent as Intent)
      : "INTRO";

    const bucket = (BUCKETS as readonly string[]).includes(String(obj.bucket))
      ? (obj.bucket as Bucket)
      : bucketForScore(score);

    const signals: ScoredSignal[] = Array.isArray(obj.signals)
      ? obj.signals
          .filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
          .map((s) => ({
            kind: (SIGNAL_KINDS as readonly string[]).includes(String(s.kind))
              ? (s.kind as SignalKind)
              : "ENGAGEMENT",
            label: String(s.label ?? "Signal").slice(0, 120),
            weight:
              typeof s.weight === "number" && Number.isFinite(s.weight)
                ? Math.round(s.weight)
                : 0,
            evidence: typeof s.evidence === "string" ? s.evidence.slice(0, 160) : undefined,
          }))
          .slice(0, 12)
      : [];

    const reason =
      typeof obj.reason === "string" && obj.reason.trim()
        ? obj.reason.trim().slice(0, 200)
        : "Scored by model";

    return { score, bucket, intent, reason, signals };
  }
}
