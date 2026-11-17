#!/usr/bin/env node
/**
 * A scripted stand-in for app.perchai.app.
 *
 * The gateway has never been exercised end to end: every real completion needs an
 * account, and the account on this box is banned, so `smoke.mjs` cannot get past
 * the first call and `stage-smoke.sh` only touches the surfaces that fail without
 * one. That leaves session -> guard -> ticket -> SSE parse -> OpenAI translation ->
 * eventbus untested as a *path*, even though each piece has been tested alone.
 *
 * This process is the other end of that path. It answers the six endpoints the
 * gateway actually calls, records every request body it receives, and synthesises
 * SSE streams in the frame dialect the parser expects. Point PERCH_APP_URL at it
 * and the whole path runs without an account and without a single packet leaving
 * the machine.
 *
 *   node scripts/replay-upstream.mjs --port 8810 --record logs/replay.jsonl
 *
 * Control plane (only used by the harness):
 *   POST /__scenario {"scenario":"ok"}   switch what model-call does next
 *   POST /__reset                        forget recorded requests
 *   GET  /__record                       dump recorded requests as JSON
 *   GET  /__ready                        readiness probe
 *
 * Scenarios: ok | tool | restart | truncated | faildone | banned403 | surface403 |
 *            plan403 | rate429 | retry503 | slow | empty
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

const args = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const PORT = Number.parseInt(arg('port', '8810'), 10);
const HOST = arg('host', '127.0.0.1');
const RECORD_FILE = arg('record', null);
const QUIET = args.includes('--quiet');
const VERBOSE = args.includes('--verbose');

const log = (...parts) => { if (!QUIET) console.log('[upstream]', ...parts); };

// Which scripted outcome the next model-call produces. The harness flips this
// between cases so one recorder process serves the whole run.
let scenario = arg('scenario', 'ok');
// Counts model-call attempts, so `retry503` can fail exactly once.
let modelCallAttempts = 0;
let ticketSerial = 0;

/** Every request the gateway made, in order. The harness asserts against this. */
const recorded = [];

function remember(entry) {
  recorded.push(entry);
  if (RECORD_FILE) {
    // Append-only so a crashed harness still leaves evidence on disk.
    try {
      fs.appendFileSync(RECORD_FILE, `${JSON.stringify(entry)}\n`);
    } catch { /* recording must never break the response */ }
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let json = null;
      try { json = JSON.parse(raw); } catch { /* not json */ }
      resolve({ raw, json });
    });
    req.on('error', () => resolve({ raw: '', json: null }));
  });
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sseHeaders(res, extra = {}) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    ...extra,
  });
}

const frame = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

/** The stream body each scenario produces, as a list of timed frames. */
function scriptFrames(name) {
  const answer = [
    { type: 'answer_delta', text: 'PONG' },
  ];
  // `model` is echoed because the gateway promises to report what upstream
  // actually served, not what the caller asked for. A replay that omits it cannot
  // prove that promise.
  const done = (extra = {}) => ({
    type: 'done', ok: true, text: 'PONG', finishReason: 'stop',
    model: 'perch-replay-v1',
    usage: { inputTokens: 42, outputTokens: 3, cacheReadInputTokens: 16 },
    ...extra,
  });

  switch (name) {
    case 'ok':
      return { frames: answer, done: done() };
    case 'restart':
      // The shape actually observed upstream (RE-FINDINGS): text, then a tool-call
      // fragment, then `stream_restart` with reason mid_tool_call_failover, then a
      // `done` whose text is unchanged and whose toolCalls are empty. The text the
      // client already has is still correct, so this must NOT be reported as an
      // error; only the abandoned tool call is dropped.
      return {
        frames: [
          { type: 'answer_delta', text: 'PONG' },
          { type: 'tool_call_delta', toolCalls: [{ function: { name: 'get_weather', arguments: '{"city":"' }, id: 'call_cut' }] },
          { type: 'tool_use_end', toolCalls: [{ function: { name: 'get_weather', arguments: '{"city":"' }, id: 'call_cut' }] },
          { type: 'stream_restart', reason: 'mid_tool_call_failover' },
        ],
        done: done({ toolCalls: [] }),
      };
    case 'restart-conflict':
      // The same frame where the final text does *not* agree with what was already
      // rendered. Streaming cannot retract, so the turn must not claim success.
      return {
        frames: [
          { type: 'answer_delta', text: 'WRONG' },
          { type: 'stream_restart', reason: 'mid_tool_call_failover' },
          { type: 'answer_delta', text: 'PONG' },
        ],
        done: done(),
      };
    case 'tool':
      return {
        frames: [
          { type: 'answer_delta', text: 'Checking.' },
          {
            type: 'tool_use_end',
            toolCalls: [{
              function: { name: 'get_weather', arguments: '{"city":"Jakarta"}' },
              id: 'call_replay_1',
            }],
          },
        ],
        done: done({
          text: 'Checking.', finishReason: 'tool_use',
          toolCalls: [{ function: { name: 'get_weather', arguments: '{"city":"Jakarta"}' }, id: 'call_replay_1' }],
          usage: { inputTokens: 88, outputTokens: 12 },
        }),
      };
    case 'slow':
      return {
        frames: answer,
        done: done(),
        firstFrameDelayMs: 2500,
      };
    case 'truncated':
      // Content then EOF with no `done`. The parser must call this incomplete
      // rather than silently reporting a half answer as a finished turn.
      return { frames: answer, done: null };
    case 'empty':
      return { frames: [], done: null };
    case 'faildone':
      return {
        frames: [],
        done: { type: 'done', ok: false, error: 'provider exploded', errorCode: 'model_call_failed' },
      };
    default:
      return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function handleModelCall(req, res) {
  const { raw, json: body } = await readBody(req);
  modelCallAttempts += 1;

  remember({
    at: new Date().toISOString(),
    path: '/api/perch-terminal/model-call',
    scenario,
    attempt: modelCallAttempts,
    bytes: Buffer.byteLength(raw),
    ticket: req.headers['x-perch-turn-ticket'] ?? null,
    userAgent: req.headers['user-agent'] ?? null,
    callDelta: req.headers['x-perch-call-delta'] ?? null,
    body,
  });

  if (scenario === 'retry503' && modelCallAttempts === 1) {
    json(res, 503, { error: 'upstream hiccup', errorCode: 'unavailable' });
    return;
  }
  if (scenario === 'banned403') {
    json(res, 403, { ok: false, error: 'Account banned', errorCode: 'banned' });
    return;
  }
  if (scenario === 'surface403') {
    json(res, 403, {
      ok: false, error: 'Send the official CLI surface', errorCode: 'perch_surface_required',
    });
    return;
  }
  if (scenario === 'plan403') {
    json(res, 403, { ok: false, error: 'plan_required: pick a tier', errorCode: 'plan_required' });
    return;
  }
  if (scenario === 'rate429') {
    json(res, 429, { ok: false, error: 'slow down', errorCode: 'rate_limited', limit: 20 });
    return;
  }

  // `retry503` fails exactly once; the retry that follows must succeed, otherwise
  // the case proves only that failures stay failures.
  const script = scriptFrames(scenario === 'retry503' ? 'ok' : scenario);
  if (!script) {
    json(res, 500, { error: `recorder has no script for "${scenario}"` });
    return;
  }

  sseHeaders(res, {
    'x-perch-call-delta': '1',
    'x-perch-call-held-length': '0',
    'x-perch-call-held-digest': 'replay',
    'x-perch-call-held-tools': '0',
  });

  if (script.firstFrameDelayMs) await sleep(script.firstFrameDelayMs);
  for (const f of script.frames) {
    res.write(frame(f));
    await sleep(5);
  }
  if (script.done) res.write(frame(script.done));
  res.end();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const route = url.pathname.replace(/\/+$/, '') || '/';

  // ---- control plane ------------------------------------------------------
  if (route === '/__ready') { json(res, 200, { ready: true, scenario }); return; }
  if (route === '/__record' && req.method === 'GET') {
    json(res, 200, { count: recorded.length, requests: recorded });
    return;
  }
  if (route === '/__reset' && req.method === 'POST') {
    recorded.length = 0;
    modelCallAttempts = 0;
    json(res, 200, { ok: true });
    return;
  }
  if (route === '/__scenario' && req.method === 'POST') {
    const { json: body } = await readBody(req);
    if (body?.scenario) scenario = String(body.scenario);
    if (body?.reset !== false) modelCallAttempts = 0;
    if (VERBOSE) log(`scenario -> ${scenario}`);
    json(res, 200, { ok: true, scenario });
    return;
  }

  // ---- endpoints the gateway calls ----------------------------------------
  if (route === '/api/perch-terminal/cli-auth/config') {
    // supabaseUrl points back at this process: token refresh has to work offline
    // too, and it is the one call that would otherwise escape to the internet.
    json(res, 200, {
      supabaseUrl: `http://${HOST}:${PORT}`,
      supabaseAnonKey: 'replay-anon-key',
      providers: ['google', 'github'],
    });
    return;
  }

  if (route === '/auth/v1/token') {
    const { json: body } = await readBody(req);
    remember({ at: new Date().toISOString(), path: '/auth/v1/token', body });
    if (!body?.refresh_token) {
      json(res, 400, { error: 'invalid_request', error_description: 'refresh_token required' });
      return;
    }
    json(res, 200, {
      access_token: `replay-access-${Date.now().toString(36)}`,
      refresh_token: body.refresh_token,
      expires_in: 3600,
      user: { id: 'replay-user' },
    });
    return;
  }

  if (route === '/api/perch-terminal/account-deletion') {
    remember({
      at: new Date().toISOString(),
      path: route,
      authorization: req.headers.authorization ? 'present' : null,
    });
    // Normally unbanned: the harness is about the happy path, and a banned answer
    // here would stop every completion before it started. When the scenario says
    // the account is banned, this endpoint has to agree — the gateway deliberately
    // does not take a 403's own word for it, it corroborates against this endpoint
    // before it retires the session.
    const banned = scenario === 'banned403';
    json(res, 200, {
      ok: true,
      status: banned ? 'none' : 'none',
      purgeAfter: null,
      canDelete: false,
      blockedReason: banned ? 'banned' : null,
      cancels: { subscription: null, passes: [] },
    });
    return;
  }

  if (route === '/api/perch-terminal/cli-plan') {
    remember({
      at: new Date().toISOString(),
      path: route,
      authorization: req.headers.authorization ? 'present' : null,
    });
    json(res, 200, {
      ok: true,
      planCode: 'pro',
      starter: { noticeVersion: 1 },
      tierSelectionRequired: false,
    });
    return;
  }

  if (route === '/api/perch-terminal/turn-ticket') {
    const { json: body } = await readBody(req);
    ticketSerial += 1;
    remember({ at: new Date().toISOString(), path: route, body });
    json(res, 200, {
      ok: true,
      ticket: `replay-ticket-${ticketSerial}`,
      ticketId: `ticket-${ticketSerial}`,
      runId: `replay-run-${ticketSerial}`,
      enforced: true,
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    });
    return;
  }

  if (route === '/api/perchai/account') {
    remember({
      at: new Date().toISOString(),
      path: route,
      authorization: req.headers.authorization ? 'present' : null,
    });
    json(res, 200, {
      ok: true,
      email: 'replay@example.test',
      userId: 'replay-user',
      planCode: 'pro',
      tierSelectionRequired: false,
      blockedReason: null,
      usageMeter: {
        manual_rolling: {
          enabled: true,
          window5hUsd: 0.12, window5hCapUsd: 5,
          window7dUsd: 0.4, window7dCapUsd: 40,
          window5hNextFreedAt: null, window7dNextFreedAt: null,
        },
      },
    });
    return;
  }

  if (route === '/api/perch-terminal/cli-context') {
    const { json: body } = await readBody(req);
    remember({ at: new Date().toISOString(), path: route, body });
    json(res, 200, { ok: true, files: [] });
    return;
  }

  if (route === '/api/perch-terminal/model-call' && req.method === 'POST') {
    await handleModelCall(req, res);
    return;
  }

  // Anything else is a real finding: the gateway asked for a surface this
  // recorder does not model, and silently 200-ing it would hide that.
  remember({ at: new Date().toISOString(), path: route, method: req.method, unmodelled: true });
  log(`UNMODELLED ${req.method} ${route}`);
  json(res, 404, { error: `recorder does not model ${req.method} ${route}` });
});

server.listen(PORT, HOST, async () => {
  if (RECORD_FILE) {
    await fsp.mkdir(path.dirname(path.resolve(RECORD_FILE)), { recursive: true });
    await fsp.writeFile(RECORD_FILE, '', { mode: 0o600 });
  }
  log(`listening on http://${HOST}:${PORT}  scenario=${scenario}`);
  if (!QUIET) console.log(`[upstream] ready ${HOST}:${PORT}`);
});
