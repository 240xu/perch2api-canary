/**
 * Risk guards.
 *
 * Three jobs, all of them "look before you leap":
 *
 *   1. `checkBan` — Perch exposes a self-service deletion page whose payload
 *      carries `blockedReason`. When an account is banned the model-call surface
 *      keeps answering 403 forever, which the old gateway mistook for an auth
 *      problem and retried. Calling this at startup and after any 403 turns
 *      "silent retry storm" into one clear error.
 *
 *   2. `classify403` — not every 403 means the same thing. `banned` is
 *      permanent, `perch_surface_required` is a prompt-envelope problem,
 *      `plan_required` is recoverable by re-selecting a plan. They must not share
 *      a code path.
 *
 *   3. `envelopeFingerprint` — a stable id for "the exact combination of shaping
 *      decisions we sent". The panel keeps a table of fingerprint vs. outcome,
 *      which is the only way to tell which shaping choice actually crosses the
 *      gate.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { config } from './config.mjs';
import { emit } from './eventbus.mjs';

const execFileAsync = promisify(execFile);

/** Upstream surfaces touched by the guards (kept deliberately few). */
export const GUARD_ENDPOINTS = {
  account: '/api/perchai/account',
  deletion: '/api/perch-terminal/account-deletion',
  cliPlan: '/api/perch-terminal/cli-plan',
};

function headers(token) {
  return {
    Accept: 'application/json',
    'User-Agent': config.userAgent,
    'x-perch-locale': config.locale,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

/**
 * Read the account-deletion payload and report whether this account is blocked.
 * Never throws: a guard that breaks the request path is worse than no guard.
 *
 * @returns {Promise<{banned:boolean, blockedReason:string|null, raw:object|null, error:string|null}>}
 */
export async function checkBan({ baseUrl, token, timeoutMs = 15_000 } = {}) {
  const url = `${baseUrl}${GUARD_ENDPOINTS.deletion}`;
  try {
    const res = await fetch(url, { headers: headers(token), signal: AbortSignal.timeout(timeoutMs) });
    const raw = await res.json().catch(() => null);
    const blockedReason = raw?.blockedReason ?? null;
    const banned = String(blockedReason || '').toLowerCase() === 'banned';
    if (banned) {
      emit('ERROR', {
        code: 'banned',
        message: 'Account is banned upstream; refusing to send model calls.',
        blockedReason,
        endpoint: GUARD_ENDPOINTS.deletion,
      });
    }
    return { banned, blockedReason, raw, error: res.ok ? null : `HTTP ${res.status}` };
  } catch (error) {
    return { banned: false, blockedReason: null, raw: null, error: error.message };
  }
}

/**
 * Turn a 403 payload into an actionable category.
 * @param {object|null} payload
 * @returns {'banned'|'surface_required'|'plan_required'|'forbidden'}
 */
export function classify403(payload) {
  const code = String(payload?.errorCode ?? payload?.code ?? '').toLowerCase();
  const text = String(payload?.error ?? payload?.message ?? '').toLowerCase();
  if (code === 'banned' || text.includes('banned')) return 'banned';
  if (code === 'perch_surface_required' || text.includes('surface')) return 'surface_required';
  if (code === 'plan_required' || text.includes('plan_required')) return 'plan_required';
  return 'forbidden';
}

/**
 * Stable id for one shaping combination. Any change to prompt mode, lane, ticket
 * policy, model family or envelope dialect produces a different id, so the panel
 * can attribute outcomes without storing whole bodies.
 */
export function envelopeFingerprint({ lane, promptMode, ticketMode, modelKind, envelopeMode, scrub }) {
  return createHash('sha1')
    .update([lane, promptMode, ticketMode, modelKind, envelopeMode, scrub ? 'scrub' : 'raw'].join('|'))
    .digest('hex')
    .slice(0, 8);
}

/** Path of the installed CLI's package.json, if we can find it. */
export function installedCliPackage() {
  const candidates = [
    process.env.PERCH_CLI_PACKAGE,
    '/opt/node22/lib/node_modules/perchai-cli/package.json',
    path.join(process.cwd(), 'node_modules', 'perchai-cli', 'package.json'),
  ].filter(Boolean);
  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) return file;
    } catch {
      /* unreadable path, try the next */
    }
  }
  return null;
}

/**
 * Compare the version we claim in `User-Agent` with the version actually
 * installed. Claiming a version that is not installed is one of the three
 * reasons Perch gave for the earlier ban, so this mismatch is reported rather
 * than silently tolerated.
 */
export function checkCliVersion() {
  const claimed = (process.env.PERCH_CLI_VERSION || '').trim() || null;
  const file = installedCliPackage();
  let installed = null;
  let error = null;
  if (file) {
    try {
      installed = JSON.parse(fs.readFileSync(file, 'utf8')).version ?? null;
    } catch (err) {
      error = err.message;
    }
  } else {
    error = 'perchai-cli package.json not found';
  }

  let level = 'ok';
  let message = 'User-Agent version matches the installed CLI.';
  if (!installed) {
    level = 'unknown';
    message = `Cannot verify the installed CLI version (${error}); the claimed version is sent as-is.`;
  } else if (!claimed) {
    level = 'unknown';
    message = `PERCH_CLI_VERSION is empty, so the User-Agent degrades to "unknown" (installed ${installed}).`;
  } else if (claimed !== installed) {
    level = 'mismatch';
    message = `PERCH_CLI_VERSION=${claimed} but the installed CLI is ${installed}. Claiming a version that is not installed is a documented ban reason.`;
  }

  if (level === 'mismatch') emit('WARN', { code: 'ua_version_mismatch', message });
  else if (level === 'unknown') emit('INFO', { code: 'ua_version_unknown', message });

  return { claimed, installed, file, level, message };
}

/** Best-effort `npm view` for the published latest version. Never blocks startup. */
export async function latestPublishedVersion(timeoutMs = 8_000) {
  try {
    const { stdout } = await execFileAsync('npm', ['view', 'perchai-cli', 'version'], { timeout: timeoutMs });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}
