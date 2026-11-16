#!/usr/bin/env node
/**
 * Multi-mode probe matrix — what actually gets answered, one variable at a time.
 *
 * `probe-ladder.mjs` climbs a fixed ladder and stops at the first 403, which answers
 * "is this body accepted" but not "which field cost me the 200". This script probes a
 * matrix instead: it sweeps prompt mode × envelope × lane, records every cell, and
 * prints a table you can read across.
 *
 * Cost control is the whole design constraint. Every call is real money and a real
 * signal to the server, so:
 *   - a banned account aborts before the first call;
 *   - cells are spaced `--gap` ms apart (default 30 s);
 *   - `--budget N` hard-stops after N calls;
 *   - a `403 banned` aborts the whole run (nothing further is learnable);
 *   - a `403 surface_required` does NOT abort — that is the interesting variable;
 *   - `--plan` prints the matrix and sends nothing.
 *
 *   node scripts/probe-matrix.mjs --plan
 *   node scripts/probe-matrix.mjs --preset core
 *   node scripts/probe-matrix.mjs --modes full,canary --envelopes magpie --lanes chat
 *   node scripts/probe-matrix.mjs --preset axes --budget 10 --gap 45000
 *
 * Results go to logs/probe-matrix-<timestamp>.json with the exact body per cell, so a
 * result can be re-derived later without re-spending anything.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { config } from '../src/config.mjs';
import { SessionStore } from '../src/session.mjs';
import { buildRequestBody } from '../src/gateway.mjs';
import { normalizeMessages } from '../src/openai.mjs';
import { resolveModel } from '../src/models.mjs';
import { checkBan, classify403 } from '../src/guard.mjs';
import { PROMPT_MODES, PERCH_SYSTEM_PREFIX, PERCH_AGENTS_PREFIX } from '../src/perch-prefix.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const arg = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const planOnly = flag('plan');
const jsonOnly = flag('json');
const gapMs = Number.parseInt(arg('gap', '30000'), 10);
const budget = Number.parseInt(arg('budget', '24'), 10);
const preset = arg('preset', 'core');
const prompt = arg('prompt', 'Reply with exactly one word: PONG');

const list = (name, fallback) => {
  const raw = arg(name, null);
  if (!raw) return fallback;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
};

/**
 * Presets, cheapest-decision-first.
 *
 * `core`   — does the envelope matter at all? Two calls, same prompt, same lane.
 * `modes`  — does prompt length matter given a modern envelope? One call per mode.
 * `axes`   — sweep everything. Expensive; use --budget.
 * `full`   — a single call with the official shape, as a sanity check.
 */
const PRESETS = {
  core: {
    why: 'isolate the envelope: same prompt, same lane, only the dialect changes',
    envelope: ['honeypot', 'magpie'],
    modes: ['canary'],
    lanes: ['chat'],
  },
  modes: {
    why: 'isolate the prompt: same modern envelope, one call per prompt mode',
    envelope: ['magpie'],
    modes: ['canary', 'canary-scrub', 'full', 'full-agents'],
    lanes: ['chat'],
  },
  axes: {
    why: 'sweep prompt × envelope × lane; every cell is a real call',
    envelope: ['honeypot', 'magpie'],
    modes: ['canary', 'full'],
    lanes: ['chat', 'code'],
  },
  full: {
    why: 'one call in the shape the official client actually sends',
    envelope: ['magpie'],
    modes: ['full'],
    lanes: ['chat'],
  },
};

const base = PRESETS[preset];
if (!base) {
  console.error(`unknown --preset "${preset}" (expected ${Object.keys(PRESETS).join(', ')})`);
  process.exit(2);
}

const envelopes = list('envelopes', base.envelope);
const modes = list('modes', base.modes);
const lanes = list('lanes', base.lanes);

for (const e of envelopes) {
  if (!['honeypot', 'magpie'].includes(e)) {
    console.error(`unknown envelope "${e}"`);
    process.exit(2);
  }
}
for (const m of modes) {
  if (!PROMPT_MODES.includes(m)) {
    console.error(`unknown prompt mode "${m}" (expected ${PROMPT_MODES.join(', ')})`);
    process.exit(2);
  }
}
for (const l of lanes) {
  if (!['chat', 'code', 'worker'].includes(l)) {
    console.error(`unknown lane "${l}"`);
    process.exit(2);
  }
}

// A `full` cell with no prompt file sends an empty system message — a real call,
// real money, and a result that says nothing about the hypothesis. The server
// refuses to boot in that state; the probe must refuse too.
const missing = [];
if (modes.includes('full') && PERCH_SYSTEM_PREFIX.length === 0) missing.push('.perch-prefix.txt (ask)');
if (modes.includes('full-agents') && PERCH_AGENTS_PREFIX.length === 0) missing.push('.perch-prompt-agents.txt (agents)');
if (missing.length) {
  console.error('refusing to run: these prompt modes have no text to send:');
  for (const m of missing) console.error(`  ${m}`);
  console.error('Extract them first:  node scripts/extract-prompt.mjs --cli <unpacked perchai-cli>');
  console.error('Or drop those modes:  --modes canary,canary-scrub');
  process.exit(3);
}

/** One row per call, in a stable order so two runs can be diffed. */
const CELLS = [];
for (const mode of modes) {
  for (const envelope of envelopes) {
    for (const lane of lanes) {
      CELLS.push({ id: `${mode}/${envelope}/${lane}`, mode, envelope, lane });
    }
  }
}

// --- report what each cell will actually send, without sending it --------------
function describeCell(cell) {
  const previous = { promptMode: config.promptMode, lane: config.lane, envelopeMode: config.envelopeMode };
  config.promptMode = cell.mode;
  config.lane = cell.lane;
  config.envelopeMode = cell.envelope;
  try {
    const messages = normalizeMessages([{ role: 'user', content: prompt }], { mode: cell.mode });
    const model = resolveModel('perch');
    const runId = `matrix-${Date.now().toString(36)}`;
    const body = buildRequestBody({
      messages, tools: null, toolChoice: null, maxTokens: 512, temperature: 0.2, stop: null,
      model, runId, reasoning: null,
      attribution: {
        userId: null, workspaceId: process.env.PERCH_WORKSPACE_ID || null, runId,
        lane: cell.lane, source: 'cli', billingMultiplier: null,
      },
      lane: cell.lane,
    });
    const sys = body.request.messages.find((m) => m.role === 'system');
    return {
      sysLen: sys?.content?.length ?? 0,
      roles: body.request.messages.map((m) => m.role).join('+'),
      topKeys: Object.keys(body).length,
      reqKeys: Object.keys(body.request).join(','),
      bytes: JSON.stringify(body).length,
      body,
    };
  } finally {
    config.promptMode = previous.promptMode;
    config.lane = previous.lane;
    config.envelopeMode = previous.envelopeMode;
  }
}

const described = CELLS.map((cell) => ({ ...cell, ...describeCell(cell) }));

if (planOnly || jsonOnly) {
  if (jsonOnly) {
    console.log(JSON.stringify({ preset, gapMs, budget, prompt, cells: described.map(({ body, ...r }) => r) }, null, 2));
    process.exit(0);
  }
  console.log(`probe matrix — preset=${preset}`);
  console.log(`  ${base.why}`);
  console.log(`  gap ${gapMs / 1000}s between calls, budget ${budget} call(s), stop on \`banned\``);
  console.log(`  user agent: ${config.userAgent}`);
  console.log(`  prompt: ${JSON.stringify(prompt)}`);
  console.log('');
  console.log(`  ${'cell'.padEnd(30)} ${'sysLen'.padStart(7)} ${'top'.padStart(4)} ${'bytes'.padStart(7)}  request keys`);
  for (const c of described) {
    console.log(`  ${c.id.padEnd(30)} ${String(c.sysLen).padStart(7)} ${String(c.topKeys).padStart(4)} ${String(c.bytes).padStart(7)}  ${c.reqKeys}`);
  }
  console.log('');
  console.log(`  ${described.length} call(s) planned; a full sweep at 45 s spacing takes ~${Math.round(((described.length - 1) * gapMs) / 60000)} min.`);
  console.log('  (plan only: nothing was sent)');
  process.exit(0);
}

// --- live run ----------------------------------------------------------------
const store = SessionStore.discover();
if (!(await store.reload())) {
  console.error('no session found; run `node scripts/login.sh --label main` first');
  process.exit(2);
}

const { slot, release } = store.pick();
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outFile = path.join(process.cwd(), 'logs', `probe-matrix-${stamp}.json`);
const results = [];
let stopReason = null;
// Declared out here: the `finally` block writes them into the result file, so a run
// that dies before the first cell still leaves a readable record of why.
let tokenError = null;

try {
  const baseUrl = (slot.session?.appUrl || config.appUrl).replace(/\/+$/, '');

  // Getting a token can fail before any cell runs: a revoked refresh token, or a
  // network reset. Neither is a per-cell result, so record it and write the file
  // rather than dying with an unhandled rejection and losing the run.
  let token = null;
  try {
    token = await store.token(slot);
  } catch (error) {
    tokenError = { code: error.code ?? null, message: error.message };
  }

  if (!token) {
    stopReason = tokenError?.code === 'refresh_revoked' ? 'refresh_revoked' : 'no_token';
    console.error(`cannot obtain a token: ${tokenError?.message ?? 'unknown'}`);
    if (tokenError?.code === 'refresh_revoked') {
      console.error('the refresh token was revoked; log in again with scripts/login.sh');
    } else if (tokenError?.code === 'refresh_network') {
      console.error('the token endpoint was unreachable from here. Check that this host can reach');
      console.error('  app.perchai.app AND *.supabase.co over TLS — an edge reset shows up as ECONNRESET.');
      console.error('Nothing was spent on probe calls; the preflight itself made no metered request.');
    } else {
      console.error('re-run scripts/login.sh if the session is stale.');
    }
  } else {
    const ban = await checkBan({ baseUrl, token });
    console.log(`preflight account-deletion: banned=${ban.banned} blockedReason=${ban.blockedReason ?? '—'}${ban.error ? ` error=${ban.error}` : ''}`);
    if (ban.banned) {
      stopReason = 'banned';
      console.error('account is banned; every cell would return the same 403. Aborting before spending calls.');
    }
  }

  const queue = stopReason ? [] : described.slice(0, budget);

  for (const [index, cell] of queue.entries()) {
    if (index > 0) {
      process.stdout.write(`  … ${gapMs / 1000}s `);
      await new Promise((r) => setTimeout(r, gapMs));
      process.stdout.write('\r');
    }
    const previous = { promptMode: config.promptMode, lane: config.lane, envelopeMode: config.envelopeMode };
    config.promptMode = cell.mode;
    config.lane = cell.lane;
    config.envelopeMode = cell.envelope;

    const started = Date.now();
    let record;
    try {
      const messages = normalizeMessages([{ role: 'user', content: prompt }], { mode: cell.mode });
      const model = resolveModel('perch');
      const runId = `matrix-${Date.now().toString(36)}-${index}`;
      const body = buildRequestBody({
        messages, tools: null, toolChoice: null, maxTokens: 512, temperature: 0.2, stop: null,
        model, runId, reasoning: null,
        attribution: {
          userId: slot.session?.userId ?? null, workspaceId: process.env.PERCH_WORKSPACE_ID || null,
          runId, lane: cell.lane, source: 'cli', billingMultiplier: null,
        },
        lane: cell.lane,
      });

      const res = await fetch(`${baseUrl}/api/perch-terminal/model-call`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          Authorization: `Bearer ${token}`,
          'User-Agent': config.userAgent,
          'x-perch-locale': config.locale,
          'x-perch-call-delta': '1',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(180_000),
      });

      const raw = await res.text();
      let payload = null;
      try { payload = JSON.parse(raw); } catch { /* SSE */ }
      const category = res.status === 403 ? classify403(payload) : null;
      const firstDelta = (() => {
        for (const line of raw.split('\n')) {
          if (!line.startsWith('data:')) continue;
          try {
            const e = JSON.parse(line.slice(5).trim());
            if (e.type === 'answer_delta' && e.text) return e.text;
            if (e.type === 'done' && e.text) return e.text;
          } catch { /* ignore */ }
        }
        return null;
      })();

      record = {
        ...cell,
        status: res.status,
        category,
        errorCode: payload?.errorCode ?? null,
        error: payload?.error ?? null,
        ms: Date.now() - started,
        firstDelta,
        body,
        responseHead: raw.slice(0, 2000),
      };
      console.log(`  ${cell.id.padEnd(30)} → ${res.status}${category ? ` ${category}` : ''}${payload?.errorCode ? ` ${payload.errorCode}` : ''} ${record.ms}ms${firstDelta ? ` "${firstDelta.slice(0, 40)}"` : ''}`);
    } catch (error) {
      record = { ...cell, status: 0, transportError: error.message, ms: Date.now() - started };
      console.log(`  ${cell.id.padEnd(30)} → transport error: ${error.message}`);
    } finally {
      config.promptMode = previous.promptMode;
      config.lane = previous.lane;
      config.envelopeMode = previous.envelopeMode;
    }
    results.push(record);

    // `banned` is terminal: no other cell can teach anything about a dead account.
    if (record.category === 'banned') {
      stopReason = 'banned';
      console.log('  stop: banned is terminal, not a per-cell result.');
      break;
    }
  }
} finally {
  release();
  await fsp.mkdir(path.dirname(outFile), { recursive: true });

  // Comparison view: group by status so "which axis moved it" is visible at a glance.
  const byStatus = {};
  for (const r of results) {
    const key = `${r.status}${r.category ? ` ${r.category}` : ''}`;
    (byStatus[key] ??= []).push(r.id);
  }

  await fsp.writeFile(outFile, `${JSON.stringify({
    at: new Date().toISOString(), preset, gapMs, budget, prompt,
    userAgent: config.userAgent, stopReason, tokenError, byStatus, results,
  }, null, 2)}\n`, { mode: 0o600 });

  console.log(`\nrecorded ${results.length} cell(s) → ${outFile}`);
  if (Object.keys(byStatus).length > 1) {
    console.log('\n  outcome spread — the variable that moved is the one that differs:');
    for (const [status, ids] of Object.entries(byStatus)) {
      console.log(`    ${status.padEnd(24)} ${ids.join(', ')}`);
    }
  } else if (results.length) {
    console.log(`\n  every cell returned the same outcome (${Object.keys(byStatus)[0]}); nothing isolated.`);
  }
  if (stopReason) console.log(`  stopped early: ${stopReason}`);
}
