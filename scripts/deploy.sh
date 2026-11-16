#!/usr/bin/env bash
# Deploy the rebuilt perch2api from a staging directory into /opt/perch2api.
#
# Assumes the caller already made /opt/perch2api.bak-<ts> and
# /root/perch2api.service.bak-<ts>. Refuses to leave the service down: if the new
# build fails its health check it restores the previous source tree and restarts.
set -euo pipefail

SRC="${1:?usage: deploy.sh <staging-dir>}"
DEST=/opt/perch2api
UNIT=/etc/systemd/system/perch2api.service
TS=$(date +%Y%m%dT%H%M%S)

log() { printf '\n== %s\n' "$*"; }

log "0) preflight"
[ -d "$SRC/src" ] || { echo "no src/ in $SRC"; exit 2; }
for f in "$SRC"/src/*.mjs; do ${NODE_BIN:-node} --check "$f" || exit 3; done
${NODE_BIN:-node} --check "$SRC/scripts/inspect-body.mjs"
echo "syntax ok"

log "1) copy sources into place"
cp -f "$SRC"/src/*.mjs "$DEST"/src/
cp -f "$SRC"/src/model-aliases.json "$DEST"/src/ 2>/dev/null || true
cp -f "$SRC"/scripts/inspect-body.mjs "$SRC"/scripts/verify-version.mjs "$SRC"/scripts/probe-ladder.mjs "$DEST"/scripts/
cp -f "$SRC"/scripts/login.sh "$DEST"/scripts/
chmod +x "$DEST"/scripts/login.sh
mkdir -p "$DEST/logs"

log "2) prompt assets"
[ -f "$SRC/.perch-prompt-agents.txt" ] && cp -f "$SRC/.perch-prompt-agents.txt" "$DEST/.perch-prompt-agents.txt"
[ -f "$DEST/.perch-prefix.txt" ] || cp -f "$SRC/.perch-prefix.txt" "$DEST/.perch-prefix.txt"
ls -l "$DEST/.perch-prefix.txt" "$DEST/.perch-prompt-agents.txt"

log "3) runtime.json (must exist before restart so ReadWritePaths can bind it)"
[ -f "$DEST/runtime.json" ] || printf '{}\n' > "$DEST/runtime.json"
chmod 600 "$DEST/runtime.json"

log "4) .env merge"
python3 - "$DEST/.env" <<'PY'
import sys, re, os
path = sys.argv[1]
desired = {
    'PERCH_PROMPT_MODE': 'canary',
    'PERCH_TICKET_MODE': 'off',
    'PERCH_ENVELOPE_MODE': 'honeypot',
    'PERCH_MAX_CONCURRENCY': '1',
    'PERCH_MIN_INTERVAL_MS': '1000',
    'PERCH_BREAKER_THRESHOLD': '5',
    'PERCH_BAN_CHECK': '1',
    'PERCH_USAGE_PREFLIGHT': '1',
    'PERCH_TURN_CONTEXT': '1',
    'PERCH_SCRUB_IDENTITY': '1',
    'PERCH_PANEL': '1',
    'PERCH_PANEL_PORT': '8802',
    'PERCH_RUNTIME_FILE': '/opt/perch2api/runtime.json',
}
text = open(path).read()
lines = [l for l in text.splitlines() if l.strip()]
out, seen = [], set()
for line in lines:
    m = re.match(r'^([A-Z0-9_]+)\s*=', line)
    key = m.group(1) if m else None
    if key in desired:
        out.append(f'{key}={desired[key]}')
        seen.add(key)
    else:
        out.append(line)
for key, value in desired.items():
    if key not in seen and key.strip() == key:
        out.append(f'{key}={value}')
open(path, 'w').write('\n'.join(out) + '\n')
print('\n'.join(l for l in out if re.match(r'^PERCH_(PROMPT_MODE|TICKET_MODE|ENVELOPE_MODE|MAX_CONCURRENCY|MIN_INTERVAL_MS|BREAKER_THRESHOLD|PANEL|RUNTIME_FILE|BAN_CHECK)', l)))
PY

log "5) systemd unit: allow runtime.json to be written"
if ! grep -q 'ReadWritePaths=.*runtime.json' "$UNIT"; then
  sudo cp -f "$UNIT" "/root/perch2api.service.bak-$TS"
  sudo sed -i 's|^ReadWritePaths=/opt/perch2api/accounts$|ReadWritePaths=/opt/perch2api/accounts /opt/perch2api/runtime.json|' "$UNIT"
  sudo systemctl daemon-reload
  echo "unit patched (backup /root/perch2api.service.bak-$TS)"
fi
grep -n ReadWritePaths "$UNIT"

log "6) restart"
sudo systemctl restart perch2api
sleep 6
if ! curl -sf -m 8 http://127.0.0.1:8801/health > /tmp/perch-health.json; then
  echo "HEALTH CHECK FAILED — rolling the source tree back"
  PREV=$(ls -d /opt/perch2api.bak-* 2>/dev/null | tail -1)
  if [ -n "$PREV" ]; then
    cp -a "$PREV"/src/. "$DEST"/src/
    sudo systemctl restart perch2api
    sleep 5
  fi
  journalctl -u perch2api -n 40 --no-pager
  exit 4
fi
cat /tmp/perch-health.json; echo

log "7) panel"
K=$(sed -n 's/^PERCH2API_KEY=//p' "$DEST/.env")
curl -s -m 8 -o /dev/null -w '  panel no-key  -> %{http_code}\n' http://127.0.0.1:8802/api/state
curl -s -m 8 -o /dev/null -w '  panel with-key-> %{http_code}\n' "http://127.0.0.1:8802/api/state?k=$K"

log "8) log"
journalctl -u perch2api -n 25 --no-pager | tail -25

echo
echo "deployed. backup: /opt/perch2api.bak-* ; unit: /root/perch2api.service.bak-$TS"
