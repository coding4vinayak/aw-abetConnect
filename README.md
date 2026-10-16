# abetConnect

![CI](https://github.com/coding4vinayak/aw-abetConnect/actions/workflows/ci.yml/badge.svg)


One inbox for every channel, ranked by who is closest to buying.

Email, WhatsApp, SMS, Slack, LinkedIn and web forms land in a single queue. Each
conversation gets a 0–100 score for sales intent, an explanation of that score,
and a drafted reply. The top of the list is who to talk to next.

That is the whole product. It does one job, so it can be sold on its own — and
because messages arrive through one endpoint and results leave through webhooks,
it also works as the triage layer inside a larger stack.

## Quick start

```bash
npm install
cp .env.example .env        # DATABASE_URL points at the compose Postgres
docker compose up -d        # local Postgres 16
npx prisma migrate deploy   # applies the committed migrations
npm run seed                # loads a realistic multi-channel inbox
npm run dev                 # http://localhost:3000
```

`npm run seed` prints an API key, the ranked queue the engine produced, and the
account that owns the demo workspace: `demo@abetconnect.dev` / `demo-password`.
That is how you get past the login screen. Skipping the seed works too — sign up
at `/signup` and you get an empty workspace that nobody else can see.

## Screens

Every page route is listed so the README stays the single source of truth for
what the product contains.

| Route | Purpose |
|-------|---------|
| `/` | Ranked queue (dashboard) — requires sign-in |
| `/login` | Sign in with email + password |
| `/signup` | Create a new workspace + owner account |
| `/verify-email` | Consumes an email verification token, then redirects to `/login` |
| `/reset-password` | Consumes a password-reset token, lets the user set a new password |
| `/integrations` | Issue/revoke API keys (secret + publishable) |
| `/members` | Invite teammates, manage roles (owner/admin/member) |
| `/invite/[token]` | Accept an invitation into a workspace |
| `/pricing` | Public plans: $24/agent/mo, annual, enterprise — no sign-in |
| `/support` | Contact, SLAs, status, and before-you-write-in answers — no sign-in |
| `/changelog` | Version history, newest first — no sign-in |
| `/terms` | Terms of Service — no sign-in |
| `/privacy` | Privacy Policy — no sign-in |

Signup creates three things in one transaction: the user, a private workspace,
and an OWNER membership linking them. The session cookie that follows is what the
dashboard and every server action scope themselves to.

Guessing at the login form is limited per address — ten attempts every fifteen
minutes, after which the form says so and the wait begins. The count is keyed on
the address rather than the account on purpose: a per-account limit would let
anyone lock a customer out of their own workspace simply by failing against their
email all afternoon. A correct sign-in clears the address's history, and the
expensive password hash is skipped entirely once a budget is spent, so a flooded
login page stops being a way to spend someone else's CPU.

A signed-up workspace has no API key, and only an owner or admin inside it can
give it one — `npm run seed` belongs to the demo workspace, and a customer on
their own server cannot run it for you. So keys are issued on `/integrations`:
name the key, copy the plaintext once, and it authenticates immediately. Revoking
takes effect on the next request. The plaintext is never stored and never rendered
twice, so losing it means minting a replacement rather than recovering it.

## How the scoring works

Scores are built from individual signals, each with a weight, and the UI shows
every one of them next to the number. A rep who cannot see why a thread is at
the top will not trust the ranking, so the explanation is not optional.

Signal categories:

| Category | Examples |
| --- | --- |
| Buying intent | quote requested, budget approved, PO raised, procurement started, renewal due |
| Urgency | "before Friday", quarter-end, chasing a reply |
| Authority | seniority inferred from the signature, buying on behalf of a company |
| Deal size | currency amounts, seat counts, enterprise-scale language |
| Engagement | multiple unanswered messages, channel the message arrived on |
| Multi-channel | the same person chasing across two channels |
| Churn risk | cancellation, refund, complaint, "switching to" |
| Noise | unsubscribe footers, auto-replies, recruiters, cold pitches |

Two decisions worth knowing about:

**Categories are capped.** A message saying "pricing", "contract" and "invoice"
is one signal — they want to buy — not three. Without ceilings every good lead
pins at 100 and the queue stops being ranked. Weights inside an over-budget
category are scaled proportionally so the numbers shown still add up to the
score exactly.

**Hard noise wins outright.** A newsletter whose subject line mentions pricing
would otherwise outrank a real buyer. An unsubscribe footer, auto-reply or spam
marker clamps the score regardless of what else the message contains.

Churn risk scores *high*, not low. A customer threatening to cancel is urgent
revenue, and one answered within the hour is often saved.

## The engine is pluggable

The built-in heuristic engine is the default and is a first-class mode, not a
degraded one: deterministic, explainable, free, and fast enough to run inline on
ingest.

Set `LLM_API_KEY` (any OpenAI-compatible endpoint) and a model takes over
scoring and drafting. The heuristic result is passed to it as a prior and used
as the fallback if the model is slow, down, rate-limited or returns a malformed
shape. Triage never fails closed — an inbox that stops sorting is worse than one
sorted slightly less well.

## API

```
POST   /api/v1/messages                    # ingest from any channel
POST   /api/v1/channels/{channel}/webhook  # per-channel URL for providers
GET    /api/v1/channels/{channel}/webhook  # handshake: proves the URL is live
GET    /api/v1/threads                     # the ranked queue
GET    /api/v1/threads/{id}
PATCH  /api/v1/threads/{id}                # status, snooze, score override
POST   /api/v1/threads/{id}/draft          # regenerate the suggested reply
PATCH  /api/v1/threads/{id}/draft          # rewrite it first: { "body": "..." }
POST   /api/v1/threads/{id}/reply          # record a sent reply
GET    /api/v1/webhooks
POST   /api/v1/webhooks                    # subscribe
GET    /api/v1/webhooks/{id}
PATCH  /api/v1/webhooks/{id}               # move, re-scope, or silence one
DELETE /api/v1/webhooks/{id}               # unsubscribe
GET    /api/v1/openapi                     # this contract, as OpenAPI 3.1
GET    /api/health                         # liveness probe, no key: {ok, db, time}
POST   /api/auth/send-verification         # resend verification email (session required)
GET    /api/auth/verify-email              # consume verification token (public)
POST   /api/auth/forgot-password           # request password reset (public, no enumeration)
POST   /api/auth/reset-password            # consume reset token + set new password (public)
```

Authenticate with `Authorization: Bearer <key>`, `X-Api-Key`, or `?key=` on
channel webhooks for providers that cannot set headers. Only the SHA-256 hash of
a key is stored, so the plaintext is shown once at creation.

Ingest accepts each provider's own payload shape — SendGrid, Postmark, Mailgun,
Twilio (form-encoded), Meta Cloud API, Slack Events — and normalises it through
a channel adapter. Adding a channel means adding one adapter and nothing else.

Ingest is idempotent on the provider's message id (`submissionId` or `id` on a web
form), because providers retry and a replayed message must not re-inflate a score.
A replay returns the original thread with `duplicate: true` and HTTP 200 rather
than a second 201, so a double-submitting form cannot create two leads.

### The contract is checkable

`GET /api/v1/openapi` serves the OpenAPI 3.1 document, unauthenticated: an
integrator decides whether to build against an API before they may hold a key.

That document is not maintained by hand. `npm run check:contract` reads it back
against the source and fails the build when a path is described with no handler,
when a handler answers with nothing describing it, when the spec advertises a
parameter the route never parses, when a route returns a status the spec omits, or
when an error code is listed that nothing can reach. The version in `info` is
compared against `package.json`, and the README against both.

The rule that earns its keep: a documented parameter nobody reads is invisible to
every test. `cursor` sat in the queue's own comment for months, unimplemented, so
anyone paging a large workspace re-fetched page one forever and assumed their loop
was at fault.

### Paging the queue

`GET /api/v1/threads` takes `limit` (default 50, clamped to 200) and returns
`nextCursor`. Send it back as `cursor` for the next page; `nextCursor` is `null` on
the last one.

The cursor is opaque and keyset-based, not an offset. The queue is ordered by
awaiting-reply, then score, then recency, then id — and score and awaiting-reply
change while a human or a cron job is walking it. An offset would let a re-ranked
thread appear twice or vanish between pages, which in this product means a lead
nobody answered. Filters and cursors compose, so `q` and `cursor` together still
page a search. A cursor from a different query keeps working; a malformed one is a
422 with code `invalid_cursor`, not a silent return to page one.

### Errors

Every failure is the same envelope:

```json
{ "error": { "code": "invalid_request", "message": "...", "param": "channel" } }
```

`message` is written for a person and will be reworded. `code` is the contract, and
`param` names the field at fault when one field caused it.

| Code                   | Status | Meaning                                        |
| ---------------------- | ------ | ---------------------------------------------- |
| `authentication_error` | 401    | No key, or one that no longer resolves         |
| `invalid_request`      | 422    | Well-formed request, unusable content          |
| `invalid_cursor`       | 422    | A `cursor` this server cannot honour           |
| `unknown_channel`      | 404    | The `{channel}` in the URL is not one we speak |
| `not_found`            | 404    | Not in this workspace — including not yours    |
| `conflict`             | 409    | The thread exists; its state forbids this      |
| `internal_error`       | 500    | Ours. Safe to retry                            |


### Outbound webhooks

`thread.created`, `thread.scored`, `thread.hot`, `thread.at_risk`,
`draft.created`, `reply.sent` — each delivered as JSON with an `id`, an `event`, a
`timestamp` in seconds and the `data` for that event. `POST /api/v1/webhooks`
subscribes and returns a `whsec_…` signing secret once, afterwards only a preview;
`PATCH /api/v1/webhooks/{id}` silences or moves a subscription, and
`DELETE /api/v1/webhooks/{id}` ends it.

Verify every delivery before acting on it. The signature is HMAC-SHA256 over
`{timestamp}.{body}` — the timestamp is inside what gets signed, so a captured
request cannot be replayed forever, but only your own tolerance window decides
how long is too long:

```js
import { createHmac, timingSafeEqual } from "node:crypto";

function verify(rawBody, secret, timestampHeader, signatureHeader, toleranceSecs = 300) {
  const expected = createHmac("sha256", secret).update(`${timestampHeader}.${rawBody}`).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader ?? "");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  return Math.abs(Date.now() / 1000 - Number(timestampHeader)) <= toleranceSecs;
}
```

Pass the body as raw bytes. Re-serialising it before verification fails on the
first key whose ordering or escaping differs, and that reads like a broken
signature rather than a changed string.

Every delivery also carries `x-webhook-signature: sha256=<hex>` — the same key
signed over the raw body alone. That is GitHub's spelling, and what an inbound
nuCRM plugin webhook (`/api/tenant/plugins/webhook/{id}`) verifies natively, so
a nuCRM endpoint can subscribe here with this secret and no adapter between the
products. The body-only digest has no timestamp inside it; receivers that want
the signed-string replay window should keep verifying the `x-abetconnect-*`
pair above.

**abetConnect never sends messages itself.** `reply.sent` is where your existing
provider delivers. Owning delivery would mean owning deliverability, compliance
and inbox reputation, which is a different product.

## Billing

$24/agent/month via Stripe. Three endpoints, all under `/api/billing`
(session-gated except the webhook, which carries a Stripe signature):

POST /api/billing/checkout
POST /api/billing/portal
POST /api/billing/webhook

`checkout` takes `{ priceId: "SEAT_MONTHLY" | "SEAT_ANNUAL", returnUrl }` and
returns `{ url }` to redirect the buyer to. `portal` takes `{ returnUrl }`
and returns the Customer Portal URL for plan changes and cancellation. The
webhook handles `checkout.session.completed`, `customer.subscription.*`, and
`invoice.payment_failed`, syncing status into the `Subscription` row the app
reads with `hasActiveSubscription()`.

Setup: create the two prices in the Stripe dashboard, set `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_SEAT_MONTHLY`, `STRIPE_PRICE_SEAT_ANNUAL` (see `.env.example`), and forward webhooks locally with `stripe listen --forward-to localhost:3101/api/billing/webhook`. Without keys the app runs normally; only the billing routes 500. Webhook signature verification is covered by `tests/unit/billing.test.ts` (offline, no network).

## Your team

Two screens, gated by the session cookie like the queue itself. **`/members`** lists
who can reach the workspace and is where invitations get issued, revoked and
re-rolled; **`/invite/{token}`** is what an invitation link points at. Neither is part
of the REST API: no API key reaches them, and the browser never needs a key to use
them.

| Role | Can | Cannot |
| --- | --- | --- |
| OWNER | all of it, including inviting admins and taking seats back | hand out ownership by invitation |
| ADMIN | work the queue, invite members, manage API keys | invite or edit another admin, change their own seat |
| MEMBER | work the queue: read threads, reply, use the drafts | invite anyone, see or manage API keys |

An invitation is a link, not an account. What makes it safe to send:

- **It names one address.** Accepting means being signed in as that address, so a link
  forwarded to whoever is nearest is not a door. The mismatch is refused and
  explained rather than silently failing.
- **It works once.** The `acceptedAt` column is claimed by a conditional update, so two
  people opening the same link in the same second produce one member and one refusal.
- **It expires**, seven days out.
- **It grants ADMIN or MEMBER, never OWNER.** Signup creates an owner and nothing in the
  invite path can mint one.
- **Only the hash survives**, which is already the rule for API keys and session
  cookies — a dumped `Invite` table is a list of unusable strings.
- **Re-inviting rotates the link.** The plaintext is never kept, so an old copy in
  somebody's drafts stops working instead of living next to the new one.

abetConnect **sends no email**. `/members` shows the link once beside a copy button,
and pasting it into a message you already trust is the step left to a human. An
address with no account yet can still be invited: they sign up, then reopen the link,
which is still live.

Changing a seat is the other half of the feature, because an invitation can only ever
*add* access. An owner may demote an admin or promote a member; an admin may re-role
members only. Taking someone's access also deletes the session cookie that was minted
in this workspace, so their queue closes on the next request rather than whenever their
tab happens to reload.

## Verifying it

```bash
npm run build && bash scripts/smoke.sh
```

Boots the production build and checks 154 behaviours end to end: API-key rejection,
queue ordering, scoring and bucketing, deal-size parsing, idempotent replay,
noise suppression, cross-channel contact merging via a form-encoded Twilio post,
Slack's `url_verification` handshake and bot-echo suppression, the outbound
guard, the draft and reply lifecycle, answered threads dropping down the queue,
triage actions, webhook validation, paging the queue with cursors, the served
OpenAPI contract — and the auth and credential layer: a stranger
is bounced to `/login`, the seeded owner signs in through the same wire format a
browser uses, a second tenant who signs up next door sees none of the first
tenant's workspace, threads or leads, and a new tenant can issue itself a key from
the integrations page, use it to ingest a lead, watch the plaintext appear exactly
once, revoke it, find it rejected at the API afterwards, and fail to revoke the
first tenant's key by guessing its id. A publishable website-form key is walked
down that same wire too: minted with an origin allowlist, it posts a web form and
nothing else — another channel, the queue, and a foreign origin are all refused,
the allowlisted origin posts with its origin echoed back, the preflight is
answered, thirty posts from one address all land and the thirty-first is
refused with `retry-after` plus the IETF `ratelimit` quota and
`ratelimit-policy` headers, and revoking ends it. The last two sections are the hostile ones:
nine wrong guesses from one address, a tenth that says the budget is gone, the
*correct* password refused after that, the next address still signing straight in,
and then the response headers — framing refused on the pages and the API alike,
and the session cookie checked for `Secure` and `HttpOnly` on a real login. The team
section walks the whole invitation lifecycle down that same wire: an owner issues a
link, the named address signs up afterwards and redeems it into the inviter's
workspace, a member is shown none of the invite or key controls, an admin is refused
the power to make another admin, and a demoted or removed seat stops working on the
next request rather than at the next deploy.

That is the wire. Three more checks need no running server and no database of yours:

```bash
npm run check
```

which is `typecheck`, `lint`, and:

- **`test:unit`** runs 37 unit tests over the pure modules with no server and no
  database: the CORS origin rules, the address/phone/date parsers, the role
  grant matrix, the keyset cursor codec, and the heuristic scorer (a senior
  buyer with budget and a deadline scores HOT, a pricing newsletter scores
  NOISE, nothing pins past 100).
- **`check:docs`** reads this README against the tree. Every documented endpoint has a
  handler, every handler is documented, every screen is named here, and every
  environment variable the README tells you to set is read by something.
- **`check:access`** builds a throwaway database by running `prisma migrate deploy`
  against the committed migrations — the same command the deploy below runs — and then
  asserts 122 things about roles and invitations: the whole grant matrix, the
  properties an invitation link is supposed to have, an expired link, a revoked link,
  a link redeemed twice in the same instant, one workspace reaching for another's
  seats, and whether the request handlers still call these rules instead of keeping
  private copies of them. It uses no credentials, never touches `prisma/dev.db`, and
  is the reason the role table above is evidence rather than a description. A
  migration that only works on a machine already holding the data fails here, not in
  front of a customer.

## Putting it somewhere

```bash
npm ci
npm run db:deploy
npm run build
npm start
```

The migrate line is not decoration. `next build` succeeds happily against a schema
nobody has applied, so the box looks shipped and the first request that touches a
missing table is a 500 on a page that tested fine on every machine before this one —
which is exactly how `/members` and `/invite/{token}` would arrive broken, since both
read the `Invite` table on load.

Three things want deciding before that box is public, and none of them are in the
code:

**HTTPS is required, not optional.** A production build marks the session cookie
`Secure`, so a browser will simply never send it back over plain http — login
looks like it does nothing. `npm run dev` is fine over http on localhost, which a
real browser treats as secure; a LAN address such as `http://192.168.1.20` is not,
so demo over the network with a tunnel or a certificate, not with http.

**The guessing limit is only as strong as the proxy in front of it.** It reads
`cf-connecting-ip`, falling back to the leftmost `x-forwarded-for`. Behind
Cloudflare those are set for you and cannot be forged; reachable directly, an
attacker labels each attempt with a fresh address and gets a fresh budget. Keep the
origin bound to the proxy.

**SQLite needs a disk that survives a deploy.** The default filesystem on a
container platform is usually ephemeral, which means every restart empties the
workspace. Either attach a persistent volume to the path in `DATABASE_URL` or move
to Postgres — which is the scaling path below.

## Scaling up: Postgres and replicas

One instance on SQLite serves a pilot. Past that — more traffic, more than one
replica, or backups you trust — the path is Postgres, and it has been walked
end to end (schema pushed to PostgreSQL 18, app seeded and serving reads,
scored ingest and quota headers against it):

```bash
# 1. provider + database
# prisma/schema.prisma: provider = "postgresql", DATABASE_URL="postgresql://…"
# 2. a FRESH migration history — the committed migrations are SQLite-dialect
#    and `migrate deploy` refuses them on Postgres (P3019). Do not replay them:
npx prisma migrate dev --name init
npm run seed
npm run build && bash scripts/smoke.sh
```

Three things that make replicas boring, all already true:

- **No in-process state.** Throttle budgets, sessions, idempotency keys and the
  queue all live in the database, so N replicas behind a round-robin need no
  stickiness and a restart loses no locks.
- **Pool for the replicas you run.** Prisma opens `num_physical_cpus * 2 + 1`
  connections per instance; with several instances cap each with
  `?connection_limit=` on `DATABASE_URL` so the fleet fits under the
  database's `max_connections`.
- **Probe `GET /api/health`, not `/`.** Unauthenticated, pings the database,
  200 when the instance can serve, 503 when it cannot. Point the load
  balancer and the container healthcheck at it.

## Stack

Next.js 16 (App Router) · React 19 · Tailwind 4 · Prisma 6 · SQLite

SQLite is used so the product runs with no infrastructure. The models are
Postgres-compatible — verified, not assumed (see "Scaling up" above). The
switch is a provider change plus a fresh migration history, because the
committed migrations are SQLite-dialect.

The dashboard uses server actions against the database directly, so no API key is
ever shipped to the browser, and no workspace id comes from the client: each action
re-derives it from the session cookie. The REST API exists for other systems and
authenticates by key, which is a separate path on purpose — `src/lib/auth.ts` for
keys, `src/lib/session.ts` for sessions, so one credential type can never be
mistaken for the other.

Who may do what is one module, `src/lib/roles.ts`, read by the invitation flow, the
seat controls and the API key guard alike, and asserted by `npm run check:access`. A
rule restated inside a page is a rule the next page will forget.

## Known gaps

- No password reset: a forgotten password means editing the database until someone
  builds the send-a-link flow.
- The guessing limit trusts whatever the proxy says the address was. Behind
  Cloudflare that is `cf-connecting-ip`, which the caller cannot forge; on a
  deploy where the origin is reachable directly, an attacker can label each
  attempt with a different address and get a fresh budget every time. The limit is
  therefore only as good as the deployment rule that the app is unreachable except
  through the proxy.
- The signup form confirms whether an email is already registered ("Sign in
  instead"), which the login form deliberately does not. It is the conventional
  thing to do on a B2B form and it is now bounded per address, but it remains the
  one place where the product will answer that question.
- API keys are all-or-nothing. There is no scope (a key that can ingest but not
  read, or read but not reply) and no expiry; the only control is revoking the
  whole key.
- Invitations are not delivered. The link is shown once on `/members` and a human
  copies it into a message they already trust. Wiring a provider means deciding what
  happens to an invitation when the mail bounces, which is a larger question than the
  send itself.
- Login takes you to your oldest workspace. Accepting an invitation moves the current
  session into that workspace, but signing out and back in returns you to the first
  one. The session row already carries `workspaceId`, so what is missing is a chooser
  rather than a schema change.
- Ownership cannot move. There is no transfer, and no other seat can be edited into an
  owner from inside the product, so an owner who leaves without naming a successor
  becomes a support call against the database.
- Access changes leave no history. An invitation records who sent it and when it was
  accepted; re-roling or removing a seat records nothing.
- Spent links pile up, and withdrawn ones vanish. An accepted or expired invitation
  stays in the `Invite` table indefinitely — harmless to security, since such a row
  grants nothing, but nothing collects it. Revoking is the opposite: it deletes the row
  outright, so a link you withdrew leaves no trace that it was ever handed out.
- Gating lives in the pages (`requireSession()`), not in middleware. That is
  deliberate — middleware runs at the edge, where a SQLite lookup does not belong —
  but it means a future route has to remember to call it.
- Webhook delivery is fire-and-forget with a 5s timeout and no retries. The event
  contract is right for a queue-backed upgrade, but that queue does not exist yet.
- Scoring weights are global. `sellsWhat` is plumbed through to the LLM engine as
  context but the heuristic lexicon is not yet tunable per workspace.
- Manual score overrides are recorded but not fed back into the model.
