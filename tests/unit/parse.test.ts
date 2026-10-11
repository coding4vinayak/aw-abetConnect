// Unit tests for channel parsing helpers: pure string work.
// Run: npx tsx --test tests/unit/*.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  coerceDate,
  companyFromEmail,
  normalisePhone,
  parseAddress,
  stripQuotedText,
  synthesiseSubject,
} from "../../src/lib/channels/parse";

describe("parseAddress", () => {
  it("splits a display name from the address", () => {
    assert.deepEqual(parseAddress("Jane Doe <jane@acme.com>"), {
      name: "Jane Doe",
      email: "jane@acme.com",
    });
  });
  it("falls back to the local part as the name", () => {
    assert.deepEqual(parseAddress("jane@acme.com"), {
      name: "Jane",
      email: "jane@acme.com",
    });
    assert.equal(parseAddress("jane.doe@acme.com")?.name, "Jane Doe");
  });
  it("tolerates emptiness", () => {
    assert.deepEqual(parseAddress(), {});
    assert.deepEqual(parseAddress(null), {});
  });
});

describe("companyFromEmail", () => {
  it("derives a company from a work address", () => {
    assert.equal(companyFromEmail("jane@acme.com"), "Acme");
  });
  it("says nothing for free mailboxes", () => {
    assert.equal(companyFromEmail("jane@gmail.com"), undefined);
  });
});

describe("stripQuotedText", () => {
  it("removes quoted history so replies do not re-score it", () => {
    const body = "Yes, proceed.\n\nOn Tue, Jane wrote:\n> please send pricing";
    const stripped = stripQuotedText(body);
    assert.ok(stripped.includes("Yes, proceed."));
    assert.ok(!stripped.includes("please send pricing"));
  });
});

describe("synthesiseSubject", () => {
  it("uses the first line, bounded with an ellipsis", () => {
    const subject = synthesiseSubject("Hello there, this is a long first line indeed yes", 20);
    assert.ok(subject.length <= 21);
    assert.ok(subject.startsWith("Hello"));
    assert.ok(subject.endsWith("…"));
  });
  it("leaves a short first line alone", () => {
    assert.equal(synthesiseSubject("Hi"), "Hi");
  });
});

describe("normalisePhone", () => {
  it("keeps digits, drops formatting", () => {
    assert.equal(normalisePhone("+1 (415) 555-0142"), "+14155550142");
  });
});

describe("coerceDate", () => {
  it("parses real timestamps and defaults sensibly", () => {
    assert.ok(coerceDate("2026-01-01T00:00:00Z") instanceof Date);
    assert.ok(coerceDate(undefined) instanceof Date);
  });
});
