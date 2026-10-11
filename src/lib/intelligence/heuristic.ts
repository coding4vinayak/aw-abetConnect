import { stripQuotedText } from "@/lib/channels/parse";
import type { Channel, Intent, ScoredSignal, Seniority, TriageResult } from "@/lib/types";
import {
  bucketForScore,
  clampScore,
  type DraftResult,
  type IntelligenceEngine,
  type TriageContext,
} from "./engine";
import {
  BASE_SCORE,
  CATEGORY_CAPS,
  CURRENCY_BY_SYMBOL,
  LEXICON,
  MONEY_PATTERN,
  SCALE_PATTERN,
  SEATS_PATTERN,
} from "./lexicon";
import { writeDraft } from "./drafts";

/** Channels differ in how much intent they imply. A web form submission is
 *  somebody who went looking for you; a Slack message is often internal chatter. */
const CHANNEL_BIAS: Record<Channel, { weight: number; label: string }> = {
  WEBFORM: { weight: 12, label: "Came through your website" },
  EMAIL: { weight: 4, label: "Inbound email" },
  WHATSAPP: { weight: 8, label: "Reached out on WhatsApp" },
  SMS: { weight: 6, label: "Reached out by SMS" },
  LINKEDIN: { weight: 2, label: "LinkedIn message" },
  SLACK: { weight: 0, label: "Slack message" },
};

const SENIORITY_WEIGHT: Record<Seniority, { weight: number; label: string }> = {
  EXEC: { weight: 20, label: "Founder or C-level" },
  VP: { weight: 16, label: "VP-level contact" },
  DIRECTOR: { weight: 12, label: "Director-level contact" },
  MANAGER: { weight: 7, label: "Manager-level contact" },
  IC: { weight: 2, label: "Individual contributor" },
  UNKNOWN: { weight: 0, label: "Unknown seniority" },
};

const MULTIPLIERS: Record<string, number> = {
  k: 1_000,
  thousand: 1_000,
  m: 1_000_000,
  mn: 1_000_000,
  million: 1_000_000,
};

/** Rough revenue-per-seat assumption used only to rank seat-count mentions. */
const ASSUMED_ANNUAL_VALUE_PER_SEAT_CENTS = 30_000; // $300/seat/yr

interface MoneyFinding {
  cents: number;
  currency: string;
  evidence: string;
}

function findLargestAmount(text: string): MoneyFinding | undefined {
  let best: MoneyFinding | undefined;
  for (const match of text.matchAll(MONEY_PATTERN)) {
    const [full, symbol, code, digits, suffix] = match;
    const base = Number(digits.replace(/,/g, ""));
    if (!Number.isFinite(base) || base <= 0) continue;
    const multiplier = suffix ? (MULTIPLIERS[suffix.toLowerCase()] ?? 1) : 1;
    const amount = base * multiplier;
    // Guard against absurd parses from things like order numbers.
    if (amount > 1_000_000_000) continue;
    const cents = Math.round(amount * 100);
    if (!best || cents > best.cents) {
      best = {
        cents,
        currency: symbol ? (CURRENCY_BY_SYMBOL[symbol] ?? "USD") : (code ?? "USD").toUpperCase(),
        evidence: full.trim(),
      };
    }
  }
  return best;
}

function findLargestSeatCount(text: string): { seats: number; evidence: string } | undefined {
  let best: { seats: number; evidence: string } | undefined;
  for (const match of text.matchAll(SEATS_PATTERN)) {
    const seats = Number(match[1].replace(/,/g, ""));
    if (!Number.isFinite(seats) || seats <= 0 || seats > 5_000_000) continue;
    if (!best || seats > best.seats) best = { seats, evidence: match[0].trim() };
  }
  return best;
}

/**
 * Apply the per-category ceilings.
 *
 * Signals inside an over-budget category are scaled down proportionally rather
 * than truncated, so the weights the UI displays still add up to the score
 * exactly. An explanation whose numbers do not sum to the number it is
 * explaining is worse than no explanation.
 */
function applyCategoryCaps(signals: ScoredSignal[]): ScoredSignal[] {
  const positiveTotals = new Map<string, number>();
  for (const signal of signals) {
    if (signal.weight > 0) {
      positiveTotals.set(signal.kind, (positiveTotals.get(signal.kind) ?? 0) + signal.weight);
    }
  }

  return signals.map((signal) => {
    if (signal.weight <= 0) return signal;
    const cap = CATEGORY_CAPS[signal.kind];
    const total = positiveTotals.get(signal.kind) ?? 0;
    if (!cap || total <= cap) return signal;
    // Never scale a contributing signal to zero — it would vanish from the
    // explanation while still having been part of the decision.
    const scaled = Math.max(1, Math.round(signal.weight * (cap / total)));
    return { ...signal, weight: scaled };
  });
}

/** Deal-size points scale with the log of the amount so a $2m deal does not
 *  swamp every other signal, but still clearly outranks a $500 one. */
function dealSizePoints(cents: number): number {
  const dollars = cents / 100;
  if (dollars < 500) return 2;
  if (dollars < 2_000) return 6;
  if (dollars < 10_000) return 12;
  if (dollars < 50_000) return 18;
  if (dollars < 250_000) return 24;
  return 30;
}

/**
 * The built-in scoring engine. Deterministic, explainable, no API key, no
 * per-message cost, and fast enough to run inline on ingest. It is the default
 * because a sales team cannot triage an inbox that is waiting on a rate limit.
 */
export class HeuristicEngine implements IntelligenceEngine {
  readonly name = "heuristic/v1";

  async triage(context: TriageContext): Promise<TriageResult> {
    const { message, contact, thread } = context;
    // Only score what this person actually wrote. Quoted history would
    // otherwise re-trigger the same signals on every reply.
    const text = stripQuotedText(message.body);
    const haystack = `${message.subject ?? ""}\n${text}`;

    const signals: ScoredSignal[] = [];
    const intentVotes = new Map<Intent, number>();

    const vote = (intent: Intent | undefined, votes = 1) => {
      if (!intent) return;
      intentVotes.set(intent, (intentVotes.get(intent) ?? 0) + votes);
    };

    // --- Lexicon pass -------------------------------------------------
    const seenLabels = new Set<string>();
    for (const rule of LEXICON) {
      const match = new RegExp(rule.pattern.source, rule.pattern.flags.replace("g", "")).exec(
        haystack,
      );
      if (!match) continue;
      if (seenLabels.has(rule.label)) continue;
      seenLabels.add(rule.label);
      signals.push({
        kind: rule.kind,
        label: rule.label,
        weight: rule.weight,
        evidence: match[0].trim().slice(0, 160),
      });
      vote(rule.intent, rule.intentVotes ?? 1);
    }

    // --- Channel bias -------------------------------------------------
    const bias = CHANNEL_BIAS[message.channel];
    if (bias && bias.weight !== 0) {
      signals.push({ kind: "ENGAGEMENT", label: bias.label, weight: bias.weight });
    }

    // --- Authority ----------------------------------------------------
    const seniority = (contact.seniority ?? "UNKNOWN") as Seniority;
    const authority = SENIORITY_WEIGHT[seniority] ?? SENIORITY_WEIGHT.UNKNOWN;
    if (authority.weight > 0) {
      signals.push({
        kind: "AUTHORITY",
        label: authority.label,
        weight: authority.weight,
        evidence: contact.title ?? undefined,
      });
    }

    // A named company beats a personal address: someone buying for a business.
    if (contact.company) {
      signals.push({
        kind: "AUTHORITY",
        label: `Buying for ${contact.company}`,
        weight: 6,
        evidence: contact.company,
      });
    }

    // --- Deal size ----------------------------------------------------
    let estimatedValueCents: number | undefined;
    let currency: string | undefined;

    const money = findLargestAmount(haystack);
    if (money) {
      estimatedValueCents = money.cents;
      currency = money.currency;
      signals.push({
        kind: "DEAL_SIZE",
        label: `Budget mentioned: ${money.evidence}`,
        weight: dealSizePoints(money.cents),
        evidence: money.evidence,
      });
    }

    const seats = findLargestSeatCount(haystack);
    if (seats) {
      const implied = seats.seats * ASSUMED_ANNUAL_VALUE_PER_SEAT_CENTS;
      if (!estimatedValueCents || implied > estimatedValueCents) {
        estimatedValueCents = implied;
        currency = currency ?? "USD";
      }
      signals.push({
        kind: "DEAL_SIZE",
        label: `${seats.seats} seats in play`,
        weight: Math.min(22, dealSizePoints(implied)),
        evidence: seats.evidence,
      });
    }

    const scale = SCALE_PATTERN.exec(haystack);
    if (scale) {
      signals.push({
        kind: "DEAL_SIZE",
        label: "Enterprise-scale language",
        weight: 12,
        evidence: scale[0],
      });
    }

    // --- Engagement ---------------------------------------------------
    if (thread) {
      if (thread.inboundCount >= 2) {
        signals.push({
          kind: "ENGAGEMENT",
          label: `${thread.inboundCount} messages from them`,
          weight: Math.min(14, 4 + thread.inboundCount * 2),
        });
      }
      // They wrote again without us answering: the ball has been in our
      // court for a while and the queue should say so.
      if (thread.inboundCount > thread.outboundCount + 1) {
        signals.push({
          kind: "ENGAGEMENT",
          label: "Waiting on us for multiple messages",
          weight: 10,
        });
      }
      const distinctChannels = new Set(thread.channels.filter(Boolean));
      distinctChannels.add(message.channel);
      if (distinctChannels.size > 1) {
        signals.push({
          kind: "MULTI_CHANNEL",
          label: `Chasing across ${distinctChannels.size} channels`,
          weight: 15,
          evidence: [...distinctChannels].join(", "),
        });
      }
    }

    // --- Very short messages carry little signal either way -----------
    if (text.replace(/\s+/g, " ").trim().length < 12) {
      signals.push({ kind: "NOISE", label: "Almost no content", weight: -8 });
    }

    // --- Resolve ------------------------------------------------------
    const capped = applyCategoryCaps(signals);
    const total = capped.reduce((sum, s) => sum + s.weight, 0);
    const noisePenalty = capped
      .filter((s) => s.kind === "NOISE")
      .reduce((sum, s) => sum + s.weight, 0);

    let score = clampScore(BASE_SCORE + total);
    const intent = this.resolveIntent(intentVotes, context.thread?.previousIntent);

    // A hard noise marker (unsubscribe footer, auto-reply, spam) should win
    // outright. Otherwise a marketing blast that happens to say "pricing"
    // lands at the top of a rep's queue, which destroys trust in the ranking.
    const hardNoise = signals.some((s) => s.kind === "NOISE" && s.weight <= -30);
    if (hardNoise) score = Math.min(score, 8);

    let bucket = bucketForScore(score);
    if (intent === "NOISE" && noisePenalty <= -30) bucket = "NOISE";

    return {
      score,
      bucket,
      intent,
      reason: this.explain(capped, intent, bucket),
      signals: capped.sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight)),
      estimatedValueCents,
      currency,
      engine: this.name,
    };
  }

  async draft(context: TriageContext, triage: TriageResult): Promise<DraftResult> {
    return {
      body: writeDraft(context, triage),
      intent: triage.intent,
      engine: this.name,
    };
  }

  private resolveIntent(votes: Map<Intent, number>, previous?: Intent | null): Intent {
    // A short chase like "any update on this?" carries no intent of its own.
    // Falling back to INTRO there would erase what the conversation is actually
    // about, so an established intent persists until something displaces it.
    const inherit = (fallback: Intent): Intent =>
      previous && previous !== "NOISE" && previous !== "INTRO" ? previous : fallback;

    if (votes.size === 0) return inherit("INTRO");

    // Ties break toward the more commercially urgent intent.
    const priority: Intent[] = [
      "NOISE",
      "CHURN_RISK",
      "PRICING",
      "RENEWAL",
      "DEMO",
      "SUPPORT",
      "INTRO",
    ];
    let winner: Intent = "INTRO";
    let best = -Infinity;
    for (const [intent, count] of votes) {
      const rank = priority.indexOf(intent);
      const bestRank = priority.indexOf(winner);
      if (count > best || (count === best && rank !== -1 && rank < bestRank)) {
        winner = intent;
        best = count;
      }
    }

    if (winner === "INTRO") return inherit("INTRO");
    // Support noise on a live deal should not demote the deal.
    if (winner === "SUPPORT" && previous && ["PRICING", "RENEWAL", "CHURN_RISK"].includes(previous)) {
      return previous;
    }
    return winner;
  }

  /**
   * A score with no explanation is a number nobody trusts. This produces the
   * one-liner shown next to every thread in the queue.
   */
  private explain(signals: ScoredSignal[], intent: Intent, bucket: string): string {
    const positives = signals
      .filter((s) => s.weight > 0)
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 3)
      .map((s) => s.label.toLowerCase());

    if (bucket === "NOISE") {
      const why = signals.find((s) => s.kind === "NOISE" && s.weight < 0);
      return why ? `Filtered as noise: ${why.label.toLowerCase()}` : "No sales signal detected";
    }
    if (positives.length === 0) return "No strong signal either way";

    const lead =
      intent === "CHURN_RISK"
        ? "At risk"
        : intent === "RENEWAL"
          ? "Renewal"
          : intent === "PRICING"
            ? "Buying signal"
            : intent === "DEMO"
              ? "Wants a meeting"
              : intent === "SUPPORT"
                ? "Support"
                : "Early interest";

    return `${lead} — ${positives.join(", ")}`;
  }
}
