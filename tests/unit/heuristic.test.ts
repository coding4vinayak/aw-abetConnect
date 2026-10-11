// Unit tests for the heuristic scoring engine: deterministic, no API key,
// fast enough to run inline — so fast enough to run here on every check.
// Run: npx tsx --test tests/unit/*.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BUCKET_THRESHOLDS, bucketForScore, clampScore } from "../../src/lib/intelligence/engine";
import { HeuristicEngine } from "../../src/lib/intelligence/heuristic";
import type { TriageContext } from "../../src/lib/intelligence/engine";
import type { NormalizedMessage } from "../../src/lib/types";

const engine = new HeuristicEngine();

function context(body: string, overrides: Partial<NormalizedMessage> = {}): TriageContext {
  return {
    message: {
      channel: "EMAIL",
      direction: "INBOUND",
      body,
      sentAt: new Date(),
      subject: "Re: pricing",
      contact: {},
      ...overrides,
    },
    contact: {},
    workspace: { name: "Test Co" },
  };
}

describe("bucketForScore / clampScore", () => {
  it("buckets at the documented thresholds", () => {
    assert.equal(bucketForScore(BUCKET_THRESHOLDS.HOT), "HOT");
    assert.equal(bucketForScore(BUCKET_THRESHOLDS.HOT - 1), "WARM");
    assert.equal(bucketForScore(BUCKET_THRESHOLDS.WARM - 1), "NURTURE");
    assert.equal(bucketForScore(BUCKET_THRESHOLDS.NURTURE - 1), "NOISE");
  });
  it("clamps scores into 0..100", () => {
    assert.equal(clampScore(140), 100);
    assert.equal(clampScore(-3), 0);
  });
});

describe("HeuristicEngine.triage", () => {
  it("ranks a senior buyer with budget and a deadline as HOT", async () => {
    const triage = await engine.triage(
      context(
        "Our budget has been approved and I need a purchase order raised before Friday. " +
          "Please send a quote for 80 seats on an annual contract.",
        { subject: "Budget approved - need a quote" },
      ),
    );
    assert.equal(triage.bucket, "HOT");
    assert.ok(triage.score >= BUCKET_THRESHOLDS.HOT);
    assert.ok(triage.signals.length > 0);
    assert.ok(triage.reason && triage.reason.length > 0);
  });

  it("clamps a newsletter that mentions pricing to NOISE", async () => {
    const triage = await engine.triage(
      context(
        "This week we look at pricing, contracts and quotes across 40 companies. " +
          "Read online or unsubscribe here.",
        { subject: "Pricing teardown" },
      ),
    );
    assert.equal(triage.bucket, "NOISE");
  });

  it("never pins past 100 no matter how much buying language piles up", async () => {
    const triage = await engine.triage(
      context("pricing contract invoice quote budget approved purchase order procurement " +
        "pricing contract invoice quote budget approved purchase order procurement"),
    );
    assert.ok(triage.score <= 100);
  });

  it("scores every message with its engine name, so a wrong score is traceable", async () => {
    const triage = await engine.triage(context("Just saying hello."));
    assert.equal(triage.engine, "heuristic/v1");
  });
});
