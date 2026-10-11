#!/usr/bin/env bash
# End-to-end check against a running build: auth, ingest, scoring, idempotency,
# cross-channel merge, drafting, replying, and provider-specific webhook quirks.
set -uo pipefail

export NVM_DIR="/root/.nvm"
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"

cd "$(dirname "$0")/.."
PORT=3111
# A per-run address, so this script's deliberate failed guesses land in their own
# bucket and never lock out the run that happens next within the same window.
# Both octets vary: TEST-NET-1 and TEST-NET-2 are documentation ranges, so nothing
# real is being impersonated.
SMOKE_IP="198.51.100.$((RANDOM % 251 + 1)).$((RANDOM % 251 + 1))"

BASE="http://127.0.0.1:${PORT}"
PASS=0
FAIL=0

cleanup() {
  [[ -n "${SERVER_PID:-}" ]] && kill "$SERVER_PID" 2>/dev/null
}
trap cleanup EXIT

check() { # check <label> <expected> <actual>
  if [[ "$2" == "$3" ]]; then
    echo "  PASS  $1"
    PASS=$((PASS + 1))
  else
    echo "  FAIL  $1 (expected '$2', got '$3')"
    FAIL=$((FAIL + 1))
  fi
}

echo "Seeding…"
KEY=$(npm run seed 2>&1 | grep -o 'abc_live_[A-Za-z0-9_-]*' | head -1)
if [[ -z "$KEY" ]]; then
  echo "could not obtain an API key from the seed output"
  exit 1
fi
echo "Using key ${KEY:0:16}…"

echo "Starting server on ${PORT}…"
node node_modules/next/dist/bin/next start -p "$PORT" > /tmp/abet-server.log 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 40); do
  sleep 0.5
  curl -sf -o /dev/null "$BASE/api/v1/channels/email/webhook" && break
done

AUTH=(-H "Authorization: Bearer $KEY")
JSON=(-H "Content-Type: application/json")

echo
echo "--- auth ---"
check "no key is rejected" 401 \
  "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/v1/threads")"
check "wrong key is rejected" 401 \
  "$(curl -s -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer abc_live_nope' "$BASE/api/v1/threads")"
check "valid key is accepted" 200 \
  "$(curl -s -o /dev/null -w '%{http_code}' "${AUTH[@]}" "$BASE/api/v1/threads")"

echo
echo "--- ranked queue ---"
curl -s "${AUTH[@]}" "$BASE/api/v1/threads?limit=6" > /tmp/abet-queue.json
python3 scripts/show_queue.py /tmp/abet-queue.json
check "queue is ordered by score descending" "true" \
  "$(python3 - <<'PY'
import json
threads = json.load(open("/tmp/abet-queue.json"))["threads"]
scores = [t["score"] for t in threads]
print(str(scores == sorted(scores, reverse=True)).lower())
PY
)"

echo
echo "--- ingest a brand new hot lead ---"
NEW=$(curl -s "${AUTH[@]}" "${JSON[@]}" -X POST "$BASE/api/v1/messages" -d '{
  "channel": "EMAIL",
  "payload": {
    "from": "Hannah Wu <hannah.wu@meridiancorp.com>",
    "subject": "Budget approved - need a quote for 80 seats",
    "messageId": "<meridian-1@meridiancorp.com>",
    "text": "Our budget has been approved and I need to get a purchase order raised before Friday. Please send a quote for 80 seats on an annual contract.\n\nHannah Wu\nChief Operating Officer, Meridian Corp"
  }
}')
echo "$NEW" > /tmp/abet-new.json
python3 scripts/show_triage.py /tmp/abet-new.json
THREAD_ID=$(python3 -c 'import json;print(json.load(open("/tmp/abet-new.json"))["threadId"])')
check "new lead is bucketed HOT" "HOT" \
  "$(python3 -c 'import json;print(json.load(open("/tmp/abet-new.json"))["triage"]["bucket"])')"
check "intent detected as PRICING" "PRICING" \
  "$(python3 -c 'import json;print(json.load(open("/tmp/abet-new.json"))["triage"]["intent"])')"
# 80 seats at the assumed $300/seat/yr = $24,000 = 2,400,000 cents.
check "deal value parsed from seat count" "2400000" \
  "$(python3 -c 'import json;print(json.load(open("/tmp/abet-new.json"))["triage"]["estimatedValueCents"])')"
check "a draft was generated" "true" \
  "$(python3 -c 'import json;print(str(json.load(open("/tmp/abet-new.json"))["draftId"] is not None).lower())')"

echo
echo "--- idempotency: same provider message replayed ---"
DUP=$(curl -s "${AUTH[@]}" "${JSON[@]}" -X POST "$BASE/api/v1/messages" -d '{
  "channel": "EMAIL",
  "payload": {
    "from": "Hannah Wu <hannah.wu@meridiancorp.com>",
    "subject": "Budget approved - need a quote for 80 seats",
    "messageId": "<meridian-1@meridiancorp.com>",
    "text": "Our budget has been approved and I need to get a purchase order raised before Friday. Please send a quote for 80 seats on an annual contract."
  }
}')
echo "$DUP" > /tmp/abet-dup.json
check "replay is flagged as duplicate" "true" \
  "$(python3 -c 'import json;print(str(json.load(open("/tmp/abet-dup.json"))["duplicate"]).lower())')"
check "replay reuses the same thread" "$THREAD_ID" \
  "$(python3 -c 'import json;print(json.load(open("/tmp/abet-dup.json"))["threadId"])')"

echo
echo "--- noise must not rank ---"
NOISE=$(curl -s "${AUTH[@]}" "${JSON[@]}" -X POST "$BASE/api/v1/messages" -d '{
  "channel": "EMAIL",
  "payload": {
    "from": "Deals Weekly <hello@dealsweekly.com>",
    "subject": "Pricing teardown: how 40 SaaS companies price their contracts",
    "messageId": "<dw-1@dealsweekly.com>",
    "text": "This week we look at pricing, contracts and quotes across 40 companies. Read online or unsubscribe here."
  }
}')
echo "$NOISE" > /tmp/abet-noise.json
python3 scripts/show_triage.py /tmp/abet-noise.json
check "newsletter mentioning pricing/contracts/quotes is NOISE" "NOISE" \
  "$(python3 -c 'import json;print(json.load(open("/tmp/abet-noise.json"))["triage"]["bucket"])')"

echo
echo "--- cross-channel: same person on WhatsApp via a Twilio form post ---"
curl -s "${AUTH[@]}" "${JSON[@]}" -X POST "$BASE/api/v1/messages" -d '{
  "channel": "EMAIL",
  "payload": {
    "from": "Owen Frost <owen@lakesidefreight.com>",
    "subject": "Interested in a demo",
    "messageId": "<lakeside-1@lakesidefreight.com>",
    "text": "Could we see a demo next week? - Owen Frost, Head of Operations"
  }
}' > /tmp/abet-owen.json
OWEN_THREAD=$(python3 -c 'import json;print(json.load(open("/tmp/abet-owen.json"))["threadId"])')
OWEN_CONTACT=$(python3 -c 'import json;print(json.load(open("/tmp/abet-owen.json"))["contactId"])')

# Twilio posts form-encoded, not JSON, and prefixes the number with "whatsapp:".
# It also cannot set an Authorization header, hence ?key=.
curl -s -X POST "$BASE/api/v1/channels/whatsapp/webhook?key=$KEY" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "From=whatsapp:+447700900123" \
  --data-urlencode "ProfileName=Owen Frost" \
  --data-urlencode "MessageSid=SMtest001" \
  --data-urlencode "Body=Following up on the demo - can we do Tuesday? Need to decide this week." \
  > /tmp/abet-owen-wa.json
cat /tmp/abet-owen-wa.json
echo
check "form-encoded Twilio webhook is accepted" "true" \
  "$(python3 -c 'import json;d=json.load(open("/tmp/abet-owen-wa.json"));print(str("threadId" in d).lower())')"

echo
echo "--- Slack quirks ---"
CHALLENGE=$(curl -s -X POST "$BASE/api/v1/channels/slack/webhook?key=$KEY" "${JSON[@]}" \
  -d '{"type":"url_verification","challenge":"abc123xyz"}')
check "Slack url_verification is echoed" "abc123xyz" \
  "$(echo "$CHALLENGE" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("challenge"))')"
BOT=$(curl -s -X POST "$BASE/api/v1/channels/slack/webhook?key=$KEY" "${JSON[@]}" \
  -d '{"event":{"text":"deploy finished","bot_id":"B123","ts":"1721300000.1"}}')
check "Slack bot echo is ignored" "bot message" \
  "$(echo "$BOT" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("ignored"))')"

echo
echo "--- outbound guard ---"
OUT=$(curl -s -o /dev/null -w '%{http_code}' "${AUTH[@]}" "${JSON[@]}" -X POST "$BASE/api/v1/messages" \
  -d '{"channel":"EMAIL","direction":"OUTBOUND","payload":{"from":"sales@us.com","text":"hi"}}')
check "outbound without a threadId is refused" 422 "$OUT"

echo
echo "--- draft + reply lifecycle ---"
curl -s "${AUTH[@]}" -X POST "$BASE/api/v1/threads/$THREAD_ID/draft" > /tmp/abet-draft.json
echo "  drafted reply:"
python3 scripts/show_draft.py /tmp/abet-draft.json
check "draft regenerates" "true" \
  "$(python3 -c 'import json;d=json.load(open("/tmp/abet-draft.json"));print(str(len(d["draft"]["body"])>40).lower())')"

curl -s "${AUTH[@]}" "${JSON[@]}" -X POST "$BASE/api/v1/threads/$THREAD_ID/reply" \
  -d '{"body":"Hi Hannah, quote for 80 seats attached. Happy to jump on a call."}' > /tmp/abet-reply.json
check "reply is recorded" "false" \
  "$(python3 -c 'import json;print(str(json.load(open("/tmp/abet-reply.json"))["thread"]["awaitingReply"]).lower())')"
check "outbound message appended to transcript" "OUTBOUND" \
  "$(python3 -c 'import json;print(json.load(open("/tmp/abet-reply.json"))["thread"]["messages"][-1]["direction"])')"

echo
echo "--- answered threads drop below unanswered ones ---"
curl -s "${AUTH[@]}" "$BASE/api/v1/threads?limit=100" > /tmp/abet-queue2.json
check "answered hot thread is no longer at the top" "true" \
  "$(python3 - <<PY
import json
threads = json.load(open("/tmp/abet-queue2.json"))["threads"]
ids = [t["id"] for t in threads]
target = "$THREAD_ID"
print(str(target in ids and ids[0] != target).lower())
PY
)"

echo
echo "--- triage actions ---"
check "status change to WON" "WON" \
  "$(curl -s "${AUTH[@]}" "${JSON[@]}" -X PATCH "$BASE/api/v1/threads/$OWEN_THREAD" -d '{"status":"WON"}' \
    | python3 -c 'import json,sys;print(json.load(sys.stdin)["thread"]["status"])')"
check "invalid status rejected" 422 \
  "$(curl -s -o /dev/null -w '%{http_code}' "${AUTH[@]}" "${JSON[@]}" -X PATCH "$BASE/api/v1/threads/$OWEN_THREAD" -d '{"status":"BANANA"}')"
check "unknown thread is 404" 404 \
  "$(curl -s -o /dev/null -w '%{http_code}' "${AUTH[@]}" "$BASE/api/v1/threads/does-not-exist")"
check "score override recomputes the bucket" "NURTURE" \
  "$(curl -s "${AUTH[@]}" "${JSON[@]}" -X PATCH "$BASE/api/v1/threads/$THREAD_ID" -d '{"score":20}' \
    | python3 -c 'import json,sys;print(json.load(sys.stdin)["thread"]["bucket"])')"

echo
echo "--- webhook subscription ---"
check "http endpoint rejected" 422 \
  "$(curl -s -o /dev/null -w '%{http_code}' "${AUTH[@]}" "${JSON[@]}" -X POST "$BASE/api/v1/webhooks" -d '{"url":"http://evil.example.com/hook"}')"
check "unknown event rejected" 422 \
  "$(curl -s -o /dev/null -w '%{http_code}' "${AUTH[@]}" "${JSON[@]}" -X POST "$BASE/api/v1/webhooks" -d '{"url":"https://example.com/hook","events":["thread.exploded"]}')"
check "https endpoint accepted with a secret" "true" \
  "$(curl -s "${AUTH[@]}" "${JSON[@]}" -X POST "$BASE/api/v1/webhooks" -d '{"url":"https://example.com/hook","events":["thread.hot"]}' \
    | python3 -c 'import json,sys;print(str(json.load(sys.stdin)["secret"].startswith("whsec_")).lower())')"

echo
echo "--- paging the queue with cursors ---"
# The part of this API that cannot be checked by reading the code: a paging bug
# shows up as a lead nobody saw, on a workspace big enough to page.
PAGE1=$(mktemp)
curl -s "${AUTH[@]}" "$BASE/api/v1/threads?limit=2" -o "$PAGE1"
check "a page honours limit" 2 \
  "$(python3 -c 'import json,sys;print(len(json.load(open(sys.argv[1]))["threads"]))' "$PAGE1")"
CURSOR=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("nextCursor") or "")' "$PAGE1")
check "a full page hands back a cursor" "true" "$([[ -n "$CURSOR" ]] && echo true || echo false)"
check "…and it is opaque, not a row offset anyone could forge" "true" \
  "$(python3 -c 'import re,sys;print(str(bool(re.fullmatch(r"[A-Za-z0-9_-]{8,}", sys.argv[1]))).lower())' "$CURSOR")"

PAGE2=$(mktemp)
curl -s "${AUTH[@]}" "$BASE/api/v1/threads?limit=2&cursor=$CURSOR" -o "$PAGE2"
check "the next page shares no thread with the last" "true" \
  "$(python3 -c '
import json,sys
a={t["id"] for t in json.load(open(sys.argv[1]))["threads"]}
b={t["id"] for t in json.load(open(sys.argv[2]))["threads"]}
print(str(a.isdisjoint(b)).lower())' "$PAGE1" "$PAGE2")"

WALK=$(KEY="$KEY" BASE="$BASE" python3 - <<'PY'
import json, os, urllib.parse, urllib.request
base, key = os.environ["BASE"], os.environ["KEY"]
def get(q):
    url = base + "/api/v1/threads?" + urllib.parse.urlencode(q)
    req = urllib.request.Request(url, headers={"authorization": "Bearer " + key})
    return json.load(urllib.request.urlopen(req))
seen, pages, cursor = [], 0, None
while pages < 60:
    q = {"limit": "5"}
    if cursor:
        q["cursor"] = cursor
    body = get(q)
    ids = [t["id"] for t in body["threads"]]
    if not set(ids).isdisjoint(seen):
        print("false: page %d repeated a thread" % (pages + 1)); raise SystemExit
    seen += ids
    pages += 1
    cursor = body.get("nextCursor")
    if not cursor:
        break
if pages < 2:
    print("false: %d page(s), so the cursor was never exercised" % pages); raise SystemExit
# Paging must agree with the unpaged view. A cursor that drifts from the sort order
# shows up here as a thread on page 2 of the walk that sits at index 3 of the single
# page — exactly the failure an offset cursor makes when rows re-rank mid-walk.
whole = [t["id"] for t in get({"limit": "200"})["threads"]]
print("true" if whole == seen[: len(whole)] else "false: walk %s vs page %s" % (seen[:3], whole[:3]))
PY
)
check "a whole walk sees each thread once, in queue order" "true" "$WALK"

FILTERED=$(KEY="$KEY" BASE="$BASE" python3 - <<'PY'
import json, os, urllib.parse, urllib.request
base, key = os.environ["BASE"], os.environ["KEY"]
cursor, leaks, rows = None, 0, 0
while True:
    q = {"limit": "5", "awaitingReply": "true"}
    if cursor:
        q["cursor"] = cursor
    url = base + "/api/v1/threads?" + urllib.parse.urlencode(q)
    body = json.load(urllib.request.urlopen(urllib.request.Request(
        url, headers={"authorization": "Bearer " + key})))
    for t in body["threads"]:
        rows += 1
        if not t["awaitingReply"]:
            leaks += 1
    cursor = body.get("nextCursor")
    if not cursor:
        break
# The cursor's OR has to sit alongside the filter, not beside it: one misplaced AND
# and page 2 quietly fills with threads the filter had excluded.
print("true" if leaks == 0 else "false: %d of %d rows ignored the filter" % (leaks, rows))
PY
)
check "…and a filtered walk stays filtered" "true" "$FILTERED"

check "limit is clamped, not obeyed" "true" \
  "$(curl -s "${AUTH[@]}" "$BASE/api/v1/threads?limit=100000" \
    | python3 -c 'import json,sys;print((len(json.load(sys.stdin)["threads"]) <= 200))' | tr A-Z a-z)"
check "a forged cursor is refused, not restarted from page one" 422 \
  "$(curl -s -o /dev/null -w '%{http_code}' "${AUTH[@]}" "$BASE/api/v1/threads?cursor=MTAw")"
check "…with the code that says so" "invalid_cursor" \
  "$(curl -s "${AUTH[@]}" "$BASE/api/v1/threads?cursor=MTAw" \
    | python3 -c 'import json,sys;print(json.load(sys.stdin)["error"]["code"])')"
check "…and the parameter at fault" "cursor" \
  "$(curl -s "${AUTH[@]}" "$BASE/api/v1/threads?cursor=MTAw" \
    | python3 -c 'import json,sys;print(json.load(sys.stdin)["error"].get("param"))')"
check "the last page reports no further cursor" "true" \
  "$(curl -s "${AUTH[@]}" "$BASE/api/v1/threads?limit=200" \
    | python3 -c 'import json,sys;print((json.load(sys.stdin)["nextCursor"] is None))' | tr A-Z a-z)"
rm -f "$PAGE1" "$PAGE2"

echo
echo "--- the error envelope every consumer branches on ---"
check "no key reports authentication_error" "authentication_error" \
  "$(curl -s "$BASE/api/v1/threads" \
    | python3 -c 'import json,sys;print(json.load(sys.stdin)["error"]["code"])')"
check "a bad channel reports invalid_request" "invalid_request" \
  "$(curl -s "${JSON[@]}" "${AUTH[@]}" -X POST "$BASE/api/v1/messages" \
      -d '{"channel":"CARRIER_PIGEON","payload":{"text":"hi"}}' \
    | python3 -c 'import json,sys;print(json.load(sys.stdin)["error"]["code"])')"
check "…and points at the field that broke" "channel" \
  "$(curl -s "${JSON[@]}" "${AUTH[@]}" -X POST "$BASE/api/v1/messages" \
      -d '{"channel":"CARRIER_PIGEON","payload":{"text":"hi"}}' \
    | python3 -c 'import json,sys;print(json.load(sys.stdin)["error"]["param"])')"
check "a missing thread reports not_found" "not_found" \
  "$(curl -s "${AUTH[@]}" "$BASE/api/v1/threads/does-not-exist" \
    | python3 -c 'import json,sys;print(json.load(sys.stdin)["error"]["code"])')"
check "the handshake reports unknown_channel, with no key at all" "unknown_channel" \
  "$(curl -s "$BASE/api/v1/channels/pigeon/webhook" \
    | python3 -c 'import json,sys;print(json.load(sys.stdin)["error"]["code"])')"
check "no error body leaks a stack trace or an env name" "true" \
  "$(curl -s "${AUTH[@]}" "$BASE/api/v1/threads/does-not-exist" \
    | grep -qi 'stack\|DATABASE_URL\|prisma' && echo false || echo true)"

echo
echo "--- webhook endpoints can be managed, not only created ---"
HOOK=$(mktemp)
curl -s "${AUTH[@]}" "${JSON[@]}" -X POST "$BASE/api/v1/webhooks" \
  -d '{"url":"https://example.com/hook","events":["thread.hot"]}' -o "$HOOK"
HOOK_ID=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["endpoint"]["id"])' "$HOOK")
HOOK_SECRET=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["secret"])' "$HOOK")
check "subscribing returns an id and a once-only secret" "true" \
  "$([[ -n "$HOOK_ID" && "$HOOK_SECRET" == whsec_* ]] && echo true || echo false)"
DETAIL=$(curl -s "${AUTH[@]}" "$BASE/api/v1/webhooks/$HOOK_ID")
check "reading it back still describes the subscription" "thread.hot" \
  "$(printf '%s' "$DETAIL" | python3 -c 'import json,sys;print(json.load(sys.stdin)["endpoint"]["events"][0])')"
# The secret is the whole security story for a receiver. A GET that returned it would
# turn one leaked read token into forged deliveries forever.
check "…without handing the signing secret back out" "true" \
  "$(printf '%s' "$DETAIL" | grep -qF "$HOOK_SECRET" && echo false || echo true)"
check "silencing a subscription sticks" "False" \
  "$(curl -s "${AUTH[@]}" "${JSON[@]}" -X PATCH "$BASE/api/v1/webhooks/$HOOK_ID" -d '{"active":false}' \
    | python3 -c 'import json,sys;print(json.load(sys.stdin)["endpoint"]["active"])')"
check "PATCH applies the URL rule POST applies" 422 \
  "$(curl -s -o /dev/null -w '%{http_code}' "${AUTH[@]}" "${JSON[@]}" -X PATCH \
      "$BASE/api/v1/webhooks/$HOOK_ID" -d '{"url":"http://insecure.example.com/hook"}')"
check "PATCH applies the event rule POST applies" "events" \
  "$(curl -s "${AUTH[@]}" "${JSON[@]}" -X PATCH "$BASE/api/v1/webhooks/$HOOK_ID" \
      -d '{"events":["thread.exploded"]}' \
    | python3 -c 'import json,sys;print(json.load(sys.stdin)["error"]["param"])')"
check "an empty PATCH is refused, not a silent no-op" 422 \
  "$(curl -s -o /dev/null -w '%{http_code}' "${AUTH[@]}" "${JSON[@]}" -X PATCH \
      "$BASE/api/v1/webhooks/$HOOK_ID" -d '{}')"
check "unsubscribing works" "True" \
  "$(curl -s "${AUTH[@]}" -X DELETE "$BASE/api/v1/webhooks/$HOOK_ID" \
    | python3 -c 'import json,sys;print(json.load(sys.stdin)["deleted"])')"
check "…and the endpoint is really gone" 404 \
  "$(curl -s -o /dev/null -w '%{http_code}' "${AUTH[@]}" "$BASE/api/v1/webhooks/$HOOK_ID")"
check "deleting twice answers 404, not 500" "not_found" \
  "$(curl -s "${AUTH[@]}" -X DELETE "$BASE/api/v1/webhooks/$HOOK_ID" \
    | python3 -c 'import json,sys;print(json.load(sys.stdin)["error"]["code"])')"
rm -f "$HOOK"

echo
echo "--- the contract is served, not merely written down ---"
SPEC=$(mktemp)
check "liveness answers without a key" 200 \
  "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/health")"
check "…and reports the database up" "true" \
  "$(curl -s "$BASE/api/health" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(str(d.get("ok") is True and d.get("db")=="up").lower())')"
check "the spec is public, before anyone holds a key" 200 \
  "$(curl -s -o "$SPEC" -w '%{http_code}' "$BASE/api/v1/openapi")"
check "…as OpenAPI 3.1" "3.1.0" \
  "$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["openapi"])' "$SPEC")"
check "…carrying this build's version" "$(node -p "require('./package.json').version")" \
  "$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["info"]["version"])' "$SPEC")"
check "…describing both verbs on a thread" "true" \
  "$(python3 -c '
import json,sys
paths=json.load(open(sys.argv[1]))["paths"]
item={k.lower() for k in paths["/api/v1/threads/{id}"]}
print(str({"get","patch"} <= item).lower())' "$SPEC")"
check "…and every code the server can actually return" "true" \
  "$(python3 -c '
import json,sys
codes=set(json.load(open(sys.argv[1]))["components"]["schemas"]["Error"]["properties"]["error"]["properties"]["code"]["enum"])
print(str({"authentication_error","permission_error","rate_limit_error","invalid_request","invalid_cursor","unknown_channel","not_found","conflict","internal_error"} == codes).lower())' "$SPEC")"
check "…with no invented channel in it" "true" \
  "$(grep -q 'CARRIER_PIGEON' "$SPEC" && echo false || echo true)"
rm -f "$SPEC"

echo
echo "--- validation ---"
check "unknown channel rejected" 422 \
  "$(curl -s -o /dev/null -w '%{http_code}' "${AUTH[@]}" "${JSON[@]}" -X POST "$BASE/api/v1/messages" -d '{"channel":"CARRIER_PIGEON","payload":{"text":"hi"}}')"
check "missing body rejected" 422 \
  "$(curl -s -o /dev/null -w '%{http_code}' "${AUTH[@]}" "${JSON[@]}" -X POST "$BASE/api/v1/messages" -d '{"channel":"EMAIL","payload":{"from":"a@b.com"}}')"

echo
echo "--- pages render ---"
# The dashboard is no longer public: everything behind it belongs to whoever is
# signed in, so an anonymous visitor must be turned away rather than shown the
# demo queue.
check "triage page sends a stranger to login" 307 \
  "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/")"
check "…and the redirect lands on /login" "/login" \
  "$(curl -s -o /dev/null -w '%{redirect_url}' "$BASE/" | sed -e "s#^$BASE##")"
check "integrations page is gated too" 307 \
  "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/integrations")"
check "login page renders" 200 \
  "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/login")"
check "signup page renders" 200 \
  "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/signup")"

# --- signing in as the seeded owner ------------------------------------------
# Posts the login form exactly the way a browser without JavaScript does: read
# the page, replay the action slots the form was rendered with, and read the
# session cookie out of the response headers.
post_form() { # post_form <page> <field=value>...  -> response headers on stdout
  # AT_IP makes the form appear to come from a different address — the guessing
  # limits are keyed by address, so the suite has to be able to speak from more
  # than one — and AT_BODY keeps the rendered page instead of dropping it, which
  # is how a check reads the refusal a form answered with.
  local page="$1"; shift
  local html s0 s1 sk args f
  html=$(mktemp); s0=$(mktemp); s1=$(mktemp); sk=$(mktemp)
  curl -s "$BASE$page" > "$html"
  grep -o 'name="\$ACTION_1:0" value="[^"]*"' "$html" | sed -e 's/.*value="//' -e 's/"$//' -e 's/&quot;/"/g' > "$s0"
  grep -o 'name="\$ACTION_1:1" value="[^"]*"' "$html" | sed -e 's/.*value="//' -e 's/"$//' -e 's/&quot;/"/g' > "$s1"
  grep -o 'name="\$ACTION_KEY" value="[^"]*"' "$html" | sed -e 's/.*value="//' -e 's/"$//' > "$sk"
  args=(-s -D - -o "${AT_BODY:-/dev/null}" -X POST "$BASE$page" -H "Origin: $BASE"
    -H "X-Forwarded-For: ${AT_IP:-$SMOKE_IP}"
    -F '$ACTION_REF_1=' -F "\$ACTION_1:0=$(cat "$s0")" -F "\$ACTION_1:1=$(cat "$s1")" -F "\$ACTION_KEY=$(cat "$sk")")
  for f in "$@"; do args+=(-F "$f"); done
  curl "${args[@]}"
  rm -f "$html" "$s0" "$s1" "$sk"
}

session_from() { grep -i '^set-cookie: abetconnect_session=' "$1" | sed -e 's/.*abetconnect_session=//' -e 's/;.*//' | head -1; }

# The integrations page carries several server-action forms at once — one per key
# plus the create form — so an action slot cannot be guessed from the page any
# more. Each POST reads the slot out of the <form> that actually contains the
# field being submitted, which is the pairing a browser makes implicitly.
post_form_in() { # <page> <marker-field> <session> <field=value>... -> response body
  # AT_HEADERS, like AT_BODY above, is for the cases where the answer is in the
  # response headers rather than the page: accepting an invitation sets a new
  # session cookie and redirects, and the cookie is the proof it worked.
  local page="$1" marker="$2" session="$3"; shift 3
  local html body spec slot f
  html=$(mktemp); body=$(mktemp); spec=$(mktemp)
  curl -s "$BASE$page" -H "Cookie: abetconnect_session=$session" > "$html"
  python3 - "$html" "$marker" <<'PY' > "$spec"
import re
import sys

html = open(sys.argv[1]).read()
for block in re.findall(r"<form.*?</form>", html, re.S):
    if 'name="%s"' % sys.argv[2] not in block:
        continue
    slot = re.search(r"\$ACTION_(\d+):0", block).group(1)

    def part(name):
        pattern = r'name="\$ACTION_%s:%s" value="([^"]*)"' % (slot, name)
        return re.search(pattern, block).group(1).replace("&quot;", '"')

    key = re.search(r'name="\$ACTION_KEY" value="([^"]*)"', block).group(1)
    print(slot)
    print(part("0"))
    print(part("1"))
    print(key)
    break
PY
  mapfile -t SPEC < "$spec"
  slot="${SPEC[0]:-}"
  if [[ -z "$slot" ]]; then
    rm -f "$html" "$body" "$spec"
    return 1
  fi
  local args=(-s -o "$body" -w '%{http_code}' -D "${AT_HEADERS:-/dev/null}" -X POST "$BASE$page" -H "Origin: $BASE"
    -H "Cookie: abetconnect_session=$session"
    -F "\$ACTION_REF_$slot=" -F "\$ACTION_$slot:0=${SPEC[1]}"
    -F "\$ACTION_$slot:1=${SPEC[2]}" -F "\$ACTION_KEY=${SPEC[3]}")
  for f in "$@"; do args+=(-F "$f"); done
  curl "${args[@]}" > /dev/null
  cat "$body"
  rm -f "$html" "$body" "$spec"
}

HDR=$(mktemp)
post_form /login 'email=demo@abetconnect.dev' 'password=demo-password' > "$HDR"
check "the seeded owner can sign in" "HTTP/1.1 303 See Other" "$(head -1 "$HDR" | tr -d '\r')"
SESSION=$(session_from "$HDR")
check "signing in issues a session cookie" "true" "$([[ -n "$SESSION" ]] && echo true || echo false)"

QUEUE=$(curl -s "$BASE/" -H "Cookie: abetconnect_session=$SESSION")
check "signed-in owner sees the seeded lead" "true" "$(echo "$QUEUE" | grep -qi "Priya Raman" && echo true || echo false)"
check "…in their own workspace" "true" "$(echo "$QUEUE" | grep -qi "Acme Revenue Team" && echo true || echo false)"
check "integrations opens once signed in" 200 \
  "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/integrations" -H "Cookie: abetconnect_session=$SESSION")"

# --- a second tenant must not be able to see any of it ------------------------
post_form /signup 'name=Someone Elsewhere' 'workspace=Unrelated Co' \
  "email=smoke.$(date +%s)@other-tenant.test" 'password=smoke-pass-123' > "$HDR"
OTHER_SESSION=$(session_from "$HDR")
OTHER=$(curl -s "$BASE/" -H "Cookie: abetconnect_session=$OTHER_SESSION")
check "a fresh signup gets a private, empty workspace" "true" \
  "$(echo "$OTHER" | grep -qi "No conversations yet" && echo true || echo false)"
check "…and cannot see another tenant's lead" "false" \
  "$(echo "$OTHER" | grep -qi "Priya Raman" && echo true || echo false)"
check "…or another tenant's workspace" "false" \
  "$(echo "$OTHER" | grep -qi "Acme Revenue Team" && echo true || echo false)"
rm -f "$HDR"

# --- issuing an API key from the dashboard ------------------------------------
# Self-service is not a nicety: a customer running this on their own server has no
# way to run `npm run seed` for their workspace, so if the page cannot mint and
# revoke keys, nothing they sign up can ever send a message in.
echo
echo "--- api keys from the dashboard ---"
B_COOKIE="Cookie: abetconnect_session=$OTHER_SESSION"
B_PAGE=$(mktemp)
KEYID_FILE=$(mktemp)
curl -s "$BASE/integrations" -H "$B_COOKIE" > "$B_PAGE"
check "a brand new workspace starts with no keys" "true" \
  "$(grep -q 'No keys yet' "$B_PAGE" && echo true || echo false)"

CREATED=$(post_form_in /integrations name "$OTHER_SESSION" 'name=Smoke ingest')
NEWKEY=$(printf '%s' "$CREATED" | grep -o 'abc_live_[A-Za-z0-9_-]\{20,\}' | head -1)
check "the dashboard can issue a key" "true" \
  "$([[ -n "$NEWKEY" ]] && echo true || echo false)"
check "…and names it in the one-time reveal" "true" \
  "$(printf '%s' "$CREATED" | grep -q 'Smoke ingest' && echo true || echo false)"
check "the issued key authenticates" 200 \
  "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $NEWKEY" "$BASE/api/v1/threads")"
INGEST=$(curl -s -H "Authorization: Bearer $NEWKEY" -H 'Content-Type: application/json' -X POST \
  "$BASE/api/v1/messages" \
  -d '{"channel":"EMAIL","payload":{"from":"Cleo Vance <cleo@smoke-issue.test>","subject":"Ceiling on the current tool","text":"We are 30 reps and outgrowing what we have. What does 30 seats cost?"}}')
check "…and can ingest a message into its own workspace" "true" \
  "$(printf '%s' "$INGEST" | grep -q '"threadId"' && echo true || echo false)"
check "the ingested lead reaches that tenant's queue" "true" \
  "$(curl -s "$BASE/" -H "$B_COOKIE" | grep -qi 'Cleo Vance' && echo true || echo false)"

echo
echo "--- publishable website-form keys ---"
# The id is read out of the row for this key, so a mislabelled revoke button
# cannot pass unnoticed. Defined once, used by both key sections below.
key_id_in_row() { # key_id_in_row <html-file> <key-name>
  python3 - "$1" "$2" <<'PY'
import re
import sys

html = open(sys.argv[1]).read()
for row in re.findall(r"<li.*?</li>", html, re.S):
    if sys.argv[2] in row:
        found = re.search(r'name="id" value="(c[a-z0-9]+)"', row)
        if found:
            print(found.group(1))
PY
}
# The key that lives in browser code: minted with an origin allowlist, usable for
# WEBFORM posts and nothing else. Created and revoked inside this section so the
# key-count assertions further down still see the workspace they expect.
CREATED_PUB=$(post_form_in /integrations name "$OTHER_SESSION" 'name=Smoke website form' 'kind=PUBLISHABLE' 'origins=https://shop.example.com')
PUBKEY=$(printf '%s' "$CREATED_PUB" | grep -o 'abc_pub_[A-Za-z0-9_-]\{20,\}' | head -1)
check "the dashboard can issue a publishable key" "true" \
  "$([[ -n "$PUBKEY" ]] && echo true || echo false)"
PUBMAIL="visitor.$(date +%s)@smoke-shop.test"
PUB_INGEST=$(curl -s -w '\n%{http_code}' -H "Authorization: Bearer $PUBKEY" -H 'Content-Type: application/json' \
  -H "X-Forwarded-For: $SMOKE_IP" -X POST "$BASE/api/v1/messages" \
  -d "{\"channel\":\"WEBFORM\",\"payload\":{\"name\":\"Shop Visitor\",\"email\":\"$PUBMAIL\",\"message\":\"Do you offer annual billing for a team of twelve?\"}}")
check "…and it posts a web form (201)" "201" "$(printf '%s' "$PUB_INGEST" | tail -1)"
check "…into a scored thread" "true" \
  "$(printf '%s' "$PUB_INGEST" | head -n -1 | grep -q '"threadId"' && echo true || echo false)"
check "a publishable key cannot post another channel" "permission_error" \
  "$(curl -s -H "Authorization: Bearer $PUBKEY" -H 'Content-Type: application/json' -X POST "$BASE/api/v1/messages" \
    -d '{"channel":"EMAIL","payload":{"from":"x@y.test","text":"hi"}}' \
    | python3 -c 'import json,sys;print(json.load(sys.stdin)["error"]["code"])')"
check "…nor read the queue" "permission_error" \
  "$(curl -s -H "Authorization: Bearer $PUBKEY" "$BASE/api/v1/threads" \
    | python3 -c 'import json,sys;print(json.load(sys.stdin)["error"]["code"])')"
check "…and a foreign origin is refused" 403 \
  "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $PUBKEY" -H 'Content-Type: application/json' \
    -H 'Origin: https://evil.example.com' -H "X-Forwarded-For: $SMOKE_IP" -X POST "$BASE/api/v1/messages" \
    -d '{"channel":"WEBFORM","payload":{"name":"Evil Visitor","email":"evil@smoke-shop.test","message":"spam"}}')"
PUB_HDR=$(mktemp)
PUB_ORIGIN_BODY=$(curl -s -D "$PUB_HDR" -o /tmp/abet-pub-origin.json -w '%{http_code}' \
  -H "Authorization: Bearer $PUBKEY" -H 'Content-Type: application/json' \
  -H 'Origin: https://shop.example.com' -H "X-Forwarded-For: $SMOKE_IP" -X POST "$BASE/api/v1/messages" \
  -d '{"channel":"WEBFORM","payload":{"name":"Shop Visitor","email":"shopper@smoke-shop.test","message":"Is onboarding included in the annual plan?"}}')
check "…while the allowlisted origin posts (201)" "201" "$PUB_ORIGIN_BODY"
check "…and the response names that origin back" "true" \
  "$(grep -qi '^access-control-allow-origin: https://shop.example.com' "$PUB_HDR" && echo true || echo false)"
rm -f "$PUB_HDR"
check "a preflight is answered, not routed" 204 \
  "$(curl -s -o /dev/null -w '%{http_code}' -X OPTIONS "$BASE/api/v1/messages" -H 'Origin: https://shop.example.com')"
# --- the form budget is real, and it speaks the standard headers ---------------
# A fresh address (own bucket) posts exactly the quota, then one more.
RATE_IP="203.0.113.$((RANDOM % 250 + 1))"
RATE_STAMP=$(date +%s)
for i in $(seq 1 29); do
  curl -s -o /dev/null -H "Authorization: Bearer $PUBKEY" -H 'Content-Type: application/json' \
    -H "X-Forwarded-For: $RATE_IP" -X POST "$BASE/api/v1/messages" \
    -d "{\"channel\":\"WEBFORM\",\"payload\":{\"name\":\"Budget Visitor $i\",\"email\":\"budget$i.$RATE_STAMP@smoke-shop.test\",\"message\":\"Enquiry $i about annual billing for twelve seats.\"}}"
done
THIRTIETH=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $PUBKEY" \
  -H 'Content-Type: application/json' -H "X-Forwarded-For: $RATE_IP" -X POST "$BASE/api/v1/messages" \
  -d "{\"channel\":\"WEBFORM\",\"payload\":{\"name\":\"Budget Visitor 30\",\"email\":\"budget30.$RATE_STAMP@smoke-shop.test\",\"message\":\"Enquiry 30 about annual billing.\"}}")
check "thirty posts from one address all land" "201" "$THIRTIETH"
RATE_HDR=$(mktemp)
RATE_CODE=$(curl -s -D "$RATE_HDR" -o /tmp/abet-rate.json -w '%{http_code}' \
  -H "Authorization: Bearer $PUBKEY" -H 'Content-Type: application/json' -H "X-Forwarded-For: $RATE_IP" \
  -X POST "$BASE/api/v1/messages" \
  -d '{"channel":"WEBFORM","payload":{"name":"Budget Visitor 31","email":"budget31@smoke-shop.test","message":"One too many."}}')
check "…and the thirty-first is refused" 429 "$RATE_CODE"
check "…with a retry-after in seconds" "true" \
  "$(tr -d '\r' < "$RATE_HDR" | grep -qiE '^retry-after: [0-9]+$' && echo true || echo false)"
check "…an IETF ratelimit quota at zero remaining" "true" \
  "$(tr -d '\r' < "$RATE_HDR" | grep -qiE '^ratelimit: "form-ingest";r=0;t=[0-9]+$' && echo true || echo false)"
check "…and the policy behind it" "true" \
  "$(tr -d '\r' < "$RATE_HDR" | grep -qiE '^ratelimit-policy: "form-ingest";q=30;w=900$' && echo true || echo false)"
rm -f "$RATE_HDR"
curl -s "$BASE/integrations" -H "$B_COOKIE" > "$B_PAGE"
PUBID=$(key_id_in_row "$B_PAGE" 'Smoke website form')
check "the publishable key can be revoked from the dashboard" "true" \
  "$(post_form_in /integrations id "$OTHER_SESSION" "id=$PUBID" | grep -q 'Key revoked' && echo true || echo false)"
check "…and stops authenticating immediately" 401 \
  "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $PUBKEY" "$BASE/api/v1/threads")"

curl -s "$BASE/integrations" -H "$B_COOKIE" > "$B_PAGE"
check "the plaintext is never rendered a second time" "0" \
  "$(grep -c -F -e "$NEWKEY" "$B_PAGE")"
check "…the listing carries only the prefix" "true" \
  "$(grep -qF "${NEWKEY:0:13}" "$B_PAGE" && echo true || echo false)"

# The other tenant's key id is readable from its own page, so the row helper
# above is exercised against a second workspace too.
KEYID=$(key_id_in_row "$B_PAGE" 'Smoke ingest')
check "each key row carries the id its button submits" "true" \
  "$([[ -n "$KEYID" ]] && echo true || echo false)"
# The interesting failure mode. Key ids are ordinary cuids, so if revoke filtered
# on id alone, any tenant could switch off any other tenant's integrations by
# guessing one. The workspace filter has to be what stops it, and the refusal has
# to read the same either way so the form never becomes a way to enumerate ids.
# (This runs while the attacker still holds a key: the revoke form only exists on
# a page that lists at least one, and a form-less POST would prove nothing.)
post_form_in /integrations name "$OTHER_SESSION" 'name=Stand-in key' > /dev/null
curl -s "$BASE/integrations" -H "Cookie: abetconnect_session=$SESSION" > "$KEYID_FILE"
VICTIM=$(key_id_in_row "$KEYID_FILE" 'Seed key')
check "the other tenant's key id is readable from its own page" "true" \
  "$([[ -n "$VICTIM" ]] && echo true || echo false)"
INTRUDER=$(post_form_in /integrations id "$OTHER_SESSION" "id=$VICTIM")
check "one tenant cannot revoke another tenant's key" "true" \
  "$(printf '%s' "$INTRUDER" | grep -q 'not in your workspace' && echo true || echo false)"
check "…and the victim's key keeps working" 200 \
  "$(curl -s -o /dev/null -w '%{http_code}' "${AUTH[@]}" "$BASE/api/v1/threads")"

check "a key can be revoked from the dashboard" "true" \
  "$(post_form_in /integrations id "$OTHER_SESSION" "id=$KEYID" | grep -q 'Key revoked' && echo true || echo false)"
check "…and stops authenticating immediately" 401 \
  "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $NEWKEY" "$BASE/api/v1/threads")"
check "…and revoking it twice is refused rather than pretended" "true" \
  "$(post_form_in /integrations id "$OTHER_SESSION" "id=$KEYID" | grep -q 'not in your workspace' && echo true || echo false)"

check "an unnamed key is refused" "true" \
  "$(post_form_in /integrations name "$OTHER_SESSION" 'name=' | grep -q 'Give the key a name' && echo true || echo false)"
for _ in $(seq 1 12); do
  post_form_in /integrations name "$OTHER_SESSION" 'name=Flood key' > /dev/null
done
curl -s "$BASE/integrations" -H "$B_COOKIE" > "$B_PAGE"
# Counted by occurrence, not by line: the rendered list is a single minified line,
# so `grep -c` would report 1 however many keys are on it.
check "…the list stops at exactly ten live keys" "10" \
  "$(grep -o 'name="id"' "$B_PAGE" | wc -l | tr -d ' ')"
check "…and the eleventh is refused with the cap named" "true" \
  "$(post_form_in /integrations name "$OTHER_SESSION" 'name=One too many' | grep -q 'already has 10 active keys' && echo true || echo false)"
post_form_in /integrations name "" 'name=Anonymous gift' > /dev/null 2>&1
check "a signed-out visitor cannot mint a key at all" "false" \
  "$(curl -s "$BASE/integrations" -H "$B_COOKIE" | grep -q 'Anonymous gift' && echo true || echo false)"
rm -f "$B_PAGE" "$KEYID_FILE"

# --- guessing limits ----------------------------------------------------------
# scrypt makes each guess cost about 100ms of server time, which protects nothing:
# 100ms is what an attacker pays per attempt, not what they are limited to. These
# checks are the point where "slow" becomes "stopped" — and the address, not the
# account, is what gets stopped, so a stranger cannot use this form to lock a
# customer out of their own workspace.
# --- inviting a teammate, over the same wire a browser uses --------------------
# Three roles have been in the schema since the first migration and the guard above
# honours them, but until invitations existed nothing could *produce* an ADMIN or a
# MEMBER: signup only ever makes an OWNER, so demonstrating the difference meant
# editing rows in a database console. Everything below is the difference between a
# permission that reads correctly and one that has been watched refusing somebody.
echo
echo "--- team invitations ---"
TEAM_IP="198.51.100.$((RANDOM % 251 + 1)).$((RANDOM % 251 + 1))"
check "the team page opens for an owner" 200 \
  "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/members" -H "$B_COOKIE")"
check "…and is shut to a stranger" "true" \
  "$([[ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/members")" == 3* ]] && echo true || echo false)"
check "an invented invitation link is answered, not thrown" 200 \
  "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/invite/0123456789abcdef0123456789abcdef01234567")"

MEMBER_MAIL="mate.$(date +%s)@other-tenant.test"
INVITED=$(post_form_in /members email "$OTHER_SESSION" "email=$MEMBER_MAIL" 'role=MEMBER')
LINK=$(printf '%s' "$INVITED" | grep -o '/invite/[A-Za-z0-9_-]\{30,\}' | head -1)
check "an owner can issue an invitation from the page" "true" \
  "$([[ -n "$LINK" ]] && echo true || echo false)"
check "…naming the address it was sent to" "true" \
  "$(printf '%s' "$INVITED" | grep -q "$MEMBER_MAIL" && echo true || echo false)"
check "…and it waits on the pending list until used" "true" \
  "$(curl -s "$BASE/members" -H "$B_COOKIE" | grep -q "$MEMBER_MAIL" && echo true || echo false)"

MHDR=$(mktemp)
AT_IP="$TEAM_IP" post_form /signup 'name=Team Mate' 'workspace=Mate Own Co' \
  "email=$MEMBER_MAIL" 'password=smoke-pass-123' > "$MHDR"
MATE=$(session_from "$MHDR")
check "the invited address can sign up afterwards" "true" \
  "$([[ -n "$MATE" ]] && echo true || echo false)"
check "…into a workspace of their own first" "true" \
  "$(curl -s "$BASE/" -H "Cookie: abetconnect_session=$MATE" | grep -q 'Mate Own Co' && echo true || echo false)"
check "the link then offers them the seat" "true" \
  "$(curl -s "$BASE$LINK" -H "Cookie: abetconnect_session=$MATE" | grep -q 'Join this workspace' && echo true || echo false)"

AHDR=$(mktemp)
AT_HEADERS="$AHDR" post_form_in "$LINK" accept "$MATE" 'accept=1' > /dev/null
MATE2=$(session_from "$AHDR")
check "accepting issues a session for the invited workspace" "true" \
  "$([[ -n "$MATE2" && "$MATE2" != "$MATE" ]] && echo true || echo false)"
check "…and the dashboard is now the inviter's" "true" \
  "$(curl -s "$BASE/" -H "Cookie: abetconnect_session=$MATE2" | grep -q 'Unrelated Co' && echo true || echo false)"
check "…where they are listed as a member" "true" \
  "$(curl -s "$BASE/members" -H "Cookie: abetconnect_session=$MATE2" | grep -q 'Team Mate' && echo true || echo false)"
check "a member is not offered the invite form" "false" \
  "$(curl -s "$BASE/members" -H "Cookie: abetconnect_session=$MATE2" | grep -q 'Invite someone' && echo true || echo false)"
check "…nor the pending list" "false" \
  "$(curl -s "$BASE/members" -H "Cookie: abetconnect_session=$MATE2" | grep -q 'Outstanding invitations' && echo true || echo false)"
check "…nor the team's API keys" "false" \
  "$(curl -s "$BASE/integrations" -H "Cookie: abetconnect_session=$MATE2" | grep -q 'Smoke ingest' && echo true || echo false)"
check "the spent link is refused to the next person" "true" \
  "$(curl -s "$BASE$LINK" | grep -q 'already been used' && echo true || echo false)"

# The same path granting more, and the rule about who may grant it.
LEAD_MAIL="lead.$(date +%s)@other-tenant.test"
AINVITED=$(post_form_in /members email "$OTHER_SESSION" "email=$LEAD_MAIL" 'role=ADMIN')
ALINK=$(printf '%s' "$AINVITED" | grep -o '/invite/[A-Za-z0-9_-]\{30,\}' | head -1)
check "an owner can issue an admin invitation" "true" \
  "$([[ -n "$ALINK" ]] && echo true || echo false)"
LHDR=$(mktemp)
AT_IP="$TEAM_IP" post_form /signup 'name=Team Lead' 'workspace=Lead Own Co' \
  "email=$LEAD_MAIL" 'password=smoke-pass-123' > "$LHDR"
LEAD=$(session_from "$LHDR")
LAHDR=$(mktemp)
AT_HEADERS="$LAHDR" post_form_in "$ALINK" accept "$LEAD" 'accept=1' > /dev/null
LEAD2=$(session_from "$LAHDR")
check "the admin is on the team" "true" \
  "$(curl -s "$BASE/members" -H "Cookie: abetconnect_session=$LEAD2" | grep -q 'Team Lead' && echo true || echo false)"
check "an admin is offered the invite form" "true" \
  "$(curl -s "$BASE/members" -H "Cookie: abetconnect_session=$LEAD2" | grep -q 'Invite someone' && echo true || echo false)"
check "…but is offered no way to make another admin" "false" \
  "$(curl -s "$BASE/members" -H "Cookie: abetconnect_session=$LEAD2" | grep -q '>Admin</option>' && echo true || echo false)"
check "an admin can mint an API key" "true" \
  "$(post_form_in /integrations name "$LEAD2" 'name=Lead minted this' | grep -q 'abc_live_' && echo true || echo false)"
check "…and invite an ordinary member" "true" \
  "$(post_form_in /members email "$LEAD2" "email=fourth.$(date +%s)@other-tenant.test" 'role=MEMBER' | grep -q '/invite/' && echo true || echo false)"
check "…but cannot create another admin" "true" \
  "$(post_form_in /members email "$LEAD2" "email=third.$(date +%s)@other-tenant.test" 'role=ADMIN' | grep -q 'Only an owner can grant admin access' && echo true || echo false)"

# Taking access back, which is the half an invitation cannot do. The seat id comes
# out of the row naming Team Lead rather than out of whichever row is first, because
# the rendered page is one long line of markup.
SEAT=$(curl -s "$BASE/members" -H "$B_COOKIE" | python3 -c '
import re, sys
html = sys.stdin.read()
at = html.find("Team Lead")
match = re.search(r"name=\"membership\" value=\"([^\"]+)\"", html[at:]) if at >= 0 else None
print(match.group(1) if match else "")
')
check "the owner can find the admin's seat" "true" "$([[ -n "$SEAT" ]] && echo true || echo false)"
check "…and demote them from the page" "true" \
  "$(post_form_in /members membership "$OTHER_SESSION" "membership=$SEAT" 'role=MEMBER' | grep -q 'is now a member' && echo true || echo false)"
check "the demotion holds on their very next request" "false" \
  "$(curl -s "$BASE/members" -H "Cookie: abetconnect_session=$LEAD2" | grep -q 'Invite someone' && echo true || echo false)"
check "…and takes their sight of the keys with it" "false" \
  "$(curl -s "$BASE/integrations" -H "Cookie: abetconnect_session=$LEAD2" | grep -q 'Lead minted this' && echo true || echo false)"
check "the owner can take the seat away entirely" "true" \
  "$(post_form_in /members membership "$OTHER_SESSION" "membership=$SEAT" 'role=REMOVE' | grep -q 'no longer has access' && echo true || echo false)"
check "…which ends the cookie minted in that workspace" "true" \
  "$([[ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/members" -H "Cookie: abetconnect_session=$LEAD2")" == 3* ]] && echo true || echo false)"
check "…and they are gone from the team list" "false" \
  "$(curl -s "$BASE/members" -H "$B_COOKIE" | grep -q 'Team Lead' && echo true || echo false)"
rm -f "$MHDR" "$AHDR" "$LHDR" "$LAHDR"

echo
echo "--- failed sign-in limits ---"
ATTACK="198.51.$((RANDOM % 250 + 1)).$((RANDOM % 250 + 1))"
NEIGHBOUR="198.51.$((RANDOM % 250 + 1)).$((RANDOM % 250 + 1))"
GUARD=$(mktemp); GUARD_HDR=$(mktemp)
identical=0
for _ in $(seq 1 9); do
  AT_IP="$ATTACK" AT_BODY="$GUARD" post_form /login \
    'email=demo@abetconnect.dev' 'password=not-the-password' > /dev/null
  grep -q 'Email or password is incorrect.' "$GUARD" || identical=$((identical + 1))
done
check "nine wrong guesses are all refused the same way" "0" "$identical"
AT_IP="$ATTACK" AT_BODY="$GUARD" post_form /login \
  'email=demo@abetconnect.dev' 'password=not-the-password' > /dev/null
check "…the tenth says this address is out of attempts" "true" \
  "$(grep -q '10 failed attempts' "$GUARD" && echo true || echo false)"
AT_IP="$ATTACK" AT_BODY="$GUARD" post_form /login \
  'email=demo@abetconnect.dev' 'password=demo-password' > "$GUARD_HDR"
check "…a spent address is refused even the right password" "" "$(session_from "$GUARD_HDR")"
check "…and is told how long to wait rather than left guessing" "true" \
  "$(grep -q 'Too many attempts from here' "$GUARD" && echo true || echo false)"
NEIGHBOUR_HDR=$(mktemp)
AT_IP="$NEIGHBOUR" post_form /login 'email=demo@abetconnect.dev' 'password=demo-password' > "$NEIGHBOUR_HDR"
check "…while the next address still signs straight in" "true" \
  "$([[ -n "$(session_from "$NEIGHBOUR_HDR")" ]] && echo true || echo false)"

# Account farming, since a public signup form is also a way to occupy slugs and
# fill a database. Failures deliberately do not count here: typing an email that
# already exists is what an honest second person in the same office does.
FARM="203.0.113.$((RANDOM % 250 + 1))"
MISTYPE="203.0.113.$((RANDOM % 250 + 1))"
created=0
for i in $(seq 1 5); do
  FARM_HDR=$(mktemp)
  AT_IP="$FARM" post_form /signup "name=Farmer $i" "workspace=Farm $i Co" \
    "email=farm$i.$RANDOM@rl.test" 'password=farm-password-123' > "$FARM_HDR"
  [[ -n "$(session_from "$FARM_HDR")" ]] && created=$((created + 1))
  rm -f "$FARM_HDR"
done
check "five workspaces can be signed up from one address" "5" "$created"
AT_IP="$FARM" AT_BODY="$GUARD" post_form /signup 'name=Farmer Six' 'workspace=Farm Six Co' \
  "email=farmsix.$RANDOM@rl.test" 'password=farm-password-123' > /dev/null
check "…the sixth from that address is refused" "true" \
  "$(grep -q 'Too many attempts from here' "$GUARD" && echo true || echo false)"
for _ in $(seq 1 6); do
  AT_IP="$MISTYPE" post_form /signup 'name=Demo Person' 'workspace=Unused Co' \
    'email=demo@abetconnect.dev' 'password=demo-password' > /dev/null
done
MISTYPE_HDR=$(mktemp)
AT_IP="$MISTYPE" post_form /signup 'name=Legit Person' 'workspace=Legit Co' \
  "email=legit.$RANDOM@rl.test" 'password=legit-password-123' > "$MISTYPE_HDR"
check "mistyping a taken email six times costs the next person nothing" "true" \
  "$([[ -n "$(session_from "$MISTYPE_HDR")" ]] && echo true || echo false)"
rm -f "$GUARD" "$GUARD_HDR" "$NEIGHBOUR_HDR" "$MISTYPE_HDR"

# --- response hardening -------------------------------------------------------
# The dashboard is a page full of other people's customer records sitting behind a
# session cookie, so it must not be embeddable, not be sniffable into another type,
# and not hand its URLs to whoever a user clicks through to.
echo
echo "--- response headers ---"
HEADERS=$(mktemp)
curl -sI "$BASE/login" > "$HEADERS"
check "the dashboard cannot be framed" "true" \
  "$(grep -qi '^x-frame-options: deny' "$HEADERS" && echo true || echo false)"
check "…and the modern directive agrees with it" "true" \
  "$(grep -qiE "content-security-policy: frame-ancestors .none." "$HEADERS" && echo true || echo false)"
check "no response is offered as a guessable content type" "true" \
  "$(grep -qi '^x-content-type-options: nosniff' "$HEADERS" && echo true || echo false)"
check "workspace slugs are not leaked to referral targets" "true" \
  "$(grep -qi '^referrer-policy: same-origin' "$HEADERS" && echo true || echo false)"
curl -sI "$BASE/api/v1/threads" > "$HEADERS"
check "the API carries the same protection" "true" \
  "$(grep -qi '^x-frame-options: deny' "$HEADERS" && echo true || echo false)"

# A production build marks the session cookie Secure, which is the right call and
# has a consequence worth a test: serving the built app over plain http on a LAN
# address gives a browser a cookie it will refuse to send back, so logins appear
# to do nothing. HTTPS at the proxy, or `npm run dev` for local work.
COOKIE_HDR=$(mktemp)
post_form /login 'email=demo@abetconnect.dev' 'password=demo-password' > "$COOKIE_HDR"
check "the session cookie will not travel over plain http" "true" \
  "$(grep -qi 'abetconnect_session=[^;]*;.*secure' "$COOKIE_HDR" && echo true || echo false)"
check "…and stays unreadable to scripts" "true" \
  "$(grep -qi 'abetconnect_session=[^;]*;.*httponly' "$COOKIE_HDR" && echo true || echo false)"
rm -f "$HEADERS" "$COOKIE_HDR"

echo
echo "================================"
echo "  $PASS passed, $FAIL failed"
echo "================================"
[[ "$FAIL" -eq 0 ]]
