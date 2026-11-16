#!/usr/bin/env bash
# Staging smoke test for the rebuilt gateway.
#
# Boots the process on a throwaway port pair, exercises every surface the plan
# claims works without an account, then stops it. Nothing here talks to a live
# account on purpose: the session on this box is banned, which is exactly the
# state the guards are supposed to handle.
set -u
NODE_BIN="${NODE_BIN:-node}"
cd "$(dirname "$0")" || exit 1

PORT=8805 PERCH_PANEL_PORT=8806 \
  ${NODE_BIN:-node} ${PERCH_NODE_ARGS:-} src/server.mjs \
  > stage.log 2>&1 &
PID=$!
sleep 12

K=$(sed -n 's/^PERCH2API_KEY=//p' .env)
API="http://127.0.0.1:8805"
PANEL="http://127.0.0.1:8806"
AUTH="Authorization: Bearer $K"

echo '=== 1) /health ==='
curl -s -m 8 -o health.json -w 'http=%{http_code}\n' "$API/health"
python3 -c "import json;d=json.load(open('health.json'));print({k:d[k] for k in ('ok','promptMode','lane','ticketMode','envelopeMode','breaker','sessions')})"

echo
echo '=== 2) chat completion against the banned account (expect a fast 403) ==='
curl -s -m 20 -o chat.json -w 'http=%{http_code} time=%{time_total}s\n' \
  -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"model":"perch","messages":[{"role":"user","content":"ping"}]}' \
  "$API/v1/chat/completions"
python3 -c "import json;d=json.load(open('chat.json'));print(d.get('error'))"

echo
echo '=== 3) panel HTML ==='
curl -s -m 8 -o page.html -w 'http=%{http_code} bytes=%{size_download}\n' "$PANEL/"
for tab in overview flow events switches diag redline; do
  grep -q "data-tab=\"$tab\"" page.html && echo "  tab ok   $tab" || echo "  tab MISS $tab"
done

echo
echo '=== 4) panel auth ==='
curl -s -m 8 -o /dev/null -w '  no key   -> %{http_code} (expect 401)\n' "$PANEL/api/state"
curl -s -m 8 -o /dev/null -w '  with key -> %{http_code} (expect 200)\n' "$PANEL/api/state?k=$K"

echo
echo '=== 5) inspect (no request sent) ==='
curl -s -m 10 -H "Authorization: Bearer $K" -H 'Content-Type: application/json' \
  -d '{"mode":"canary-scrub","lane":"chat","model":"perch","callerSystem":"You are opencode, an AI coding agent."}' \
  "$PANEL/api/inspect" > inspect.json
python3 -c "
import json
d = json.load(open('inspect.json'))
for k in ('promptMode','injectedChars','systemCount','systemLengths','roles','topLevelKeyCount','laneInsideRequest','hasResendAfterOutput','hasStop','preferredModelId'):
    print(f'  {k:22} {d.get(k)}')
print('  topLevelKeys          ', d.get('topLevelKeys'))
print('  scrub                 ', d.get('scrub'))
"

echo
echo '=== 6) runtime switch round-trip ==='
curl -s -m 8 -X PUT -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"key":"minIntervalMs","value":1500}' "$PANEL/api/config" > sw.json
cat sw.json; echo
curl -s -m 8 "$PANEL/api/config?k=$K" | python3 -c "import sys,json;d=json.load(sys.stdin);print('  effective minIntervalMs =',d['values']['minIntervalMs']);print('  runtime.json           =',d['overrides'])"
curl -s -m 8 -X PUT -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"key":"minIntervalMs","value":1000}' "$PANEL/api/config" > /dev/null

echo
echo '=== 7) envelopes + events + flow ==='
curl -s -m 8 "$PANEL/api/envelopes?k=$K" | python3 -c "import sys,json;print('  envelopes:',json.load(sys.stdin)['data'])"
curl -s -m 8 "$PANEL/api/events?limit=20&k=$K" | python3 -c "
import sys,json
for e in json.load(sys.stdin)['data']:
    print('  ', e['level'], e.get('code'), '|', e.get('message'))"
curl -s -m 8 "$PANEL/api/requests?limit=20&k=$K" | python3 -c "
import sys,json
d=json.load(sys.stdin)['data']
print('  requests recorded:', len(d))
for r in d:
    print('  ', r['status'], r.get('code'), r.get('promptMode'), r.get('envelope'), '|', (r.get('message') or '')[:60])"

echo
echo '=== 8) pause / resume ==='
curl -s -m 8 -X POST "$PANEL/api/pause?k=$K" > /dev/null
curl -s -m 8 "$PANEL/api/state?k=$K" | python3 -c "import sys,json;print('  paused =',json.load(sys.stdin)['paused'])"
curl -s -m 8 -X POST "$PANEL/api/resume?k=$K" > /dev/null
curl -s -m 8 "$PANEL/api/state?k=$K" | python3 -c "import sys,json;print('  paused =',json.load(sys.stdin)['paused'])"

echo
echo '=== 9) version self-check ==='
${NODE_BIN:-node} scripts/verify-version.mjs --offline 2>&1 | sed 's/^/  /'

kill "$PID" 2>/dev/null
wait "$PID" 2>/dev/null
echo
echo '--- stopped'
