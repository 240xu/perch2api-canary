#!/usr/bin/env bash
# Offline test for the circuit breaker.
#
# Points the upstream at a closed port so every call fails locally: no traffic
# leaves the box, and nothing is sent to Perch. Six calls should trip the breaker
# at five, and the sixth must be refused without touching the network.
set -u
NODE_BIN="${NODE_BIN:-node}"
cd "$(dirname "$0")/.." || exit 1

cat > fake-session.json <<'JSON'
{"version":1,"appUrl":"http://127.0.0.1:9","accessToken":"fake-token-for-breaker-test",
 "refreshToken":null,"expiresAt":4102444800,"userId":"breaker-test","email":"breaker@test"}
JSON

mkdir -p .fakehome

PORT=8807 PERCH_PANEL_PORT=8808 \
  HOME="$PWD/.fakehome" \
  PERCH_SESSION_FILES="$PWD/fake-session.json" \
  PERCH_APP_URL=http://127.0.0.1:9 \
  PERCH_BAN_CHECK=0 \
  PERCH_TICKET_MODE=off \
  PERCH_MIN_INTERVAL_MS=0 \
  PERCH_MAX_RETRIES=0 \
  PERCH_BREAKER_THRESHOLD=5 \
  PERCH2API_KEY=testkey \
  ${NODE_BIN:-node} src/server.mjs > breaker.log 2>&1 &
PID=$!
sleep 6

AUTH='Authorization: Bearer testkey'
for i in 1 2 3 4 5 6 7; do
  code=$(curl -s -m 15 -o resp.json -w '%{http_code}' -H "$AUTH" -H 'Content-Type: application/json' \
    -d '{"model":"perch","messages":[{"role":"user","content":"ping"}]}' \
    http://127.0.0.1:8807/v1/chat/completions)
  err=$(python3 -c "import json;print((json.load(open('resp.json')).get('error') or {}).get('code'))" 2>/dev/null)
  echo "  call $i -> http=$code code=$err"
done

echo
echo 'state:'
curl -s -m 8 "http://127.0.0.1:8808/api/state?k=testkey" | python3 -c "
import sys,json;d=json.load(sys.stdin)
print('  breakerOpen         =', d['breakerOpen'])
print('  consecutiveFailures =', d['consecutiveFailures'], '/', d['breakerThreshold'])
print('  requests recorded   =', d['stats']['total'])
print('  by status           =', {k:d['stats'][k] for k in ('ok','http401','http403','http429','http5xx','other')})"

echo
echo 'resume, then one more call should reach the network again'
curl -s -m 8 -X POST "http://127.0.0.1:8808/api/resume?k=testkey" > /dev/null
code=$(curl -s -m 15 -o resp.json -w '%{http_code}' -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"model":"perch","messages":[{"role":"user","content":"ping"}]}' \
  http://127.0.0.1:8807/v1/chat/completions)
err=$(python3 -c "import json;print((json.load(open('resp.json')).get('error') or {}).get('code'))" 2>/dev/null)
echo "  after resume -> http=$code code=$err"

kill "$PID" 2>/dev/null
wait "$PID" 2>/dev/null
rm -rf fake-session.json .fakehome
echo '--- stopped'
