#!/usr/bin/env node
/**
 * Perch2API — OpenAI-compatible gateway in front of the Perch (perchai.app)
 * hosted model proxy.
 *
 *   POST /v1/chat/completions   streaming + non-streaming
 *   GET  /v1/models             Roost tiers and named pins
 *   GET  /v1/account            plan, entitlements, usage meter for the session
 *   GET  /v1/sessions           discovered session files and their state
 *   GET  /health
 *
 * Every upstream call passes five guards before it leaves the process:
 * pause switch, circuit breaker, concurrency semaphore, pacing timer, and a
 * banned-account check. The old build had none of them, which is how a banned
 * account turned into a silent retry storm.
 */
import http from 'node:http';

import {
  PERCH_SYSTEM_PREFIX, PERCH_AGENTS_PREFIX, HAS_SYSTEM_PREFIX, SYSTEM_PREFIX_SOURCE, AGENTS_PREFIX_SOURCE,
  promptForMode, describeMode, modeNeedsFullPrompt, CANARY, PROMPT_MODES,
} from './perch-prefix.mjs';
import { config, loadRuntime } from './config.mjs';
import { SessionStore } from './session.mjs';
import { buildRequestBody, callModel, fetchAccount, PerchError } from './gateway.mjs';
import { resolveModel, listModels } from './models.mjs';
import {
  newCompletionId, normalizeMessages, collectCompletion, pipeAsOpenAIStream, openAIError, scrubHits,
} from './openai.mjs';
import { emit, recordRequest, stats, rollDay } from './eventbus.mjs';
import { checkBan, classify403, envelopeFingerprint, checkCliVersion } from './guard.mjs';
import { startPanel } from './panel.mjs';

const runtime = loadRuntime();
if (runtime.applied.length) {
  console.log(`runtime overrides from ${runtime.file}: `
    + runtime.applied.map((c) => `${c.key}=${c.to}`).join(' '));
}

const store = SessionStore.discover();
const loaded = await store.reload();

/** Breaker / pause state. Mutable by the panel. */
const guardState = {
  paused: Boolean(runtime.overrides.paused),
  breakerOpen: false,
  consecutiveFailures: 0,
  breakerOpenedAt: null,
  lastUpstreamAt: 0,
  lastRateWaitMs: 0,
};

function log(...args) {
  if (config.logRequests) console.log(new Date().toISOString(), ...args);
}

// ---- concurrency + pacing -------------------------------------------------

/** Minimal FIFO semaphore: N permits, no starvation, no dependency. */
class Semaphore {
  constructor(permits) {
    this.free = Math.max(1, permits);
    this.inFlight = 0;
    this.waiters = [];
  }

  async acquire() {
    if (this.free > 0) {
      this.free -= 1;
      this.inFlight += 1;
      return () => this.#release();
    }
    await new Promise((resolve) => this.waiters.push(resolve));
    this.inFlight += 1;
    return () => this.#release();
  }

  #release() {
    this.inFlight = Math.max(0, this.inFlight - 1);
    const next = this.waiters.shift();
    if (next) next();
    else this.free += 1;
  }
}

let semaphore = new Semaphore(config.maxConcurrency);
let semaphoreLimit = config.maxConcurrency;

/** Rebuild the semaphore when the panel changes the limit. */
function ensureSemaphore() {
  if (config.maxConcurrency !== semaphoreLimit) {
    semaphore = new Semaphore(config.maxConcurrency);
    semaphoreLimit = config.maxConcurrency;
  }
}

async function pace() {
  const gap = config.minIntervalMs;
  if (!gap) return;
  const wait = guardState.lastUpstreamAt + gap - Date.now();
  if (wait > 0) {
    guardState.lastRateWaitMs = wait;
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  guardState.lastUpstreamAt = Date.now();
}

/** Trip the breaker after N consecutive upstream failures. */
function noteFailure() {
  guardState.consecutiveFailures += 1;
  if (!guardState.breakerOpen && guardState.consecutiveFailures >= config.breakerThreshold) {
    guardState.breakerOpen = true;
    guardState.breakerOpenedAt = Date.now();
    emit('ERROR', {
      code: 'breaker_open',
      message: `Circuit breaker opened after ${guardState.consecutiveFailures} consecutive failures.`,
      threshold: config.breakerThreshold,
    });
  }
}

function noteSuccess() {
  guardState.consecutiveFailures = 0;
  if (guardState.breakerOpen) {
    guardState.breakerOpen = false;
    guardState.breakerOpenedAt = null;
    emit('INFO', { code: 'breaker_closed', message: 'Circuit breaker closed after a successful call.' });
  }
}

function authorize(req) {
  if (!config.apiKey) return true;
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : (req.headers['x-api-key'] || '');
  return token === config.apiKey;
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
}

async function readJson(req, limitBytes = 32 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new PerchError('request body too large', { status: 413, code: 'payload_too_large' });
    chunks.push(chunk);
  }
  if (!size) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function attributionFor(slot, runId, lane) {
  const session = slot.session ?? {};
  return {
    userId: session.userId ?? null,
    workspaceId: process.env.PERCH_WORKSPACE_ID || null,
    runId,
    lane,
    source: 'cli',
    billingMultiplier: null,
  };
}

/**
 * Turn tickets are optional.
 *
 * The surface accepts a call without one, and minting a ticket costs a request
 * against the same rate budget as the model call itself — one of the reasons
 * accounts die young. So the default is `off`, `best-effort` degrades on failure
 * and only `required` makes a missing ticket fatal.
 */
async function maybeTicket(slot, token) {
  if (config.ticketMode === 'off') return null;
  try {
    return await fetchTurnTicket(slot, token);
  } catch (error) {
    if (config.ticketMode === 'required') throw error;
    emit('WARN', {
      code: 'ticket_failed',
      message: `Turn ticket unavailable, continuing without one: ${error.message}`,
      status: error.status ?? null,
    });
    return null;
  }
}

async function fetchTurnTicket(slot, token) {
  const now = Date.now();
  if (slot.ticket && slot.ticket.expiresAt > now + 30_000) return slot.ticket;
  const appUrl = (slot.session?.appUrl || config.appUrl).replace(/\/+$/, '');
  const res = await fetch(`${appUrl}/api/perch-terminal/turn-ticket`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      'User-Agent': config.userAgent,
      'x-perch-locale': config.locale,
    },
    body: JSON.stringify({ surface: 'cli', profile: 'standard', ticketClient: 2 }),
  });
  const data = await res.json().catch(() => null);
  if (process.env.PERCH_DEBUG_WIRE === '1') {
    console.log('[ticket]', appUrl, 'status=', res.status, 'ok=', data?.ok, 'run=', data?.runId ?? 'none', 'enforced=', data?.enforced, 'err=', data?.error ?? 'none');
  }
  if (!res.ok || !data?.ticket || !data?.ticketId || !data?.runId) {
    throw Object.assign(new Error(data?.error || `turn ticket HTTP ${res.status}`), {
      status: res.status,
      code: data?.errorCode || 'turn_ticket_unavailable',
    });
  }
  const expiresAt = data.expiresAt ? Date.parse(data.expiresAt) : now + 300_000;
  slot.ticket = {
    token: data.ticket,
    ticketId: data.ticketId,
    runId: data.runId,
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : now + 300_000,
  };
  return slot.ticket;
}

function statusForPerchError(error) {
  if (error?.status === 401) return 401;
  if (error?.status === 403) return 403;
  if (error?.status === 404) return 404;
  if (error?.status === 429) return 429;
  if (error?.status === 499) return 499;
  if (error?.status >= 400 && error?.status < 600) return error.status;
  return 502;
}

/**
 * Run one model call with a per-account retry on 401 (stale access token).
 * Refreshes the token once, then re-issues the identical body.
 */
async function runModelCall({ model, messages, tools, options, signal, onEvent, lane }) {
  const effectiveLane = lane || config.lane;
  const fingerprint = envelopeFingerprint({
    lane: effectiveLane,
    promptMode: config.promptMode,
    ticketMode: config.ticketMode,
    modelKind: model.kind,
    envelopeMode: config.envelopeMode,
    scrub: config.scrubIdentity,
  });

  if (guardState.paused) {
    throw Object.assign(new PerchError('Gateway is paused from the panel', { status: 503, code: 'paused' }), { retryable: false });
  }
  if (guardState.breakerOpen) {
    throw Object.assign(new PerchError('Circuit breaker is open; resume from the panel to continue',
      { status: 503, code: 'breaker_open' }), { retryable: false });
  }

  ensureSemaphore();
  const releaseSlot = await semaphore.acquire();
  let picked;
  try {
    picked = store.pick();
  } catch (error) {
    // No usable account at all. Record it as a real request outcome — otherwise
    // the panel shows an idle gateway while every caller is being refused — but
    // do not count it as instability, because a banned account is a permanent
    // state, not a flaky upstream.
    recordRequest({
      status: error.status ?? 503,
      lane: effectiveLane,
      promptMode: config.promptMode,
      ticketMode: config.ticketMode,
      model: model.requested,
      modelKind: model.kind,
      envelopeMode: config.envelopeMode,
      envelope: fingerprint,
      sysLen: 0,
      roles: '',
      bodyBytes: 0,
      ttftMs: null,
      totalMs: 0,
      code: error.code ?? 'no_session',
      message: error.message,
    });
    releaseSlot();
    throw error;
  }
  const { slot, release } = picked;
  const started = Date.now();
  let ttftMs = null;
  let sysLen = 0;
  let roles = '';

  try {
    await pace();

    let runId = `p2api-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const buildBody = (rid) => buildRequestBody({
      messages,
      tools,
      toolChoice: options.toolChoice,
      maxTokens: options.maxTokens,
      temperature: options.temperature,
      stop: options.stop,
      model,
      runId: rid,
      reasoning: options.reasoning,
      attribution: attributionFor(slot, rid, effectiveLane),
      lane: effectiveLane,
    });

    const first = buildBody(runId);
    sysLen = first.request.messages?.[0]?.content?.length ?? 0;
    roles = (first.request.messages || []).map((m) => m.role).join(',');

    const call = async (cb) => {
      let token = await store.token(slot);
      let ticket = await maybeTicket(slot, token);
      if (ticket?.runId) runId = ticket.runId;
      const wrap = (inner) => (event) => {
        if (ttftMs == null && (event?.type === 'answer_delta' || event?.type === 'reasoning_delta')) {
          ttftMs = Date.now() - started;
        }
        return inner(event);
      };
      try {
        return await callModel({
          baseUrl: slot.session.appUrl || config.appUrl,
          token,
          ticket,
          body: buildBody(runId),
          signal,
          onEvent: wrap(cb.onEvent),
          onRetry: (attempt, error) => log(`retry ${attempt} for ${runId}: ${error.message}`),
        });
      } catch (error) {
        if (error?.auth) {
          token = await store.token(slot, { force: true });
          slot.ticket = null;
          ticket = await maybeTicket(slot, token);
          if (ticket?.runId) runId = ticket.runId;
          return callModel({
            baseUrl: slot.session.appUrl || config.appUrl,
            token,
            ticket,
            body: buildBody(runId),
            signal,
            onEvent: wrap(cb.onEvent),
          });
        }
        throw error;
      }
    };

    const done = await onEvent(call);
    noteSuccess();
    recordRequest({
      status: 200,
      lane: effectiveLane,
      promptMode: config.promptMode,
      ticketMode: config.ticketMode,
      model: model.requested,
      modelKind: model.kind,
      envelopeMode: config.envelopeMode,
      envelope: fingerprint,
      sysLen,
      roles,
      scrubHits: scrubHits(),
      bodyBytes: JSON.stringify(first).length,
      ttftMs,
      totalMs: Date.now() - started,
      inputTokens: done?.usage?.inputTokens ?? null,
      outputTokens: done?.usage?.outputTokens ?? null,
      served: done?.model ?? null,
      callDelta: done?.meta?.callDelta ?? null,
      heldLength: done?.meta?.heldLength ?? null,
      code: 'ok',
    });
    return done;
  } catch (error) {
    const status = statusForPerchError(error);
    const code = error?.code ?? `http_${status}`;
    noteFailure();

    // A 403 is never just "forbidden": distinguish a permanent ban from a
    // prompt-envelope problem from a recoverable plan state.
    let category = null;
    if (status === 403) {
      category = classify403({ errorCode: code, error: error.message });
      if (category === 'banned' || (category !== 'surface_required' && config.banCheck)) {
        const ban = await checkBan({ baseUrl: slot.session?.appUrl || config.appUrl, token: slot.session?.accessToken });
        if (ban.banned) {
          store.markBanned(slot, ban.blockedReason || 'banned');
          category = 'banned';
        }
      }
      if (category === 'plan_required') {
        try {
          await store.healPlan(slot);
        } catch (healError) {
          emit('WARN', { code: 'plan_heal_error', message: healError.message });
        }
      }
      emit(category === 'banned' ? 'ERROR' : 'WARN', {
        code: category || 'forbidden',
        message: `403 ${category || 'forbidden'}: ${error.message}`,
        envelope: fingerprint,
      });
    } else if (status === 429) {
      emit('WARN', { code: 'rate_limited', message: error.message, limit: error.limit ?? null, envelope: fingerprint });
    } else if (status >= 500) {
      emit('WARN', { code: 'upstream_error', message: `${status} ${error.message}`, envelope: fingerprint });
    } else {
      emit('INFO', { code, message: error.message, status, envelope: fingerprint });
    }

    recordRequest({
      status,
      lane: effectiveLane,
      promptMode: config.promptMode,
      ticketMode: config.ticketMode,
      model: model.requested,
      modelKind: model.kind,
      envelopeMode: config.envelopeMode,
      envelope: fingerprint,
      sysLen,
      roles,
      scrubHits: scrubHits(),
      bodyBytes: 0,
      ttftMs,
      totalMs: Date.now() - started,
      inputTokens: null,
      outputTokens: null,
      code: category ? `${status}:${category}` : code,
      message: error.message,
    });
    throw error;
  } finally {
    release();
    releaseSlot();
    rollDay();
  }
}

function normalizeOptions(body) {
  const maxTokens = body.max_completion_tokens ?? body.max_tokens;
  const reasoningEffort = body.reasoning_effort;
  const reasoning = config.disableThinkingByDefault || reasoningEffort === 'none'
    ? { enableThinking: false }
    : (typeof reasoningEffort === 'string' && reasoningEffort.trim()
      ? { reasoningEffort: reasoningEffort.trim() }
      : undefined);
  return {
    maxTokens: Number.isFinite(maxTokens) ? Math.max(1, Math.min(maxTokens, 32_000)) : 32_000,
    temperature: Number.isFinite(body.temperature) ? body.temperature : 0.6,
    stop: body.stop,
    toolChoice: body.tool_choice,
    reasoning,
  };
}

/** Everything the panel and `/health` need about this process. */
export async function gatewayState() {
  return {
    service: 'perch2api',
    now: Date.now(),
    paused: guardState.paused,
    breakerOpen: guardState.breakerOpen,
    consecutiveFailures: guardState.consecutiveFailures,
    breakerThreshold: config.breakerThreshold,
    breakerOpenedAt: guardState.breakerOpenedAt,
    concurrency: { active: semaphore.inFlight, limit: config.maxConcurrency },
    pacing: { minIntervalMs: config.minIntervalMs, lastWaitMs: guardState.lastRateWaitMs },
    prompt: {
      mode: config.promptMode,
      description: describeMode(config.promptMode),
      modes: PROMPT_MODES,
      canaryChars: CANARY.length,
      fullChars: PERCH_SYSTEM_PREFIX.length,
      agentsChars: PERCH_AGENTS_PREFIX.length,
      source: SYSTEM_PREFIX_SOURCE,
      agentsSource: AGENTS_PREFIX_SOURCE,
    },
    lane: config.lane,
    ticketMode: config.ticketMode,
    envelopeMode: config.envelopeMode,
    userAgent: config.userAgent,
    sessions: store.describe(),
    stats: {
      ...stats,
      envelopes: Object.fromEntries(stats.envelopes),
      uptimeMs: Date.now() - stats.startedAt,
    },
  };
}

const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const route = url.pathname.replace(/\/+$/, '') || '/';

  if (route === '/health' || route === '/') {
    const state = await gatewayState();
    const body = JSON.stringify({
      ok: !guardState.paused && !guardState.breakerOpen,
      service: 'perch2api',
      version: '2.0.0',
      sessions: store.size,
      loaded,
      upstream: config.appUrl,
      paused: state.paused,
      breaker: state.breakerOpen ? 'open' : 'closed',
      promptMode: state.prompt.mode,
      lane: state.lane,
      ticketMode: state.ticketMode,
      envelopeMode: state.envelopeMode,
      userAgent: state.userAgent,
      concurrency: state.concurrency,
      failures: state.consecutiveFailures,
    });
    res.writeHead(guardState.breakerOpen || guardState.paused ? 503 : 200, { 'Content-Type': 'application/json' });
    res.end(body);
    return;
  }

  if (!authorize(req)) {
    openAIError(res, 401, 'Invalid API key', { code: 'invalid_api_key', type: 'authentication_error' });
    return;
  }

  try {
    if (req.method === 'GET' && (route === '/v1/models' || route === '/models')) {
      const body = JSON.stringify({
        object: 'list',
        data: listModels(),
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
      return;
    }

    if (req.method === 'GET' && route === '/v1/sessions') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: store.describe() }));
      return;
    }

    if (req.method === 'GET' && (route === '/v1/account' || route === '/account')) {
      const { slot, release } = store.pick();
      try {
        const token = await store.token(slot);
        const account = await fetchAccount({ baseUrl: slot.session.appUrl || config.appUrl, token });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(account));
      } finally {
        release();
      }
      return;
    }

    if (req.method === 'POST' && (route === '/v1/chat/completions' || route === '/chat/completions')) {
      const body = await readJson(req);
      if (!Array.isArray(body.messages) || !body.messages.length) {
        openAIError(res, 400, 'messages must be a non-empty array', { code: 'invalid_messages' });
        return;
      }

      const model = resolveModel(body.model);
      const messages = normalizeMessages(body.messages, { mode: config.promptMode });
      const tools = Array.isArray(body.tools) ? body.tools : null;
      const options = normalizeOptions(body);
      const stream = body.stream === true;
      const includeUsage = Boolean(body.stream_options?.include_usage);
      const lane = typeof req.headers['x-perch-lane'] === 'string' && req.headers['x-perch-lane'].trim()
        ? req.headers['x-perch-lane'].trim().toLowerCase()
        : config.lane;
      const id = newCompletionId();
      const created = Math.floor(Date.now() / 1000);
      const controller = new AbortController();
      req.on('close', () => controller.abort());

      const notes = messages.notes ?? {};
      log(`chat model=${model.requested} kind=${model.kind} stream=${stream} messages=${messages.length} tools=${tools?.length ?? 0} `
        + `mode=${config.promptMode} lane=${lane} env=${config.envelopeMode} scrub=${notes.scrubHits ?? 0}`);

      if (stream) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
        });
        try {
          const done = await runModelCall({
            model, messages, tools, options, lane, signal: controller.signal,
            onEvent: (call) => pipeAsOpenAIStream({
              res,
              id,
              created,
              modelName: model.requested,
              includeUsage,
              call,
            }),
          });
          log(`done model=${model.requested} served=${done.model} tokens=${done.usage?.totalTokens ?? '?'}`);
        } catch (error) {
          if (res.writableEnded) return;
          const perchError = error instanceof PerchError ? error : new PerchError(error.message);
          res.write(`data: ${JSON.stringify({
            error: {
              message: perchError.message,
              type: 'perch_error',
              code: perchError.code,
              ...(perchError.limit ? { perch_limit: perchError.limit } : {}),
            },
          })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
          log(`stream error: ${perchError.code} ${perchError.message}`);
        }
        return;
      }

      const completion = await runModelCall({
        model, messages, tools, options, lane, signal: controller.signal,
        onEvent: (call) => collectCompletion({ id, created, modelName: model.requested, expectedModelId: model.preferredModelId ?? null, call }),
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(completion));
      log(`done model=${model.requested} served=${completion.perch?.model} tokens=${completion.usage?.total_tokens ?? '?'}`);
      return;
    }

    openAIError(res, 404, `Unknown route ${route}`, { code: 'not_found' });
  } catch (error) {
    const status = statusForPerchError(error);
    const perchError = error instanceof PerchError
      ? error
      : new PerchError(error.message || 'internal error', {
        status: error.status ?? 502,
        code: error.code ?? 'internal_error',
      });
    log(`error ${status} ${perchError.code}: ${perchError.message}`);
    if (!res.headersSent) {
      openAIError(res, status, perchError.message, {
        code: perchError.code,
        extra: perchError.limit ? { limit: perchError.limit } : null,
      });
    } else if (!res.writableEnded) {
      res.end();
    }
  }
});

// Node's own request timeout (300s default on Node 18+) would kill long turns
// before the upstream timeout does. Per-request abort is handled by the signal.
server.requestTimeout = 0;
server.timeout = 0;
server.headersTimeout = 60_000;
server.keepAliveTimeout = 65_000;

server.listen(config.port, config.host, () => {
  console.log(`perch2api listening on http://${config.host}:${config.port}`);
  console.log(`  sessions discovered: ${store.size} (loaded ${loaded})`);
  for (const slot of store.describe()) {
    console.log(`   ${slot.ok ? 'OK ' : 'ERR'} ${slot.email || '-'}  ${slot.file}${slot.error ? `  (${slot.error})` : ''}`);
  }
  if (!config.apiKey) console.log('  auth: DISABLED (set PERCH2API_KEY to require a bearer key)');
  console.log(`  upstream: ${config.appUrl}  UA: ${config.userAgent}`);
  console.log(`  prompt: ${config.promptMode} — ${describeMode(config.promptMode)}`);
  console.log(`  lane: ${config.lane}  ticket: ${config.ticketMode}  envelope: ${config.envelopeMode}`);
  console.log(`  guards: concurrency=${config.maxConcurrency} minInterval=${config.minIntervalMs}ms breaker=${config.breakerThreshold}`);
  console.log(`  gate text: canary ${CANARY.length} chars | ask ${PERCH_SYSTEM_PREFIX.length} (${SYSTEM_PREFIX_SOURCE}) | agents ${PERCH_AGENTS_PREFIX.length} (${AGENTS_PREFIX_SOURCE})`);
  if (modeNeedsFullPrompt(config.promptMode) && config.promptMode === 'full' && !HAS_SYSTEM_PREFIX) {
    console.warn('  WARNING: promptMode=full but no full prompt is configured.');
    console.warn('           run `node scripts/extract-prefix.mjs` or set PERCH_SYSTEM_PREFIX.');
  }
  const version = checkCliVersion();
  console.log(`  cli version: claimed=${version.claimed ?? '(none)'} installed=${version.installed ?? '?'} ${version.level}`);
});

if (config.panelEnabled) {
  try {
    await startPanel({ state: gatewayState, store, guardState, config });
  } catch (error) {
    console.warn(`panel did not start: ${error.message}`);
  }
}

/**
 * Startup self-check: an account can be dead before the first request arrives.
 * Checking here turns "mysterious 403 on the first call" into a line in the panel
 * at boot. Failures are non-fatal — the gateway still starts, it just reports.
 */
async function startupSelfCheck() {
  for (const slot of store.slots) {
    if (!slot.session) continue;
    try {
      const baseUrl = (slot.session.appUrl || config.appUrl).replace(/\/+$/, '');
      const token = await store.token(slot);
      if (config.banCheck) {
        const ban = await checkBan({ baseUrl, token });
        if (ban.banned) {
          store.markBanned(slot, ban.blockedReason || 'banned');
          continue;
        }
      }
      const info = await store.accountInfo(slot, { force: true });
      emit('INFO', {
        code: 'account_check',
        message: `planCode=${info.planCode ?? 'null'} tierSelectionRequired=${info.tierSelectionRequired} `
          + `window5h=${info.usage.windows?.[0]?.used ?? '—'}/${info.usage.windows?.[0]?.cap ?? '—'}`,
        file: slot.file,
      });
      if (!info.planCode && info.tierSelectionRequired === true) {
        await store.healPlan(slot);
      } else {
        slot.state = 'ok';
      }
    } catch (error) {
      emit('WARN', { code: 'startup_check_failed', message: error.message, file: slot.file });
    }
  }
}

await startupSelfCheck();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`\n${signal} received, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 4000).unref();
  });
}
