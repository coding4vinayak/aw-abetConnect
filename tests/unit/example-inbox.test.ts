// The sample inbox, pinned.
//
// The failure this file exists to prevent is a sample inbox that *claims* to
// show the product's ranking while carrying scores someone wrote by hand. The
// ranking is the product; a sample that fakes it teaches the wrong thing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EXAMPLE_INBOX, EXAMPLE_EMAIL_DOMAIN, isExampleEmail } from '../../src/lib/example-inbox';
import { parseAddress } from '../../src/lib/channels/parse';

const SRC = readFileSync(new URL('../../src/lib/example-inbox.ts', import.meta.url), 'utf8');

test('every example contact is unmistakably an example', () => {
  // RFC 2606 reserves example.com for exactly this, so a visitor can never
  // mistake a sample conversation for a real one — and the removal can be
  // surgical.
  assert.equal(EXAMPLE_EMAIL_DOMAIN, 'example.com');
  for (const entry of EXAMPLE_INBOX) {
    // The EMAIL payloads carry a display name with the address ("Name <addr>"),
    // so the address is parsed the way the adapter parses it.
    const raw = String(entry.payload.email ?? entry.payload.from ?? '');
    const email = entry.payload.email ? raw : parseAddress(raw).email;
    assert.ok(
      isExampleEmail(email),
      `${email} is not on @${EXAMPLE_EMAIL_DOMAIN} — a sample contact must not look real`,
    );
  }
});

test('the removal is surgical: it matches the example domain and nothing else', () => {
  assert.equal(isExampleEmail('buyer@example.com'), true);
  assert.equal(isExampleEmail('Buyer@Example.com'), true);
  assert.equal(isExampleEmail('buyer@company.com'), false);
  assert.equal(isExampleEmail('notexample.com'), false);
  assert.equal(isExampleEmail(''), false);
  assert.equal(isExampleEmail(null), false);
  assert.equal(isExampleEmail(undefined), false);
  assert.match(SRC, /email:\s*\{\s*endsWith: `\@\$\{EXAMPLE_EMAIL_DOMAIN\}` \}/);
});

test('the scores are the engine\'s — the loader goes through the real ingest path', () => {
  // The whole point: a sample that writes its own scores would show a
  // ranking the product would never produce.
  assert.match(SRC, /ingestMessage\(/, "the loader must use the real ingest path");
  assert.match(SRC, /getAdapter\(/, "and the real per-channel normalisation");
  assert.ok(
    !/score:\s*\d+/.test(SRC),
    "nothing here may write a score — the engine computes it",
  );
});

test('the sample shows the product\'s whole opinion, not one message', () => {
  assert.ok(EXAMPLE_INBOX.length >= 5, "a sample needs enough to show a ranking");
  // More than one channel, so the cross-channel story is visible.
  const channels = new Set(EXAMPLE_INBOX.map((e) => e.channel));
  assert.ok(channels.size >= 2, "the sample should cross channels");
  // And a thread with more than one message, because a conversation is the
  // unit the queue ranks.
  assert.ok(
    EXAMPLE_INBOX.some((e) => e.replyTo !== undefined),
    "one conversation should carry a reply",
  );
});

test('loading twice changes nothing', () => {
  assert.match(SRC, /if \(existing\) return \{ created: false/, "a second load must be a no-op");
});

test('the door is a session or a key — the browser and the machine both count', () => {
  const route = readFileSync(new URL('../../src/app/api/example-data/route.ts', import.meta.url), 'utf8');
  assert.match(route, /getSession\(\)/, "the dashboard's browser path");
  assert.match(route, /authenticate\(request\)/, "the API's machine path");
  assert.match(route, /status: 401/, "and an anonymous caller is refused");
});
