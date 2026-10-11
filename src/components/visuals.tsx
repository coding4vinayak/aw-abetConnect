import type { ReactNode } from "react";

/** Shared presentational atoms for the triage screen. */

export const BUCKET_STYLES: Record<
  string,
  { text: string; bg: string; border: string; dot: string; label: string }
> = {
  HOT: {
    text: "text-[var(--hot)]",
    bg: "bg-[color-mix(in_srgb,var(--hot)_14%,transparent)]",
    border: "border-[color-mix(in_srgb,var(--hot)_35%,transparent)]",
    dot: "bg-[var(--hot)]",
    label: "Hot",
  },
  WARM: {
    text: "text-[var(--warm)]",
    bg: "bg-[color-mix(in_srgb,var(--warm)_14%,transparent)]",
    border: "border-[color-mix(in_srgb,var(--warm)_35%,transparent)]",
    dot: "bg-[var(--warm)]",
    label: "Warm",
  },
  NURTURE: {
    text: "text-[var(--nurture)]",
    bg: "bg-[color-mix(in_srgb,var(--nurture)_14%,transparent)]",
    border: "border-[color-mix(in_srgb,var(--nurture)_35%,transparent)]",
    dot: "bg-[var(--nurture)]",
    label: "Nurture",
  },
  NOISE: {
    text: "text-[var(--noise)]",
    bg: "bg-white/[0.04]",
    border: "border-white/10",
    dot: "bg-[var(--noise)]",
    label: "Noise",
  },
};

export function bucketStyle(bucket: string) {
  return BUCKET_STYLES[bucket] ?? BUCKET_STYLES.NOISE;
}

const CHANNEL_LABELS: Record<string, string> = {
  EMAIL: "Email",
  WHATSAPP: "WhatsApp",
  SMS: "SMS",
  SLACK: "Slack",
  LINKEDIN: "LinkedIn",
  WEBFORM: "Web form",
};

export function channelLabel(channel: string): string {
  return CHANNEL_LABELS[channel] ?? channel;
}

/** Single-letter channel marks keep the list dense without losing the origin. */
const CHANNEL_MARKS: Record<string, string> = {
  EMAIL: "E",
  WHATSAPP: "W",
  SMS: "S",
  SLACK: "#",
  LINKEDIN: "in",
  WEBFORM: "F",
};

export function ChannelChip({ channel }: { channel: string }) {
  return (
    <span
      title={channelLabel(channel)}
      className="inline-flex h-4.5 min-w-4.5 items-center justify-center rounded border border-line bg-surface-raised px-1 font-mono text-[10px] leading-none text-muted"
    >
      {CHANNEL_MARKS[channel] ?? channel.slice(0, 1)}
    </span>
  );
}

export const INTENT_LABELS: Record<string, string> = {
  PRICING: "Pricing",
  DEMO: "Demo",
  RENEWAL: "Renewal",
  CHURN_RISK: "At risk",
  SUPPORT: "Support",
  INTRO: "Intro",
  NOISE: "Noise",
};

export function intentLabel(intent?: string | null): string {
  if (!intent) return "Unclassified";
  return INTENT_LABELS[intent] ?? intent;
}

/** The score, shown as a number with the bucket colour. No gauge, no sparkline —
 *  the rep needs a rank, not a dashboard. */
export function ScoreBadge({
  score,
  bucket,
  size = "md",
}: {
  score: number;
  bucket: string;
  size?: "sm" | "md" | "lg";
}) {
  const style = bucketStyle(bucket);
  const dims =
    size === "lg"
      ? "h-12 w-12 text-lg"
      : size === "sm"
        ? "h-7 w-7 text-[11px]"
        : "h-9 w-9 text-sm";
  return (
    <span
      className={`inline-flex ${dims} shrink-0 items-center justify-center rounded-lg border font-mono font-semibold tabular-nums ${style.bg} ${style.border} ${style.text}`}
    >
      {score}
    </span>
  );
}

export function Pill({
  children,
  tone = "neutral",
  title,
}: {
  children: ReactNode;
  tone?: "neutral" | "hot" | "warm" | "nurture" | "positive";
  title?: string;
}) {
  const tones: Record<string, string> = {
    neutral: "border-line bg-surface-raised text-muted",
    hot: "border-[color-mix(in_srgb,var(--hot)_35%,transparent)] bg-[color-mix(in_srgb,var(--hot)_12%,transparent)] text-[var(--hot)]",
    warm: "border-[color-mix(in_srgb,var(--warm)_35%,transparent)] bg-[color-mix(in_srgb,var(--warm)_12%,transparent)] text-[var(--warm)]",
    nurture:
      "border-[color-mix(in_srgb,var(--nurture)_35%,transparent)] bg-[color-mix(in_srgb,var(--nurture)_12%,transparent)] text-[var(--nurture)]",
    positive:
      "border-[color-mix(in_srgb,var(--positive)_35%,transparent)] bg-[color-mix(in_srgb,var(--positive)_12%,transparent)] text-[var(--positive)]",
  };
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

export function intentTone(intent?: string | null) {
  if (intent === "CHURN_RISK") return "hot" as const;
  if (intent === "PRICING" || intent === "RENEWAL") return "positive" as const;
  if (intent === "DEMO") return "warm" as const;
  return "neutral" as const;
}

export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const diff = Date.now() - then;
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.round(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  return new Date(iso).toLocaleDateString();
}

export function initials(name?: string | null, email?: string | null): string {
  const source = name?.trim() || email?.split("@")[0] || "?";
  const parts = source.split(/[\s._-]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
