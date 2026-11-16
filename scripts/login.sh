#!/usr/bin/env bash
# Perch login helper.
#
# The official CLI hands the browser to Supabase and expects the callback on
# 127.0.0.1. On a headless box that loopback is the server's, not your laptop's,
# so the callback has to be tunnelled. This wrapper does not reimplement OAuth —
# scripts/login.mjs already speaks PKCE — it just sets up the two things that
# break on a remote host: the port forward and the post-login steps that are easy
# to forget (plan selection and a liveness call).
#
#   ./scripts/login.sh                 # login into accounts/<label>.json
#   ./scripts/login.sh --label acc2
#   ./scripts/login.sh --dry-run       # print what it would do
#
# After the browser lands on http://127.0.0.1:<port>/callback?code=… login.mjs
# captures it. If the browser runs on another machine, forward that port first:
#
#   ssh -L 45871:127.0.0.1:45871 wx
set -euo pipefail

LABEL="main"
PORT="45871"
DRY_RUN="0"
NODE_BIN="${NODE_BIN:-node}"

while [ $# -gt 0 ]; do
  case "$1" in
    --label) LABEL="${2:?--label needs a value}"; shift 2 ;;
    --port) PORT="${2:?--port needs a value}"; shift 2 ;;
    --dry-run) DRY_RUN="1"; shift ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

OUT="accounts/${LABEL}.json"
echo "label        : ${LABEL}"
echo "session file : ${OUT}"
echo "callback port: ${PORT} (forward it: ssh -L ${PORT}:127.0.0.1:${PORT} <this-host>)"
echo "node         : ${NODE_BIN}"
echo

if [ "${DRY_RUN}" = "1" ]; then
  echo "[dry-run] would run:"
  echo "  ${NODE_BIN} scripts/login.mjs --out ${OUT} --port ${PORT} --no-open"
  echo "  ${NODE_BIN} scripts/verify-version.mjs --offline"
  echo "  ${NODE_BIN} -e \"import('./src/session.mjs').then(async ({SessionStore}) => { const s = SessionStore.discover(); await s.reload(); const { slot } = s.pick(); console.log(await s.healPlan(slot)); })\""
  echo "  ${NODE_BIN} scripts/probe-ladder.mjs --dry-run"
  exit 0
fi

echo "[1/4] OAuth (PKCE) — open the printed URL on any device"
"${NODE_BIN}" scripts/login.mjs --out "${OUT}" --port "${PORT}" --no-open

echo
echo "[2/4] version check"
"${NODE_BIN}" scripts/verify-version.mjs --offline || true

echo
echo "[3/4] plan self-heal (an account with planCode=null answers 403 to everything)"
"${NODE_BIN}" -e "
import('./src/session.mjs').then(async ({ SessionStore }) => {
  const store = SessionStore.discover();
  await store.reload();
  const { slot, release } = store.pick();
  try {
    const info = await store.accountInfo(slot, { force: true });
    console.log('  account   :', info.email ?? '-');
    console.log('  planCode  :', info.planCode ?? '(null)');
    console.log('  tiersReq  :', info.tierSelectionRequired);
    console.log('  blocked   :', info.blockedReason ?? '-');
    if (!info.planCode) console.log('  heal      :', JSON.stringify(await store.healPlan(slot)));
  } finally { release(); }
}).catch((e) => { console.error('  account check failed:', e.message); process.exitCode = 0; });
"

echo
echo "[4/4] next step: run the gate ladder for real"
echo "  ${NODE_BIN} scripts/probe-ladder.mjs"
echo
echo "The ladder refuses to run against a banned account and stops on the first 403."
