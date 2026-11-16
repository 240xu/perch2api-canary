#!/usr/bin/env node
/**
 * Offline body inspector.
 *
 * Builds the exact model-call body the gateway would send and prints a summary.
 * Nothing is fetched and no token is read, which makes this the only acceptance
 * gate that works without a live account.
 *
 * The value it provides is regression pressure: the captured official call has
 * exactly eight top-level keys and five inside `request`, so any field we add or
 * drop shows up here immediately.
 *
 *   node scripts/inspect-body.mjs                      # current .env settings
 *   node scripts/inspect-body.mjs --mode canary-scrub --system "You are opencode"
 *   node scripts/inspect-body.mjs --all                # every prompt mode, one table
 *   node scripts/inspect-body.mjs --json               # machine readable
 */
import { config } from '../src/config.mjs';
import { PROMPT_MODES, promptForMode, describeMode, CANARY } from '../src/perch-prefix.mjs';

const args = process.argv.slice(2);
function arg(name, fallback = null) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
}
function flag(name) {
  return args.includes(`--${name}`);
}

/**
 * Reference shapes, in wire order.
 *
 * There is no single "official body" any more. Measured against `perchai-cli`:
 *   2.4.108         8 keys (honeypot dialect)
 *   2.4.114+        9 keys — adds resendAfterOutput
 *   with --effort  12 keys — adds roostModelChoice, roostReasoning, effort
 *   with a pin     13 keys — adds manualModelOptionId
 * A pin does NOT populate preferredModelId; it stays null.
 */
const OFFICIAL_TOP_KEYS = [
  'request', 'runId', 'lane', 'strictManual', 'preferredModelId',
  'avoidModelIds', 'attribution', 'clientSurface',
];
const OFFICIAL_TOP_KEYS_MODERN = [...OFFICIAL_TOP_KEYS, 'resendAfterOutput'];
const OFFICIAL_TOP_KEYS_EFFORT = [...OFFICIAL_TOP_KEYS_MODERN, 'roostModelChoice', 'roostReasoning', 'effort'];
const OFFICIAL_TOP_KEYS_PIN = [...OFFICIAL_TOP_KEYS_EFFORT, 'manualModelOptionId'];
/** ask sends no tools; agents adds tools + toolChoice. */
const OFFICIAL_REQUEST_KEYS = ['messages', 'temperature', 'maxTokens'];
const OFFICIAL_REQUEST_KEYS_AGENTS = ['messages', 'tools', 'temperature', 'maxTokens', 'toolChoice'];

/** The reference shape the current config should reproduce. */
function referenceTopKeys() {
  if (envelopeMode === 'honeypot') return OFFICIAL_TOP_KEYS;
  if (config.sendRoostExtras) {
    return model.kind === 'pin' ? OFFICIAL_TOP_KEYS_PIN : OFFICIAL_TOP_KEYS_EFFORT;
  }
  return model.kind === 'pin' ? [...OFFICIAL_TOP_KEYS_MODERN, 'manualModelOptionId'] : OFFICIAL_TOP_KEYS_MODERN;
}

const mode = arg('mode', config.promptMode);
const lane = arg('lane', config.lane);
const model = arg('model', 'perch');
const callerSystem = arg('system', null);
const envelopeMode = arg('envelope', config.envelopeMode);

if (!PROMPT_MODES.includes(mode)) {
  console.error(`unknown mode "${mode}" (expected one of ${PROMPT_MODES.join(', ')})`);
  process.exit(2);
}

// Imported lazily so --all can rebuild with different modes.
const { inspect } = await import('../src/panel.mjs');

function run(overrides = {}) {
  return inspect({
    mode: overrides.mode ?? mode,
    lane: overrides.lane ?? lane,
    model: overrides.model ?? model,
    envelopeMode: overrides.envelopeMode ?? envelopeMode,
    callerSystem: overrides.callerSystem ?? callerSystem,
    userText: overrides.userText ?? 'Say hello in five words.',
    ticketMode: config.ticketMode,
  });
}

function diffKeys(actual, expected) {
  const extra = actual.filter((k) => !expected.includes(k));
  const missing = expected.filter((k) => !actual.includes(k));
  return { extra, missing };
}

function report(result) {
  const refTop = referenceTopKeys();
  const refReq = result.requestKeys.includes('tools') || result.requestKeys.includes('toolChoice')
    ? OFFICIAL_REQUEST_KEYS_AGENTS
    : OFFICIAL_REQUEST_KEYS;
  const top = diffKeys(result.topLevelKeys, refTop);
  const req = diffKeys(result.requestKeys, refReq);
  const okTop = !top.extra.length && !top.missing.length;
  // `request` is allowed to carry FEWER keys than the reference: a caller without
  // tools legitimately has no tools/toolChoice. Extra keys are never acceptable,
  // and so is `lane`, which the official body has never carried there.
  const okReq = req.extra.length === 0 && req.missing.length === 0;
  const okLane = result.laneInsideRequest === false;
  const okDelta = result.headers['x-perch-call-delta'] === '1';

  const lines = [];
  lines.push(`promptMode        = ${result.promptMode}   (${describeMode(result.promptMode)})`);
  lines.push(`injectedChars     = ${result.injectedChars}   (CANARY is ${CANARY.length})`);
  lines.push(`systemCount       = ${result.systemCount}   lengths=[${result.systemLengths.join(', ')}]`);
  lines.push(`roles             = ${result.roles.join(',')}`);
  lines.push(`model             = ${model}`);
  lines.push(`lane (top level)  = ${result.laneAtTop}`);
  lines.push(`lane inside req   = ${result.laneInsideRequest ? 'PRESENT (must be absent)' : 'absent'}`);
  lines.push('');
  lines.push(`top-level keys    = ${result.topLevelKeyCount}  [${result.topLevelKeys.join(', ')}]`);
  lines.push(`  vs reference(${refTop.length}) = ${okTop ? 'identical' : `extra=[${top.extra.join(',')}] missing=[${top.missing.join(',')}]`}`);
  lines.push(`request keys      = [${result.requestKeys.join(', ')}]`);
  lines.push(`  vs reference     = ${okReq ? 'identical' : `extra=[${req.extra.join(',')}] missing=[${req.missing.join(',')}]`}`);
  lines.push('');
  lines.push(`preferredModelId  = ${JSON.stringify(result.preferredModelId)}`);
  if (result.manualModelOptionId !== null) lines.push(`manualModelOptionId = ${result.manualModelOptionId}`);
  if (result.roostModelChoice !== null) lines.push(`roostModelChoice  = ${result.roostModelChoice}`);
  if (result.roostReasoning !== null) lines.push(`roostReasoning    = ${result.roostReasoning}`);
  if (result.effort !== null) lines.push(`effort            = ${JSON.stringify(result.effort)}`);
  lines.push(`resendAfterOutput = ${result.hasResendAfterOutput ? 'present' : 'absent'}   request.stop = ${result.hasStop ? 'present' : 'absent'}`);
  lines.push('');
  lines.push('headers:');
  for (const [k, v] of Object.entries(result.headers)) lines.push(`  ${k}: ${v === null ? '(not sent)' : v}`);
  lines.push('');
  lines.push(`attribution       = ${JSON.stringify(result.attribution)}`);
  if (result.scrub) lines.push(`callerSystem      = ${result.scrub.callerSystemChars} chars, identity hits ${result.scrub.identityHits}`);
  lines.push(`bodyBytes         = ${result.bodyBytes}`);
  lines.push(`envelopeMode      = ${envelopeMode}`);
  lines.push('');
  lines.push(`VERDICT           = ${okTop && okReq && okLane && okDelta ? 'matches the reference shape for this config' : 'DEVIATES — see the lines marked above'}`);
  return lines.join('\n');
}

if (flag('all')) {
  const rows = PROMPT_MODES.map((m) => {
    const r = run({ mode: m });
    const top = diffKeys(r.topLevelKeys, referenceTopKeys());
    const req = diffKeys(r.requestKeys, OFFICIAL_REQUEST_KEYS);
    return {
      mode: m,
      chars: r.injectedChars,
      systems: r.systemCount,
      sysLen: r.systemLengths.join('/'),
      roles: r.roles.join(','),
      topKeys: r.topLevelKeyCount,
      topOk: !top.extra.length && !top.missing.length,
      reqOk: req.extra.length === 0 && req.missing.length === 0,
      laneInReq: r.laneInsideRequest,
      delta: r.headers['x-perch-call-delta'] === '1',
    };
  });
  if (flag('json')) {
    console.log(JSON.stringify({ officialTopKeys: OFFICIAL_TOP_KEYS, officialRequestKeys: OFFICIAL_REQUEST_KEYS, rows }, null, 2));
  } else {
    console.log(`reference shape: ${referenceTopKeys().length} top-level keys, envelope=${envelopeMode}`);
    console.log('mode           injected  systems  sysLen        roles                     topKeys  shape  req  laneInReq  x-call-delta');
    for (const row of rows) {
      console.log(
        `${row.mode.padEnd(14)} ${String(row.chars).padStart(7)}  ${String(row.systems).padStart(7)}  ${row.sysLen.padEnd(13)} ${row.roles.padEnd(25)} ${String(row.topKeys).padStart(7)}  ${row.topOk ? 'yes  ' : 'NO   '}  ${row.reqOk ? 'yes  ' : 'NO   '}  ${row.laneInReq ? 'YES       ' : 'no        '}  ${row.delta ? 'yes' : 'NO'}`,
      );
    }
    console.log(`\nofficial: ${OFFICIAL_TOP_KEYS.length} top-level keys, ${OFFICIAL_REQUEST_KEYS.length} request keys, no lane inside request, x-perch-call-delta: 1`);
    console.log(`canary text (${CANARY.length} chars): ${promptForMode('canary').slice(0, 96)}…`);
  }
  process.exit(0);
}

const result = run();
if (flag('json')) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(report(result));
}
