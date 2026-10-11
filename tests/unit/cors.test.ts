// Unit tests for the CORS helpers: pure functions, no server, no database.
// Run: npx tsx --test tests/unit/*.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  corsHeaders,
  matchedOrigin,
  normaliseOrigin,
  normaliseOrigins,
} from "../../src/lib/cors";

describe("normaliseOrigin", () => {
  it("lowercases and keeps a clean origin", () => {
    assert.equal(normaliseOrigin("https://Acme.COM"), "https://acme.com");
  });
  it("strips a path down to the origin", () => {
    assert.equal(normaliseOrigin("https://acme.com/forms"), "https://acme.com");
  });
  it("refuses non-http schemes", () => {
    assert.equal(normaliseOrigin("ftp://acme.com"), "");
  });
  it("refuses garbage", () => {
    assert.equal(normaliseOrigin("not a url at all !!!"), "");
    assert.equal(normaliseOrigin(""), "");
  });
});

describe("normaliseOrigins", () => {
  it("splits, normalises and dedupes", () => {
    assert.deepEqual(normaliseOrigins("https://a.com, https://A.com/, https://b.com"), [
      "https://a.com",
      "https://b.com",
    ]);
  });
});

describe("matchedOrigin", () => {
  const req = (origin?: string) =>
    new Request("https://api.test/", origin ? { headers: { origin } } : undefined);
  it("matches a listed origin", () => {
    assert.equal(matchedOrigin(req("https://shop.example.com"), "https://shop.example.com"), "https://shop.example.com");
  });
  it("refuses an unlisted origin", () => {
    assert.equal(matchedOrigin(req("https://evil.example.com"), "https://shop.example.com"), null);
  });
  it("refuses when the key lists nothing", () => {
    assert.equal(matchedOrigin(req("https://shop.example.com"), ""), null);
  });
  it("needs no origin on a server-to-server call", () => {
    assert.equal(matchedOrigin(req(), "https://shop.example.com"), null);
  });
});

describe("corsHeaders", () => {
  it("echoes a matched origin and varies", () => {
    const headers = corsHeaders(
      new Request("https://api.test/", { headers: { origin: "https://shop.example.com" } }),
      "https://shop.example.com",
    );
    assert.equal(headers["access-control-allow-origin"], "https://shop.example.com");
    assert.equal(headers["vary"], "Origin");
  });
  it("echoes nothing for a stranger, but still varies", () => {
    const headers = corsHeaders(
      new Request("https://api.test/", { headers: { origin: "https://evil.example.com" } }),
      "https://shop.example.com",
    );
    assert.ok(!("access-control-allow-origin" in headers));
    assert.equal(headers["vary"], "Origin");
  });
});
