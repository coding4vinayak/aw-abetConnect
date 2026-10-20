// The seat meter's arithmetic, pinned without a database. The interesting
// cases are the boundary at the cap and the deliberate fail-open when no
// quantity has ever been synced: an unknown cap is not a zero cap.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { seatDecision, seatSummary } from "../../src/lib/seats";

describe("seatSummary", () => {
  it("says nothing when there is no number to compare against", () => {
    assert.equal(seatSummary({ cap: null, used: 7 }), null);
  });

  it("counts the open seats, singular and plural", () => {
    assert.equal(seatSummary({ cap: 4, used: 2 }), "2 of 4 paid seats taken, 2 are still open.");
    assert.equal(seatSummary({ cap: 4, used: 3 }), "3 of 4 paid seats taken, 1 is still open.");
  });

  it("spells out the single-seat plan without inventing a second", () => {
    assert.equal(
      seatSummary({ cap: 1, used: 1 }),
      "The only paid seat is taken or already invited — the next person needs another seat.",
    );
  });

  it("names the full team as taken, not as an error", () => {
    assert.equal(
      seatSummary({ cap: 3, used: 3 }),
      "All 3 paid seats are taken or already invited — the next person needs another seat.",
    );
  });

  it("reports a team larger than the invoice as a shortfall", () => {
    assert.equal(
      seatSummary({ cap: 2, used: 4 }),
      "4 of 2 paid seats are taken — the team is bigger than the plan, and the invoice is short 2 seats.",
    );
    assert.match(seatSummary({ cap: 2, used: 3 }) ?? "", /short 1 seat\.$/);
  });
});

describe("seatDecision", () => {
  it("fails open on an unknown cap", () => {
    assert.deepEqual(seatDecision({ cap: null, used: 40 }), { allowed: true });
  });

  it("allows an invitation while a seat is open", () => {
    assert.deepEqual(seatDecision({ cap: 3, used: 2 }), { allowed: true });
  });

  it("refuses at the cap and repeats the count in the error", () => {
    const refused = seatDecision({ cap: 3, used: 3 });
    assert.equal(refused.allowed, false);
    if (refused.allowed) return;
    assert.match(refused.error, /^All 3 paid seats are taken/);
    assert.match(refused.error, /priced per agent/);
    assert.match(refused.error, /billing portal changes the quantity/);
  });
});
