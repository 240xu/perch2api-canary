#!/usr/bin/env node
/**
 * Gate ladder — the only step that needs a live account.
 *
 * Three calls, one per arms-length hypothesis, with the guards that the gateway
 * applies to production traffic applied here too: refuse to start on a banned
 * account, one call at a time, at least 30 s apart, and stop on the first 403
 * instead of climbing.
 *
 *   node scripts/probe-ladder.mjs --dry-run     # print the plan, send nothing
 *   node scripts/probe-ladder.mjs               # actually climb (needs a live session)
 *
 * Results are appended to logs/probe-ladder-<timestamp>.json, including the body
 * that produced each outcome. A 403 is recorded with its payload — that payload
 * is what tells `banned` from `surface_required` from `plan_required`.
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

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const gapMs = Number.parseInt(
  (args.includes('--gap') ? args[args.indexOf('--gap') + 1] : '') || '30000',
  10,
);

const STEPS = [
  {
    id: 'canary-chat',
    why: 'the default: gate paragraph only, chat lane',
    promptMode: 'canary',
    lane: 'chat',
    envelopeMode: 'honeypot',
  },
  {
    id: 'canary-code',
    why: 'code lane carries no server-side persona, so a 403 here but not above implicates the lane',
    promptMode: 'canary',
    lane: 'code',
    envelopeMode: 'honeypot',
  },
  {
    id: 'canary-magpie',
    why: 'same prompt, newer 2.4.132 envelope dialect (resendAfterOutput + roost extras)',
    promptMode: 'canary',
    lane: 'chat',
    envelopeMode: 'magpie',
  },
  {
    id: 'full-chat',
    why: 'control arm: the whole Ask-build operator prompt',
    promptMode: 'full',
    lane: 'chat',
    envelopeMode: 'honeypot',
  },
];

const PROMPT = 'Reply with exactly one word: PONG';

function plan() {
  console.log('gate ladder');
  console.log(`  gap between calls : ${gapMs} ms`);
  console.log(`  stop on 403       : yes`);
  console.log(`  user agent        : ${config.userAgent}`);
  console.log('');
  for (const [index, step] of STEPS.entries()) {
    console.log(`  ${index + 1}. ${step.id.padEnd(14)} mode=${step.promptMode.padEnd(8)} lane=${step.lane.padEnd(5)} envelope=${step.envelopeMode}`);
    console.log(`     why: ${step.why}`);
  }
  console.log('');
  console.log('  preflight: GET /api/perch-terminal/account-deletion — a banned account aborts the ladder.');
}

if (dryRun) {
  plan();
  console.log('\n(dry run: nothing was sent)');
  process.exit(0);
}

const store = SessionStore.discover();
const loaded = await store.reload();
if (!loaded) {
  console.error('no session found; run `node scripts/login.mjs` first');
  process.exit(2);
}

const { slot, release } = store.pick();
const outFile = path.join(process.cwd(), 'logs', `probe-ladder-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
const results = [];

try {
  const baseUrl = (slot.session?.appUrl || config.appUrl).replace(/\/+$/, '');
  const token = await store.token(slot);

  const ban = await checkBan({ baseUrl, token });
  console.log(`preflight account-deletion: banned=${ban.banned} blockedReason=${ban.blockedReason ?? '—'}${ban.error ? ` error=${ban.error}` : ''}`);
  if (ban.banned) {
    console.error('account is banned; the ladder would only prove that 403 stays 403. Aborting.');
    await fsp.mkdir(path.dirname(outFile), { recursive: true });
    await fsp.writeFile(outFile, `${JSON.stringify({ aborted: 'banned', ban }, null, 2)}\n`);
    process.exit(1);
  }

  for (const [index, step] of STEPS.entries()) {
    if (index > 0) {
      console.log(`  … waiting ${gapMs / 1000}s`);
      await new Promise((resolve) => setTimeout(resolve, gapMs));
    }
    const previous = { promptMode: config.promptMode, lane: config.lane, envelopeMode: config.envelopeMode };
    config.promptMode = step.promptMode;
    config.lane = step.lane;
    config.envelopeMode = step.envelopeMode;

    let record;
    try {
      const messages = normalizeMessages([{ role: 'user', content: PROMPT }], { mode: step.promptMode });
      const model = resolveModel('perch');
      const runId = `ladder-${Date.now().toString(36)}`;
      const body = buildRequestBody({
        messages,
        tools: null,
        toolChoice: null,
        maxTokens: 512,
        temperature: 0.2,
        stop: null,
        model,
        runId,
        reasoning: null,
        attribution: {
          userId: slot.session?.userId ?? null,
          workspaceId: process.env.PERCH_WORKSPACE_ID || null,
          runId,
          lane: step.lane,
          source: 'cli',
          billingMultiplier: null,
        },
        lane: step.lane,
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
      try { payload = JSON.parse(raw); } catch { /* SSE stream */ }
      const category = res.status === 403 ? classify403(payload) : null;
      record = {
        step: step.id,
        why: step.why,
        status: res.status,
        category,
        errorCode: payload?.errorCode ?? null,
        error: payload?.error ?? null,
        promptMode: step.promptMode,
        lane: step.lane,
        envelopeMode: step.envelopeMode,
        sysLen: body.request.messages?.[0]?.content?.length ?? 0,
        roles: body.request.messages.map((m) => m.role),
        topKeys: Object.keys(body),
        requestKeys: Object.keys(body.request),
        responseHead: raw.slice(0, 2000),
        body,
      };
      console.log(`  ${step.id.padEnd(14)} → HTTP ${res.status}${category ? ` (${category})` : ''}${payload?.errorCode ? ` ${payload.errorCode}` : ''}`);
    } catch (error) {
      record = { step: step.id, why: step.why, status: 0, transportError: error.message };
      console.log(`  ${step.id.padEnd(14)} → transport error: ${error.message}`);
    } finally {
      config.promptMode = previous.promptMode;
      config.lane = previous.lane;
      config.envelopeMode = previous.envelopeMode;
    }
    results.push(record);

    if (record.status === 403) {
      console.log('  stop: 403 is the answer to the hypothesis, not something to retry.');
      break;
    }
  }
} finally {
  release();
  await fsp.mkdir(path.dirname(outFile), { recursive: true });
  await fsp.writeFile(outFile, `${JSON.stringify({ at: new Date().toISOString(), gapMs, userAgent: config.userAgent, results }, null, 2)}\n`, { mode: 0o600 });
  console.log(`\nrecorded ${results.length} step(s) → ${outFile}`);
  if (!fs.existsSync(outFile)) console.error('could not write the result file');
}
