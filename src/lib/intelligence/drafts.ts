import { stripQuotedText } from "@/lib/channels/parse";
import type { Intent, TriageResult } from "@/lib/types";
import type { TriageContext } from "./engine";

/**
 * Template-based reply drafting.
 *
 * Deliberately conservative: a draft that over-promises is worse than no
 * draft, because the rep has to unpick it. Every template answers the question
 * that was actually asked, proposes exactly one next step, and leaves any
 * specifics the rep must supply as an obvious [BRACKETED] slot rather than
 * inventing a number.
 */

function firstName(name?: string | null): string {
  if (!name) return "there";
  const cleaned = name.trim().split(/\s+/)[0];
  if (!cleaned) return "there";
  // Avoid greeting somebody by their email local part.
  if (cleaned.includes("@")) return "there";
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

/** Chat channels get short replies; email gets a full one. Matching the
 *  register of the channel is most of what makes a draft feel usable. */
function isShortFormChannel(channel: string): boolean {
  return channel === "WHATSAPP" || channel === "SMS" || channel === "SLACK";
}

interface TemplateInput {
  name: string;
  company?: string | null;
  /** What the sender asked, quoted back so the reply feels specific. */
  askedAbout?: string;
  short: boolean;
  workspaceName: string;
  signals: TriageResult["signals"];
}

function hasSignal(signals: TriageResult["signals"], label: string): boolean {
  return signals.some((s) => s.label.toLowerCase().includes(label.toLowerCase()));
}

/**
 * The urgency phrase the sender actually used, so the reply can acknowledge
 * their deadline instead of asking them to restate it.
 */
function deadlineEvidence(signals: TriageResult["signals"]): string | undefined {
  return signals.find((s) => s.kind === "URGENCY" && s.evidence)?.evidence;
}

const TEMPLATES: Record<Intent, (input: TemplateInput) => string> = {
  PRICING: ({ name, short, signals, company }) => {
    // Only ask for what they have not already told us. A draft that asks a
    // prospect to repeat the seat count they just gave reads worse than no
    // draft at all, because it proves nobody read the message.
    const knowsSeats = hasSignal(signals, "seats in play");
    const knowsBudget = hasSignal(signals, "Budget mentioned");
    const knowsTerm = hasSignal(signals, "Enterprise-scale language");
    const deadline = deadlineEvidence(signals);
    const procurement = hasSignal(signals, "Procurement in motion");
    const paperwork =
      hasSignal(signals, "Paperwork stage") || hasSignal(signals, "Purchase order raised");

    const questions: string[] = [];
    if (!knowsSeats) questions.push(`- How many users or seats you'd need`);
    if (!knowsTerm) questions.push(`- Whether you're looking at monthly or annual`);
    if (!deadline) questions.push(`- Any deadline you're working to`);
    if (procurement) {
      questions.push(
        `- Who to send security and vendor documentation to, so I can start that in parallel rather than have it hold things up`,
      );
    }

    if (short) {
      const lines = [`Hi ${name} — happy to help with pricing.`, ``];
      if (questions.length > 0) {
        lines.push(
          `One thing first: ${questions[0].replace(/^- /, "").replace(/^How/, "how")}?`,
          ``,
        );
      }
      lines.push(`I can have a quote over to you [TIMEFRAME].`);
      return lines.join("\n");
    }

    const lines = [
      `Hi ${name},`,
      ``,
      `Thanks for reaching out — happy to put pricing together for ${company ?? "you"}.`,
    ];

    if (deadline) {
      lines.push(``, `Noted on the timing (“${deadline}”) — I'll work to that.`);
    }

    if (questions.length > 0) {
      lines.push(``, `So the quote is firm rather than a range, could you confirm:`, ...questions);
      lines.push(``, `Send those over and I'll have a quote with you by [DATE].`);
    } else {
      // Nothing left to ask — the only useful reply is the number itself.
      lines.push(
        ``,
        `I have everything I need. I'll send a firm quote by [DATE]${
          knowsBudget ? `, priced against the budget you mentioned` : ""
        }.`,
      );
    }

    if (paperwork) {
      lines.push(
        ``,
        `I'll include our standard agreement in the same email so your legal and finance teams can start reviewing straight away.`,
      );
    }

    lines.push(``, `Best,`, `[YOUR NAME]`);
    return lines.join("\n");
  },

  DEMO: ({ name, short }) => {
    if (short) {
      return [
        `Hi ${name} — yes, happy to walk you through it.`,
        ``,
        `Does [DAY] at [TIME] work? Takes about 20 minutes.`,
      ].join("\n");
    }
    return [
      `Hi ${name},`,
      ``,
      `Happy to show you around — it takes about 20 minutes and I'll tailor it to what you're actually trying to solve rather than a generic tour.`,
      ``,
      `Would [DAY] at [TIME] or [DAY] at [TIME] suit? If neither works, here's my calendar: [CALENDAR LINK]`,
      ``,
      `Anything specific you'd like me to focus on, let me know beforehand and I'll build the session around it.`,
      ``,
      `Best,`,
      `[YOUR NAME]`,
    ].join("\n");
  },

  RENEWAL: ({ name, short }) => {
    if (short) {
      return [
        `Hi ${name} — thanks for flagging the renewal.`,
        ``,
        `I'll send your current terms and renewal options today. Anything you'd want to change for the next term?`,
      ].join("\n");
    }
    return [
      `Hi ${name},`,
      ``,
      `Thanks for getting ahead of the renewal.`,
      ``,
      `I'll send over your current terms along with the renewal options today. Before I do — has anything changed on your side that we should reflect in the next term? Seat count, teams coming on board, or anything that hasn't been working the way you expected?`,
      ``,
      `If it's easier to talk it through, I'm free [DAY] and [DAY].`,
      ``,
      `Best,`,
      `[YOUR NAME]`,
    ].join("\n");
  },

  CHURN_RISK: ({ name, short }) => {
    if (short) {
      return [
        `Hi ${name} — sorry about this, and thanks for telling us directly.`,
        ``,
        `I'd rather fix it than lose you. Can I call you [TIMEFRAME]?`,
      ].join("\n");
    }
    return [
      `Hi ${name},`,
      ``,
      `Sorry — that's not the experience we want you to have, and thank you for telling us directly rather than just leaving.`,
      ``,
      `I've picked this up personally. Before I action the request, would you give me [TIMEFRAME] to put it right? Specifically I want to understand [WHAT WENT WRONG] so I'm fixing the actual cause and not just apologising.`,
      ``,
      `If you'd still rather go ahead after that, I'll process it immediately and won't make it difficult.`,
      ``,
      `Can I call you [DAY] at [TIME]?`,
      ``,
      `Best,`,
      `[YOUR NAME]`,
    ].join("\n");
  },

  SUPPORT: ({ name, short, askedAbout }) => {
    if (short) {
      return [
        `Hi ${name} — looking into this now.`,
        ``,
        `Can you send a screenshot and roughly when it started? I'll come back to you [TIMEFRAME].`,
      ].join("\n");
    }
    return [
      `Hi ${name},`,
      ``,
      `Thanks for the report${askedAbout ? ` about ${askedAbout}` : ""} — I'm looking into it now.`,
      ``,
      `To narrow it down quickly, could you send:`,
      `- Roughly when it started`,
      `- What you were doing when it happened`,
      `- A screenshot or the exact error text`,
      ``,
      `I'll update you by [DATE] either way, even if it's still in progress.`,
      ``,
      `Best,`,
      `[YOUR NAME]`,
    ].join("\n");
  },

  INTRO: ({ name, short, workspaceName }) => {
    if (short) {
      return [
        `Hi ${name} — thanks for getting in touch.`,
        ``,
        `What are you trying to solve? Happy to tell you whether we're a fit.`,
      ].join("\n");
    }
    return [
      `Hi ${name},`,
      ``,
      `Thanks for getting in touch with ${workspaceName}.`,
      ``,
      `So I point you at the right thing rather than sending a brochure — what are you trying to solve at the moment, and is there a timeline you're working to?`,
      ``,
      `If it's easier to talk, I'm around [DAY] and [DAY].`,
      ``,
      `Best,`,
      `[YOUR NAME]`,
    ].join("\n");
  },

  NOISE: ({ name }) =>
    [
      `No reply needed — this was filtered as noise.`,
      ``,
      `If that's wrong, mark the thread as a real lead and the engine will stop`,
      `filtering similar messages from ${name}.`,
    ].join("\n"),
};

/** Pull the sender's actual question out, to quote back in the reply. */
function extractAsk(body: string): string | undefined {
  const text = stripQuotedText(body);
  const question = text
    .split(/(?<=[.?!])\s+/)
    .map((s) => s.trim())
    .find((s) => s.endsWith("?") && s.length > 12 && s.length < 160);
  if (!question) return undefined;
  return question.replace(/^[-•*\s]+/, "").toLowerCase().replace(/\?$/, "");
}

export function writeDraft(context: TriageContext, triage: TriageResult): string {
  const template = TEMPLATES[triage.intent] ?? TEMPLATES.INTRO;
  return template({
    name: firstName(context.contact.name),
    company: context.contact.company,
    askedAbout: extractAsk(context.message.body),
    short: isShortFormChannel(context.message.channel),
    workspaceName: context.workspace.name,
    signals: triage.signals,
  });
}
