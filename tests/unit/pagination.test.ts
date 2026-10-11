// Unit tests for keyset pagination: encode/decode round-trips and the
// refusal of anything we cannot honour (which the route turns into 422).
// Run: npx tsx --test tests/unit/*.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CursorError,
  decodeThreadCursor,
  encodeThreadCursor,
} from "../../src/lib/pagination";

describe("thread cursors", () => {
  it("round-trips a row", () => {
    const row = {
      awaitingReply: true,
      score: 82,
      lastMessageAt: new Date("2026-03-01T10:00:00Z"),
      id: "cm123",
    };
    const decoded = decodeThreadCursor(encodeThreadCursor(row));
    assert.equal(decoded.awaitingReply, true);
    assert.equal(decoded.score, 82);
    assert.equal(decoded.id, "cm123");
    assert.equal(decoded.lastMessageAt.toISOString(), "2026-03-01T10:00:00.000Z");
  });
  it("is opaque, not a row offset", () => {
    const cursor = encodeThreadCursor({
      awaitingReply: false,
      score: 10,
      lastMessageAt: new Date(),
      id: "x",
    });
    assert.match(cursor, /^[A-Za-z0-9_-]{8,}$/);
  });
  it("refuses garbage, truncation and foreign shapes", () => {
    for (const bad of [
      "MTAw",
      "!!!",
      "",
      Buffer.from(JSON.stringify({ a: 1 })).toString("base64url"),
      Buffer.from(JSON.stringify({ a: 1, s: "high", t: "yesterday", i: 7 })).toString(
        "base64url",
      ),
    ]) {
      assert.throws(() => decodeThreadCursor(bad), CursorError);
    }
  });
});
