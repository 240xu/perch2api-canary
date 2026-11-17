#!/usr/bin/env node
/**
 * End-to-end replay: the full gateway path, with no account and no internet.
 *
 * `smoke.mjs` walks the same endpoints but needs a live account, so on a banned
 * box it proves nothing past `/health`. `stage-smoke.sh` only covers the surfaces
 * that fail *without* an account. Neither one ever exercises the middle of the
 * request: pick a session -> refresh a token -> fetch a turn ticket -> POST the
 * body -> parse SSE -> aggregate -> translate to OpenAI -> record in the eventbus.
 *
 * This harness does, by pointing PERCH_APP_URL at `replay-upstream.mjs`. The
 * upstream is scripted, so a failure here is our bug rather than Perch's mood,
 * and the recorded request bodies are checked against the shapes the official CLI
 * capture showed.
 *
 *   node scripts/e2e-replay.mjs                 # run everything, print a summary
 *   node scripts/e2e-replay.mjs --keep          # leave the temp profile behind
 *   node scripts/e2e-replay.mjs --only stream   # run cases whose name matches
 *
 * Exit code is 0 only when every case passes.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const arg = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const KEEP = flag('keep');
const ONLY = arg('only', null);
const SCRIPT_DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(SCRIPT_DIR, '..');
const NODE = process.execPath;

// ---------------------------------------------------------------- utilities

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(url, { timeoutMs = 30_000, expect = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (expect === null || res.status === expect) return res;
      lastError = new Error(`HTTP ${res.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${url}: ${lastError?.message ?? 'no response'}`);
}

let failures = 0;
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures += 1;
  return ok;
}
const skip = (name, why) => {
  results.push({ name, ok: null, detail: why });
  console.log(`SKIP  ${name}  ${why}`);
};

// ---------------------------------------------------------------- lifecycle

const profileDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'perch-e2e-'));
const sessionFile = path.join(profileDir, 'cli-auth-session.json');
const recordFile = path.join(profileDir, 'recorded.jsonl');

// A session the gateway can read but which points at nothing real. The access
// token is already expired on purpose: the first call has to go through the
// refresh path, otherwise that half of the code never runs either.
await fsp.writeFile(sessionFile, `${JSON.stringify({
  version: 1,
  appUrl: null, // filled in below, once the recorder port is known
  accessToken: 'replay-stale-access-token',
  refreshToken: 'replay-refresh-token',
  expiresAt: Math.floor(Date.now() / 1000) - 600,
  userId: 'replay-user',
  email: 'replay@example.test',
  updatedAt: new Date().toISOString(),
}, null, 2)}\n`, { mode: 0o600 });

const recorderPort = await freePort();
const apiPort = await freePort();
const panelPort = await freePort();
const recorderUrl = `http://127.0.0.1:${recorderPort}`;
const apiBase = `http://127.0.0.1:${apiPort}`;
const panelBase = `http://127.0.0.1:${panelPort}`;
const API_KEY = 'replay-api-key';

// The session's appUrl is what the gateway will use, so it has to be the recorder.
const session = JSON.parse(await fsp.readFile(sessionFile, 'utf8'));
session.appUrl = recorderUrl;
await fsp.writeFile(sessionFile, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });

const children = [];
function shutdown() {
  for (const { child, fd } of children) {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
    try { fs.closeSync(fd); } catch { /* already closed */ }
  }
  children.length = 0;
}

process.on('exit', shutdown);
process.on('SIGINT', () => { shutdown(); process.exit(130); });

const recorderLogPath = path.join(profileDir, 'recorder.log');
const gatewayLogPath = path.join(profileDir, 'gateway.log');

function spawnLogged(command, commandArgs, { env, logPath, label }) {
  const out = fs.openSync(logPath, 'w');
  const child = spawn(command, commandArgs, {
    cwd: ROOT,
    env,
    stdio: ['ignore', out, out],
  });
  children.push({ child, fd: out });
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) console.log(`  (${label} exited with ${code}; see ${logPath})`);
  });
  return child;
}

try {
  spawnLogged(NODE, [path.join(SCRIPT_DIR, 'replay-upstream.mjs'), '--port', String(recorderPort), '--record', recordFile, '--quiet'], {
    env: { ...process.env },
    logPath: recorderLogPath,
    label: 'recorder',
  });

  spawnLogged(NODE, [path.join(ROOT, 'src/server.mjs')], {
    env: {
      ...process.env,
      HOME: profileDir, // no ~/.perch, so only the replay session can be discovered
      PORT: String(apiPort),
      HOST: '127.0.0.1',
      PERCH_PANEL_PORT: String(panelPort),
      PERCH_PANEL: '1',
      PERCH2API_KEY: API_KEY,
      PERCH_APP_URL: recorderUrl,
      PERCH_SESSION_FILES: sessionFile,
      PERCH_CLI_AUTH_DIR: profileDir,
      PERCH_PROMPT_MODE: 'canary',
      PERCH_LANE: 'chat',
      PERCH_TICKET_MODE: 'required', // force the ticket half of the path
      PERCH_MIN_INTERVAL_MS: '0',    // pacing is tested elsewhere; here it is dead time
      PERCH_BREAKER_THRESHOLD: '50', // we deliberately provoke failures below
      PERCH_BAN_CHECK: 'true',
      PERCH_MAX_RETRIES: '2',
      PERCH_HEARTBEAT_MS: '0',
      PERCH_LOCALE: 'en',
      PERCH_DEBUG_WIRE: '0',
    },
    logPath: gatewayLogPath,
    label: 'gateway',
  });

  await waitFor(`${recorderUrl}/__ready`, { timeoutMs: 15_000 });
  const healthRes = await waitFor(`${apiBase}/health`, { timeoutMs: 40_000 });
  const health = await healthRes.json();

  // ---------------------------------------------------------------- helpers

  const api = (route, init = {}) => fetch(`${apiBase}${route}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`,
      ...(init.headers || {}),
    },
    signal: AbortSignal.timeout(60_000),
  });

  const panel = (route) => fetch(`${panelBase}${route}${route.includes('?') ? '&' : '?'}k=${API_KEY}`, {
    signal: AbortSignal.timeout(20_000),
  });

  async function setScenario(name) {
    const res = await fetch(`${recorderUrl}/__scenario`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario: name }),
    });
    if (!res.ok) throw new Error(`scenario switch failed: HTTP ${res.status}`);
  }

  async function resetRecorder() {
    await fetch(`${recorderUrl}/__reset`, { method: 'POST' });
  }

  async function record() {
    const res = await fetch(`${recorderUrl}/__record`);
    return res.json();
  }

  /**
   * Everything the recorder has ever seen, read off disk.
   *
   * `__reset` clears the in-memory list so a single case can assert on just its
   * own requests, but some facts (a token refresh, a ticket fetched once and then
   * cached for its TTL) happen exactly once per process and must be asserted
   * cumulatively.
   */
  async function recordHistory() {
    const raw = await fsp.readFile(recordFile, 'utf8').catch(() => '');
    return raw.split('\n').filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  }

  async function chat(payload) {
    const res = await api('/v1/chat/completions', { method: 'POST', body: JSON.stringify(payload) });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* stream or empty */ }
    return { status: res.status, text, json };
  }

  const wants = (name) => !ONLY || name.includes(ONLY);

  // ---------------------------------------------------------------- cases

  if (wants('health')) {
    check('health', health.ok === true && health.sessions === 1,
      `ok=${health.ok} sessions=${health.sessions} prompt=${health.promptMode}/${health.envelopeMode}`);
    check('health reports the replayed upstream', health.upstream === recorderUrl, health.upstream);
    check('health reports the forced ticket policy', health.ticketMode === 'required', health.ticketMode);
  }

  if (wants('panel-auth')) {
    const noKey = await fetch(`${panelBase}/`);
    const badKey = await fetch(`${panelBase}/?k=wrong`);
    const goodKey = await panel('/');
    check('panel page refuses an unauthenticated request', noKey.status === 401, `HTTP ${noKey.status}`);
    check('panel page refuses a wrong key', badKey.status === 401, `HTTP ${badKey.status}`);
    check('panel page serves with the key', goodKey.status === 200, `HTTP ${goodKey.status}`);
  }

  if (wants('models')) {
    const res = await api('/v1/models');
    const body = await res.json().catch(() => null);
    const ids = (body?.data || []).map((m) => m.id);
    check('models list', res.status === 200 && ids.length > 0, `${ids.length} models: ${ids.slice(0, 5).join(', ')}`);
  }

  if (wants('nonstream')) {
    await setScenario('ok');
    await resetRecorder();
    const { status, json } = await chat({
      model: 'perch',
      messages: [{ role: 'user', content: 'Reply with exactly: PONG' }],
      max_tokens: 64,
    });
    const content = json?.choices?.[0]?.message?.content ?? '';
    check('non-stream completion', status === 200 && content === 'PONG', `HTTP ${status} content=${JSON.stringify(content)}`);
    check('non-stream reports the served model', json?.perch?.model === 'perch-replay-v1', String(json?.perch?.model));
    check('non-stream usage is translated', json?.usage?.prompt_tokens === 42 && json?.usage?.completion_tokens === 3,
      `prompt=${json?.usage?.prompt_tokens} completion=${json?.usage?.completion_tokens}`);
    check('non-stream cache-read tokens survive', json?.usage?.prompt_tokens_details?.cached_tokens === 16,
      String(json?.usage?.prompt_tokens_details?.cached_tokens));
    check('non-stream finish_reason', json?.choices?.[0]?.finish_reason === 'stop', String(json?.choices?.[0]?.finish_reason));
  }

  if (wants('stream')) {
    await setScenario('ok');
    const res = await api('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: 'perch',
        messages: [{ role: 'user', content: 'Reply with exactly: PONG' }],
        max_tokens: 64,
        stream: true,
        stream_options: { include_usage: true },
      }),
    });
    const text = await res.text();
    const frames = text.split('\n').filter((l) => l.startsWith('data: '));
    const parsed = frames
      .filter((l) => !l.includes('[DONE]'))
      .map((l) => { try { return JSON.parse(l.slice(6)); } catch { return null; } })
      .filter(Boolean);
    const content = parsed.map((f) => f.choices?.[0]?.delta?.content ?? '').join('');
    const usageChunk = parsed.find((f) => f.usage);
    const finished = parsed.find((f) => f.choices?.[0]?.finish_reason);
    check('stream completes', res.status === 200 && text.includes('data: [DONE]'), `HTTP ${res.status} frames=${frames.length}`);
    check('stream text reassembles', content === 'PONG', JSON.stringify(content));
    check('stream emits a role chunk first', parsed[0]?.choices?.[0]?.delta?.role === 'assistant');
    check('stream finish_reason is stop', finished?.choices?.[0]?.finish_reason === 'stop', String(finished?.choices?.[0]?.finish_reason));
    check('stream usage chunk', usageChunk?.usage?.prompt_tokens === 42, JSON.stringify(usageChunk?.usage ?? null));
  }

  if (wants('tool')) {
    await setScenario('tool');
    const { status, json } = await chat({
      model: 'perch',
      messages: [{ role: 'user', content: 'What is the weather in Jakarta?' }],
      max_tokens: 200,
      tools: [{
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get the current weather for a city.',
          parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
        },
      }],
    });
    const call = (json?.choices?.[0]?.message?.tool_calls || [])[0];
    check('tool call round trip', status === 200 && call?.function?.name === 'get_weather',
      `HTTP ${status} name=${call?.function?.name ?? 'none'}`);
    check('tool arguments are a JSON string', (() => {
      try { return JSON.parse(call.function.arguments).city === 'Jakarta'; } catch { return false; }
    })(), String(call?.function?.arguments));
    check('tool finish_reason', json?.choices?.[0]?.finish_reason === 'tool_calls', String(json?.choices?.[0]?.finish_reason));
  }

  if (wants('restart')) {
    // The shape observed upstream: text, a tool-call fragment, then a restart that
    // abandons the tool call. `done.text` agrees with what was sent, so the turn is
    // still good and the abandoned tool call must not be reported.
    await setScenario('restart');
    const { status, json } = await chat({
      model: 'perch',
      messages: [{ role: 'user', content: 'Reply with exactly: PONG' }],
      max_tokens: 64,
    });
    const choice = json?.choices?.[0];
    check('a mid-tool-call restart drops the tool call, not the text',
      status === 200 && choice?.message?.content === 'PONG' && !choice?.message?.tool_calls,
      `HTTP ${status} content=${JSON.stringify(choice?.message?.content)} toolCalls=${(choice?.message?.tool_calls || []).length}`);
    check('and it still finishes as a normal stop', choice?.finish_reason === 'stop', String(choice?.finish_reason));
  }

  if (wants('restart-conflict')) {
    // Streaming cannot retract. If the final text contradicts the prefix the
    // client already rendered, reporting `stop` would be a silent corruption.
    await setScenario('restart-conflict');
    const res = await api('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: 'perch',
        messages: [{ role: 'user', content: 'Reply with exactly: PONG' }],
        max_tokens: 64,
        stream: true,
      }),
    });
    const text = await res.text();
    const parsed = text.split('\n').filter((l) => l.startsWith('data: '))
      .filter((l) => !l.includes('[DONE]'))
      .map((l) => { try { return JSON.parse(l.slice(6)); } catch { return null; } })
      .filter(Boolean);
    const errFrame = parsed.find((f) => f.error);
    const finishFrame = parsed.find((f) => f.choices?.[0]?.finish_reason);
    check('a contradictory restart is surfaced, not announced as a normal finish',
      errFrame?.error?.code === 'stream_restart_conflict' && !finishFrame,
      `code=${errFrame?.error?.code ?? 'none'} finish=${finishFrame?.choices?.[0]?.finish_reason ?? 'none'}`);
  }

  if (wants('truncated')) {
    await setScenario('truncated');
    const { status, json } = await chat({
      model: 'perch',
      messages: [{ role: 'user', content: 'Reply with exactly: PONG' }],
      max_tokens: 64,
    });
    check('a stream with no done frame is an error', status === 502 && json?.error?.code === 'incomplete_stream',
      `HTTP ${status} code=${json?.error?.code}`);
  }

  if (wants('faildone')) {
    await setScenario('faildone');
    const { status, json } = await chat({
      model: 'perch',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 64,
    });
    check('done.ok=false surfaces as an upstream failure', status === 502 && json?.error?.code === 'model_call_failed',
      `HTTP ${status} code=${json?.error?.code}`);
  }

  if (wants('retry')) {
    await setScenario('retry503');
    await resetRecorder();
    const { status, json } = await chat({
      model: 'perch',
      messages: [{ role: 'user', content: 'Reply with exactly: PONG' }],
      max_tokens: 64,
    });
    const recs = await record();
    const attempts = recs.requests.filter((r) => r.path === '/api/perch-terminal/model-call').length;
    check('a 503 is retried, not surfaced', status === 200 && json?.choices?.[0]?.message?.content === 'PONG',
      `HTTP ${status} content=${JSON.stringify(json?.choices?.[0]?.message?.content)}`);
    check('the retry actually hit the upstream twice', attempts === 2, `${attempts} attempt(s)`);
  }

  if (wants('rate429')) {
    await setScenario('rate429');
    const { status, json } = await chat({
      model: 'perch',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 16,
    });
    check('429 is terminal and attributed', status === 429 && json?.error?.code === 'rate_limited',
      `HTTP ${status} code=${json?.error?.code}`);
  }

  if (wants('surface403')) {
    await setScenario('surface403');
    const { status, json } = await chat({
      model: 'perch',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 16,
    });
    check('a surface 403 is classified, not called a ban',
      status === 403 && /surface/i.test(String(json?.error?.code ?? '')),
      `HTTP ${status} code=${json?.error?.code}`);

    // The whole point of the classification: a surface problem is recoverable, so
    // the account must still be usable afterwards.
    await setScenario('ok');
    const after = await chat({
      model: 'perch',
      messages: [{ role: 'user', content: 'Reply with exactly: PONG' }],
      max_tokens: 64,
    });
    check('the account survives a surface 403', after.status === 200,
      `HTTP ${after.status} code=${after.json?.error?.code ?? '-'}`);
  }

  if (wants('plan403')) {
    await setScenario('plan403');
    const { status, json } = await chat({
      model: 'perch',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 16,
    });
    check('a plan 403 is classified', status === 403 && /plan/i.test(String(json?.error?.code ?? '')),
      `HTTP ${status} code=${json?.error?.code}`);
    await setScenario('ok');
  }

  if (wants('body')) {
    // The request the gateway actually sent, as opposed to one built in-process by
    // `inspect-body`. Everything below is what the official capture showed.
    await setScenario('ok');
    await resetRecorder();
    await chat({
      model: 'perch',
      messages: [{ role: 'user', content: 'Reply with exactly: PONG' }],
      max_tokens: 64,
    });
    const recs = await record();
    const sent = recs.requests.find((r) => r.path === '/api/perch-terminal/model-call' && r.body);
    const body = sent?.body ?? {};
    const req = body.request ?? {};
    const topKeys = Object.keys(body);
    const reqKeys = Object.keys(req);
    const system = (req.messages || []).find((m) => m.role === 'system');

    check('the wire body was captured', Boolean(sent), sent ? `${sent.bytes} bytes` : 'none');
    check('top-level key count matches the 2.4.134 envelope', topKeys.length === 9, `${topKeys.length}: ${topKeys.join(',')}`);
    // The official CLI omits `tools` entirely when the caller supplied none
    // (verified against v134-x-ask-noeff: request keys are messages/temperature/
    // maxTokens, three of them). Sending an empty array would be a deviation.
    check('request omits tools when the caller sent none',
      reqKeys.length === 3 && reqKeys.every((k) => ['messages', 'temperature', 'maxTokens'].includes(k)),
      reqKeys.join(','));
    check('no lane/stop/reasoning leaked into request',
      !('lane' in req) && !('stop' in req) && !('reasoning' in req));
    check('the system message is the 275-char gate paragraph', system?.content?.length === 275,
      `${system?.content?.length ?? 0} chars`);
    check('attribution is present and names the CLI surface',
      body.attribution?.source === 'cli' && Boolean(body.attribution?.runId),
      `source=${body.attribution?.source} runId=${body.attribution?.runId ? 'set' : 'missing'}`);
    check('resendAfterOutput is a boolean', typeof body.resendAfterOutput === 'boolean', String(body.resendAfterOutput));
    check('preferredModelId is null', body.preferredModelId === null, String(body.preferredModelId));
  }

  if (wants('ticket')) {
    await setScenario('ok');
    await chat({
      model: 'perch',
      messages: [{ role: 'user', content: 'Reply with exactly: PONG' }],
      max_tokens: 64,
    });
    // Read the whole history: the ticket is cached for its TTL, so it is fetched
    // once early and reused. Resetting first would find nothing and call a working
    // cache a missing ticket.
    const history = await recordHistory();
    const ticketReq = history.find((r) => r.path === '/api/perch-terminal/turn-ticket');
    const call = history.filter((r) => r.path === '/api/perch-terminal/model-call' && r.ticket).pop();
    check('turn-ticket is requested from the gateway', Boolean(ticketReq),
      ticketReq?.body ? `surface=${ticketReq.body.surface} client=${ticketReq.body.ticketClient}` : 'none');
    check('a fetched ticket is attached to the model call',
      Boolean(call?.ticket) && /^replay-ticket-/.test(call.ticket), call?.ticket ?? 'missing');
    check('the ticket run id is adopted', Boolean(ticketReq?.body), JSON.stringify(ticketReq?.body ?? null));
  }

  if (wants('token')) {
    const history = await recordHistory();
    const refresh = history.filter((r) => r.path === '/auth/v1/token');
    const stored = JSON.parse(await fsp.readFile(sessionFile, 'utf8').catch(() => '{}'));
    check('an expired session is refreshed instead of refused', refresh.length >= 1, `${refresh.length} refresh(es)`);
    check('the refreshed token is written back to the session file',
      String(stored.accessToken || '').startsWith('replay-access-'),
      String(stored.accessToken || '').slice(0, 20));
    check('the refreshed expiry is in the future',
      (stored.expiresAt ?? 0) > Math.floor(Date.now() / 1000),
      `expiresAt=${stored.expiresAt}`);
  }

  if (wants('eventbus')) {
    const res = await panel('/api/requests?limit=100');
    const body = await res.json().catch(() => null);
    const rows = body?.data || [];
    const codes = new Set(rows.map((r) => r.code));
    check('the eventbus recorded every request', rows.length >= 5, `${rows.length} rows`);
    check('recorded rows carry status and code', rows.every((r) => typeof r.status === 'number' && r.code),
      `codes=${[...codes].slice(0, 8).join(',')}`);
    const okRow = rows.find((r) => r.status === 200);
    check('a 200 row records the wire size and system length',
      (okRow?.bodyBytes ?? 0) > 500 && okRow?.sysLen === 275,
      `bodyBytes=${okRow?.bodyBytes} sysLen=${okRow?.sysLen}`);

    const envRes = await panel('/api/envelopes');
    const envBody = await envRes.json().catch(() => null);
    const fingerprints = Object.keys(envBody?.data || {});
    check('outcomes are attributed to an envelope fingerprint', fingerprints.length >= 1, fingerprints.join(','));

    const evRes = await panel('/api/events?limit=50');
    const evBody = await evRes.json().catch(() => null);
    check('events were emitted', (evBody?.data || []).length >= 1, `${(evBody?.data || []).length} events`);
  }

  if (wants('matrix')) {
    const res = await panel('/api/matrix');
    const preview = await fetch(`${panelBase}/api/matrix?k=${API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dry: true, modes: ['canary'], envelopes: ['magpie'], lanes: ['chat'] }),
    });
    const body = await preview.json().catch(() => null);
    check('matrix preview works without an upstream call',
      preview.status === 200 && body?.planned === 1 && body?.cells?.[0]?.sysLen === 275,
      `HTTP ${preview.status} planned=${body?.planned}`);
    void res;
  }

  if (wants('banned')) {
    // Last, because `banned` is terminal: the store refuses to reuse the slot, and
    // every later case would fail for the wrong reason.
    await setScenario('banned403');
    await resetRecorder();
    const first = await chat({
      model: 'perch',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 16,
    });
    check('a banned 403 is classified as a ban (not a surface problem)',
      first.status === 403 && first.json?.error?.code === 'banned',
      `HTTP ${first.status} code=${first.json?.error?.code}`);

    const before = (await record()).requests.filter((r) => r.path === '/api/perch-terminal/model-call').length;
    const second = await chat({
      model: 'perch',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 16,
    });
    const after = (await record()).requests.filter((r) => r.path === '/api/perch-terminal/model-call').length;
    check('a banned account is refused without another upstream call',
      second.status === 403 && after === before,
      `HTTP ${second.status} upstream calls ${before} -> ${after}`);

    const st = await (await panel('/api/state')).json().catch(() => null);
    const slot = (st?.sessions || [])[0];
    check('the panel shows the account as banned', slot?.state === 'banned', String(slot?.state));
  }

  // ---------------------------------------------------------------- logs

  if (failures > 0) {
    const recLog = await fsp.readFile(recorderLogPath, 'utf8').catch(() => '');
    const gwLog = await fsp.readFile(gatewayLogPath, 'utf8').catch(() => '');
    const unmodelled = recLog.split('\n').filter((l) => l.includes('UNMODELLED'));
    if (unmodelled.length) {
      console.log('\nupstream saw requests this recorder does not model:');
      for (const line of unmodelled) console.log(`  ${line}`);
    }
    const warn = gwLog.split('\n').filter((l) => /error|refus|fail/i.test(l)).slice(0, 12);
    if (warn.length) {
      console.log('\ngateway log lines worth reading:');
      for (const line of warn) console.log(`  ${line}`);
    }
  }
} catch (error) {
  console.log(`\nharness aborted: ${error.message}`);
  failures += 1;
} finally {
  const summary = results.reduce((acc, r) => {
    if (r.ok === true) acc.pass += 1;
    else if (r.ok === false) acc.fail += 1;
    else acc.skip += 1;
    return acc;
  }, { pass: 0, fail: 0, skip: 0 });

  console.log(`\n${summary.pass} passed, ${summary.fail} failed, ${summary.skip} skipped`);

  // Always stop the children: a live child keeps this process's event loop alive,
  // so skipping teardown would make --keep hang instead of returning.
  shutdown();
  await sleep(250);

  if (KEEP) {
    console.log(`profile kept at ${profileDir}`);
  } else {
    await fsp.rm(profileDir, { recursive: true, force: true }).catch(() => {});
  }

  process.exitCode = failures === 0 ? 0 : 1;
}
