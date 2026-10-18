import type { Intent, SignalKind } from "@/lib/types";

/**
 * The scoring lexicon.
 *
 * Every rule is a pattern plus the points it contributes and the intent it
 * votes for. Keeping this as data rather than code means the scoring model is
 * inspectable and tunable per customer without touching the engine, and it is
 * what lets the UI explain a score instead of just asserting one.
 *
 * Weights are calibrated so that a single strong buying phrase from a senior
 * person with a deadline reliably clears the HOT threshold (70), while a lone
 * soft phrase lands in WARM or NURTURE.
 */
export interface LexiconRule {
  /** Must be global-free; matching is done with a fresh regex each time. */
  pattern: RegExp;
  kind: SignalKind;
  label: string;
  weight: number;
  /** Which intent this rule votes for, and how strongly. */
  intent?: Intent;
  intentVotes?: number;
}

export const LEXICON: LexiconRule[] = [
  // ---------------------------------------------------------------------
  // Explicit commercial intent. Somebody asking about money is the single
  // most reliable signal that exists, so these carry the most weight.
  // ---------------------------------------------------------------------
  {
    pattern: /\b(send|share|get)\s+(me\s+)?(a\s+)?(quote|quotation|proposal|estimate)\b/i,
    kind: "BUYING_INTENT",
    label: "Asked for a quote",
    weight: 34,
    intent: "PRICING",
    intentVotes: 3,
  },
  {
    pattern: /\b(pricing|price list|rate card|cost breakdown)\b/i,
    kind: "BUYING_INTENT",
    label: "Asked about pricing",
    weight: 26,
    intent: "PRICING",
    intentVotes: 3,
  },
  {
    // "how much for 5 users" is as strong a signal as "how much does it cost",
    // and short-form channels almost always phrase it the short way.
    pattern:
      /\bhow much (does|would|is|do|for|to)\b|\bwhat('?s| is| does)? ?(the |it )?(price|cost)\b|\bcost (for|of)\b/i,
    kind: "BUYING_INTENT",
    label: "Asked what it costs",
    weight: 26,
    intent: "PRICING",
    intentVotes: 3,
  },
  {
    pattern: /\bpurchase order\b|\brais(e|ed|ing) (a |the )?p\.?o\.?\b|\bpo[-\s]?\d{2,}\b/i,
    kind: "BUYING_INTENT",
    label: "Purchase order raised",
    weight: 38,
    intent: "PRICING",
    intentVotes: 4,
  },
  {
    // Referring back to a quote already in flight — weaker than requesting one,
    // but it means a number is on the table.
    pattern: /\b(the |that |our |your )?(quote|quotation|proposal|estimate)\b/i,
    kind: "BUYING_INTENT",
    label: "Quote in play",
    weight: 20,
    intent: "PRICING",
    intentVotes: 2,
  },
  {
    pattern: /\b(budget (is |has been )?approved|got (the )?budget|budget signed off)\b/i,
    kind: "BUYING_INTENT",
    label: "Budget approved",
    weight: 36,
    intent: "PRICING",
    intentVotes: 3,
  },
  {
    pattern: /\b(ready to (move forward|proceed|get started|go ahead|sign)|let'?s do it|where do i sign)\b/i,
    kind: "BUYING_INTENT",
    label: "Ready to move forward",
    weight: 36,
    intent: "PRICING",
    intentVotes: 3,
  },
  {
    pattern: /\b(contract|msa|sow|statement of work|order form|terms)\b/i,
    kind: "BUYING_INTENT",
    label: "Paperwork stage",
    weight: 24,
    intent: "PRICING",
    intentVotes: 2,
  },
  {
    pattern: /\b(invoice|billing details|payment (link|details|terms))\b/i,
    kind: "BUYING_INTENT",
    label: "Billing discussion",
    weight: 20,
    intent: "PRICING",
    intentVotes: 2,
  },
  {
    pattern: /\b(security (review|questionnaire)|dpa|soc\s?2|vendor (form|onboarding)|procurement process)\b/i,
    kind: "BUYING_INTENT",
    label: "Procurement in motion",
    weight: 30,
    intent: "PRICING",
    intentVotes: 3,
  },
  {
    pattern: /\b(upgrade|add (more )?(seats|users|licen[cs]es)|move to (the )?(pro|business|enterprise))\b/i,
    kind: "BUYING_INTENT",
    label: "Expansion interest",
    weight: 28,
    intent: "PRICING",
    intentVotes: 2,
  },
  {
    pattern: /\b(start (a )?(trial|pilot)|proof of concept|\bpoc\b|evaluate)\b/i,
    kind: "BUYING_INTENT",
    label: "Wants to trial or pilot",
    weight: 24,
    intent: "DEMO",
    intentVotes: 2,
  },

  // ---------------------------------------------------------------------
  // Meeting intent. Weaker than money talk but still a live opportunity.
  // ---------------------------------------------------------------------
  {
    pattern: /\b(demo|walkthrough|walk (me|us) through|see it in action)\b/i,
    kind: "BUYING_INTENT",
    label: "Requested a demo",
    weight: 26,
    intent: "DEMO",
    intentVotes: 3,
  },
  {
    pattern: /\b(book a (call|time|slot)|set up a (call|meeting)|jump on a call|hop on a call|schedule (a )?(call|meeting)|calendar link|are you free)\b/i,
    kind: "BUYING_INTENT",
    label: "Wants a meeting",
    weight: 22,
    intent: "DEMO",
    intentVotes: 2,
  },

  // ---------------------------------------------------------------------
  // Renewal. Time-boxed revenue that is easy to lose by being slow.
  // ---------------------------------------------------------------------
  {
    pattern: /\b(renew(al|ing)?|auto-?renew|contract (ends|expires|is up)|subscription (ends|expires))\b/i,
    kind: "BUYING_INTENT",
    label: "Renewal window",
    weight: 30,
    intent: "RENEWAL",
    intentVotes: 3,
  },

  // ---------------------------------------------------------------------
  // Urgency. Multiplies the cost of a slow reply.
  // ---------------------------------------------------------------------
  {
    pattern: /\b(asap|as soon as possible|urgent(ly)?|time.?sensitive|right away)\b/i,
    kind: "URGENCY",
    label: "Marked urgent",
    weight: 16,
  },
  {
    pattern: /\b(today|tomorrow|by (eod|end of day|cob))\b/i,
    kind: "URGENCY",
    label: "Same-day deadline",
    weight: 14,
  },
  {
    // "before Friday" and "ahead of next week" are deadlines just as much as
    // "by Friday" is, and prospects phrase it every one of those ways.
    pattern:
      /\b(by|before|ahead of|prior to|no later than) (this |next |the )?(monday|tuesday|wednesday|thursday|friday|saturday|sunday|week|weekend|month|quarter|year)\b/i,
    kind: "URGENCY",
    label: "Stated deadline",
    weight: 11,
  },
  {
    pattern: /\b(deadline|cut.?off|expires? (on|in)|before (the )?quarter|end of (the )?(quarter|month|year)|fiscal year)\b/i,
    kind: "URGENCY",
    label: "Deadline pressure",
    weight: 12,
  },
  {
    pattern: /\b(following up|circling back|any update|just checking in|bumping this|second time i)\b/i,
    kind: "URGENCY",
    label: "Chasing a response",
    weight: 13,
  },

  // ---------------------------------------------------------------------
  // Competitive pressure. Live deal, and you are not the only vendor.
  // ---------------------------------------------------------------------
  {
    pattern:
      /\b(comparing|compared to|versus|vs\.?|alternatives?|also (looking at|evaluating)|shortlist|other (providers|vendors))\b/i,
    kind: "BUYING_INTENT",
    label: "Comparing vendors",
    weight: 18,
    intent: "PRICING",
    intentVotes: 1,
  },

  // ---------------------------------------------------------------------
  // Churn risk. Negative for the deal, but must surface at the top of the
  // queue anyway — a cancellation you answer in an hour is often saveable.
  // ---------------------------------------------------------------------
  {
    pattern: /\b(cancel(ling|lation)?|terminate|not renewing|won'?t be renewing|close my account|delete my account)\b/i,
    kind: "CHURN_RISK",
    label: "Cancellation threat",
    weight: 30,
    intent: "CHURN_RISK",
    intentVotes: 4,
  },
  {
    pattern: /\b(refund|chargeback|money back|billed twice|overcharged)\b/i,
    kind: "CHURN_RISK",
    label: "Refund or billing dispute",
    weight: 22,
    intent: "CHURN_RISK",
    intentVotes: 3,
  },
  {
    pattern: /\b(disappointed|frustrat(ed|ing)|unacceptable|fed up|poor (service|experience)|escalate|speak to (a |your )?manager)\b/i,
    kind: "CHURN_RISK",
    label: "Unhappy customer",
    weight: 20,
    intent: "CHURN_RISK",
    intentVotes: 3,
  },
  {
    pattern: /\b(switch(ing)? to|moving to|migrat(e|ing) (away|off)|found (a )?better)\b/i,
    kind: "CHURN_RISK",
    label: "Considering leaving",
    weight: 24,
    intent: "CHURN_RISK",
    intentVotes: 3,
  },
  {
    pattern: /\b(downgrade|reduce (our )?(seats|licen[cs]es)|fewer seats)\b/i,
    kind: "CHURN_RISK",
    label: "Contraction risk",
    weight: 18,
    intent: "CHURN_RISK",
    intentVotes: 2,
  },

  // ---------------------------------------------------------------------
  // Support. Real work, but not revenue — should not outrank a live deal.
  // ---------------------------------------------------------------------
  {
    pattern: /\b(bug|broken|not working|error message|stack trace|outage|down(time)?|can'?t log ?in|reset my password|500 error)\b/i,
    kind: "ENGAGEMENT",
    label: "Support issue",
    weight: 4,
    intent: "SUPPORT",
    intentVotes: 3,
  },
  {
    pattern: /\b(how do i|is there a way to|documentation|docs|api (reference|key))\b/i,
    kind: "ENGAGEMENT",
    label: "Product question",
    weight: 5,
    intent: "SUPPORT",
    intentVotes: 1,
  },

  // ---------------------------------------------------------------------
  // Noise. Negative weights, and enough of them force the NOISE bucket.
  // These are the messages that make an unsorted inbox useless.
  // ---------------------------------------------------------------------
  {
    pattern: /\b(unsubscribe|opt.?out|manage (your )?preferences|view (this )?in browser)\b/i,
    kind: "NOISE",
    label: "Bulk mail footer",
    weight: -45,
    intent: "NOISE",
    intentVotes: 4,
  },
  {
    pattern: /\b(do not reply|no.?reply|this is an automated|automated (message|notification)|system notification)\b/i,
    kind: "NOISE",
    label: "Automated message",
    weight: -45,
    intent: "NOISE",
    intentVotes: 4,
  },
  {
    pattern: /\b(out of (the )?office|on (annual )?leave|maternity leave|currently away|auto.?repl(y|ies))\b/i,
    kind: "NOISE",
    label: "Auto-reply",
    weight: -40,
    intent: "NOISE",
    intentVotes: 4,
  },
  {
    pattern: /\b(seo services|backlink|guest post|link building|web design services|we can (build|design|develop) your)\b/i,
    kind: "NOISE",
    label: "Inbound cold pitch",
    weight: -42,
    intent: "NOISE",
    intentVotes: 4,
  },
  {
    pattern: /\b(i came across your (website|profile|company)|hope this (email |message )?finds you well|quick question for you)\b/i,
    kind: "NOISE",
    label: "Cold outreach boilerplate",
    weight: -22,
    intent: "NOISE",
    intentVotes: 2,
  },
  {
    pattern: /\b(webinar|newsletter|conference invit|sponsorship (opportunit|package)|survey|podcast guest)\b/i,
    kind: "NOISE",
    label: "Marketing blast",
    weight: -30,
    intent: "NOISE",
    intentVotes: 3,
  },
  {
    pattern: /\b(my (cv|resume)|applying for|job (application|opening)|hiring|recruit(er|ment) (agency|services)|placement)\b/i,
    kind: "NOISE",
    label: "Recruiting or job application",
    weight: -35,
    intent: "NOISE",
    intentVotes: 4,
  },
  {
    pattern: /\b(crypto|bitcoin|forex|casino|loan offer|viagra|lottery|prince)\b/i,
    kind: "NOISE",
    label: "Spam keywords",
    weight: -50,
    intent: "NOISE",
    intentVotes: 4,
  },
];

/**
 * Per-category ceilings.
 *
 * Without these the model saturates: a message that says "pricing", "contract"
 * and "invoice" racks up 80 points from what is really one signal — they want
 * to buy — and every good lead pins at 100. A queue where the top six all read
 * 100 is not ranked, so each category can only ever contribute so much and the
 * remaining separation has to come from a *different* kind of evidence.
 */
export const CATEGORY_CAPS: Record<SignalKind, number> = {
  BUYING_INTENT: 38,
  CHURN_RISK: 34,
  DEAL_SIZE: 16,
  AUTHORITY: 16,
  URGENCY: 14,
  ENGAGEMENT: 12,
  MULTI_CHANNEL: 12,
  NOISE: 0, // negative only; never capped
  BASE: 0, // bookkeeping; never capped
  ADJUSTMENT: 0, // added after the caps, to close the arithmetic
};

/** Every real inbound message starts just above zero. */
export const BASE_SCORE = 5;

/** Money mentioned in the body — an explicit deal-size signal. */
export const MONEY_PATTERN =
  /(?:([$£€₹])|\b(usd|eur|gbp|inr|aud|cad)\s?)\s?([\d][\d,]*(?:\.\d{1,2})?)\s?(k|m|thousand|million|mn)?\b/gi;

/** "40 seats", "250 users" — deal size without a currency figure. */
export const SEATS_PATTERN =
  /\b([\d][\d,]*)\s+(seats?|users?|licen[cs]es?|employees|agents|mailboxes)\b/gi;

/** Scale words that imply a larger-than-usual deal. */
export const SCALE_PATTERN =
  /\b(enterprise|company.?wide|org.?wide|global roll.?out|all (our )?teams|multi.?year|annual (plan|contract|commitment))\b/i;

export const CURRENCY_BY_SYMBOL: Record<string, string> = {
  $: "USD",
  "£": "GBP",
  "€": "EUR",
  "₹": "INR",
};
