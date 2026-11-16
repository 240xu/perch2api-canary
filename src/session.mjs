/**
 * Perch session store.
 *
 * A Perch session is the `cli-auth-session.json` file the official CLI/Desktop
 * writes: { version, appUrl, accessToken, refreshToken, expiresAt, userId, email }.
 * The access token is a Supabase JWT, so refresh goes through the Supabase auth
 * endpoint the app advertises at /api/perch-terminal/cli-auth/config.
 *
 * Three things here exist because of observed failures:
 *
 *  1. **Refresh lock.** Supabase rotates refresh tokens: two concurrent refreshes
 *     mean one of them invalidates the other's brand-new token, which looks like
 *     "it worked for two days and then every call is 401". The official CLI
 *     serialises refreshes with a 15s-wait / 30s-stale / 50ms-poll file lock and
 *     backs off 30s after a failure; the same parameters are used here.
 *
 *  2. **Plan self-heal.** An account whose `planCode` went null while
 *     `tierSelectionRequired` is true answers 403 to every model call. The CLI
 *     recovers by re-selecting the starter plan, so we do the same instead of
 *     reporting an auth error forever.
 *
 *  3. **Usage windows.** `/api/perchai/account` exposes `manual_rolling` windows
 *     (5h and 7d); once either is full the account cannot serve and should be
 *     skipped before the call, not after the 429.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config, SESSION_CANDIDATES, EXTRA_SESSION_FILES } from './config.mjs';
import { emit } from './eventbus.mjs';

const REFRESH_MARGIN_S = 120;
const LOCK_WAIT_MS = 15_000;
const LOCK_STALE_MS = 30_000;
const LOCK_POLL_MS = 50;
const REFRESH_FAIL_BACKOFF_MS = 30_000;
const REVOKED_TTL_MS = 24 * 60 * 60 * 1000;
const ACCOUNT_TTL_MS = 30_000;
/**
 * Retry budget for the token endpoint.
 *
 * MEASURED (2026-11-16, wuming): the Supabase auth host completes a TLS handshake
 * and presents a valid certificate, but ~85% of HTTPS requests to it are reset
 * before a response arrives — 3/20 succeeded, while app.perchai.app, GitHub and npm
 * were 8/8 from the same box. Both Cloudflare anycast IPs behind it behaved the same,
 * so it is the path, not the endpoint.
 *
 * A single attempt therefore fails four times out of five, which looked like a
 * revoked session and was not one. Six attempts at ~1 s spacing makes the expected
 * failure rate 0.85^6 ≈ 0.4% without any longer backoff that would fight the
 * upstream's own rate limits.
 */
const REFRESH_ATTEMPTS = 6;
const REFRESH_RETRY_MS = 900;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class SessionStore {
  /** @param {string[]} files */
  constructor(files) {
    this.slots = files.map((file) => ({
      file,
      session: null,
      inflight: 0,
      lastUsed: 0,
      refreshing: null,
      error: null,
      /** ok | banned | expired | plan_lost | unknown */
      state: 'unknown',
      bannedAt: null,
      blockedReason: null,
      account: null,
      accountAt: 0,
      lastRefreshAt: null,
      refreshCount: 0,
      refreshFailAt: null,
      revokedUntil: 0,
    }));
    this.cursor = 0;
  }

  static discover() {
    const files = [];
    // Explicit PERCH_SESSION_FILES entries win over auto-discovered profiles: the
    // operator named that file, and it is the one we know is writable (the CLI
    // profile under $HOME is read-only under the unit's ProtectHome=read-only).
    for (const p of [...EXTRA_SESSION_FILES, ...SESSION_CANDIDATES]) {
      if (fs.existsSync(p) && !files.includes(p)) files.push(p);
    }
    return new SessionStore(files);
  }

  get size() {
    return this.slots.length;
  }

  async reload() {
    for (const slot of this.slots) await this.#load(slot);
    // Two session files can hold the same account (the CLI profile and a copy in
    // accounts/). Serving the same account twice doubles the request rate against
    // one quota and makes the panel show a phantom second account, so keep the
    // first occurrence of each userId.
    const seen = new Map();
    const kept = [];
    for (const slot of this.slots) {
      const key = slot.session?.userId ?? slot.file;
      if (seen.has(key)) {
        slot.duplicateOf = seen.get(key);
        continue;
      }
      seen.set(key, slot.file);
      kept.push(slot);
    }
    this.slots = kept;
    return this.slots.filter((s) => s.session).length;
  }

  async #load(slot) {
    try {
      const raw = await fsp.readFile(slot.file, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed?.accessToken) throw new Error('session file has no accessToken');
      slot.session = {
        version: parsed.version ?? 1,
        appUrl: (parsed.appUrl || config.appUrl).replace(/\/+$/, ''),
        accessToken: parsed.accessToken,
        refreshToken: parsed.refreshToken ?? null,
        expiresAt: typeof parsed.expiresAt === 'number' ? parsed.expiresAt : null,
        userId: parsed.userId ?? null,
        email: parsed.email ?? null,
        updatedAt: parsed.updatedAt ?? null,
      };
      slot.error = null;
      if (slot.state === 'unknown') slot.state = 'ok';
    } catch (error) {
      slot.session = null;
      slot.error = error.message;
      slot.state = 'expired';
    }
  }

  /** Round-robin across usable slots: least in-flight, then least recently used. */
  pick() {
    const usable = this.slots.filter((s) => s.session
      && s.state !== 'banned'
      && Date.now() >= s.revokedUntil);
    if (!usable.length) {
      const banned = this.slots.find((s) => s.state === 'banned');
      throw Object.assign(new Error(banned
        ? `All Perch sessions are unusable; ${banned.email || banned.file} is banned upstream.`
        : 'No Perch session found. Run `node scripts/login.mjs` or point PERCH_CLI_AUTH_DIR at a logged-in Perch profile.'),
      { code: banned ? 'banned' : 'no_session', status: banned ? 403 : 503 });
    }
    usable.sort((a, b) => (a.inflight - b.inflight) || (a.lastUsed - b.lastUsed));
    const slot = usable[0];
    slot.inflight += 1;
    slot.lastUsed = Date.now();
    return { slot, release: () => { slot.inflight = Math.max(0, slot.inflight - 1); } };
  }

  // ---- refresh lock ------------------------------------------------------

  #lockPath(slot) {
    return `${slot.file}.refresh.lock`;
  }

  async #acquireLock(slot) {
    const file = this.#lockPath(slot);
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        await fsp.writeFile(file, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: 'wx', mode: 0o600 });
        return true;
      } catch (error) {
        if (error.code !== 'EEXIST') return false;
      }
      try {
        const stat = await fsp.stat(file);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          await fsp.rm(file, { force: true });
          continue;
        }
      } catch {
        /* the holder released it between our write and our stat */
        continue;
      }
      if (Date.now() > deadline) return false;
      await sleep(LOCK_POLL_MS);
    }
  }

  async #releaseLock(slot) {
    await fsp.rm(this.#lockPath(slot), { force: true }).catch(() => {});
  }

  // ---- tokens ------------------------------------------------------------

  /** Return a valid access token for the slot, refreshing when it is close to expiry. */
  async token(slot, { force = false } = {}) {
    const session = slot.session;
    if (!session) throw Object.assign(new Error('session slot is empty'), { code: 'no_session' });
    if (Date.now() < slot.revokedUntil) {
      throw Object.assign(new Error('refresh token was revoked; log in again'), { code: 'session_revoked', status: 401 });
    }
    const now = Math.floor(Date.now() / 1000);
    const expired = !session.expiresAt || session.expiresAt <= now + REFRESH_MARGIN_S;
    if (!expired && !force) return session.accessToken;
    if (!session.refreshToken) {
      if (!expired) return session.accessToken;
      throw Object.assign(new Error('Perch session expired and has no refresh token. Log in again.'),
        { code: 'session_expired', status: 401 });
    }
    // In-process coalescing. The file lock below covers a second process.
    if (!slot.refreshing) slot.refreshing = this.#refreshWithLock(slot).finally(() => { slot.refreshing = null; });
    await slot.refreshing;
    return slot.session?.accessToken ?? null;
  }

  async #refreshWithLock(slot) {
    const acquired = await this.#acquireLock(slot);
    try {
      // Someone may have refreshed while we waited: re-read before doing work,
      // because a second refresh would invalidate their rotating token.
      const before = slot.session?.accessToken;
      await this.#load(slot);
      const now = Math.floor(Date.now() / 1000);
      const fresh = slot.session?.expiresAt && slot.session.expiresAt > now + REFRESH_MARGIN_S;
      if (slot.session?.accessToken && slot.session.accessToken !== before && fresh) {
        return;
      }
      if (fresh) return;
      await this.#refresh(slot);
    } finally {
      if (acquired) await this.#releaseLock(slot);
    }
  }

  async #refresh(slot) {
    const session = slot.session;
    if (!session?.refreshToken) return;
    const base = session.appUrl || config.appUrl;

    // A transport failure here is not the same as a rejected token, and it must not
    // escape as a bare `fetch failed`: callers branch on `code`.
    const netFail = (stage, error) => Object.assign(
      new Error(`token refresh network failure at ${stage}: ${error?.cause?.code || error?.message || error} after ${REFRESH_ATTEMPTS} attempt(s)`),
      { code: 'refresh_network', status: 503, cause: error },
    );

    /**
     * Retry only connection-level failures. An HTTP status is an answer and is
     * handled by the caller; a reset is not an answer.
     *
     * The abort signal is created per attempt: `AbortSignal.timeout()` starts ticking
     * when constructed, so sharing one instance across retries makes every attempt
     * after the first abort immediately.
     */
    const fetchWithRetry = async (url, { timeoutMs, ...init }, stage) => {
      let lastError = null;
      for (let attempt = 1; attempt <= REFRESH_ATTEMPTS; attempt += 1) {
        try {
          return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
        } catch (error) {
          lastError = error;
          if (attempt < REFRESH_ATTEMPTS) await sleep(REFRESH_RETRY_MS);
        }
      }
      slot.refreshFailAt = Date.now();
      emit('WARN', {
        code: 'refresh_network',
        message: `${stage} unreachable after ${REFRESH_ATTEMPTS} attempts: ${lastError?.cause?.code || lastError?.message}`,
        file: slot.file,
      });
      throw netFail(stage, lastError);
    };

    const cfgRes = await fetchWithRetry(`${base}/api/perch-terminal/cli-auth/config`, {
      timeoutMs: 15_000,
      headers: { Accept: 'application/json', 'User-Agent': config.userAgent },
    }, 'cli-auth/config');
    if (!cfgRes.ok) throw new Error(`cli-auth/config HTTP ${cfgRes.status}`);
    const cfg = await cfgRes.json();
    if (!cfg?.supabaseUrl || !cfg?.supabaseAnonKey) throw new Error('cli-auth/config missing supabase credentials');

    const res = await fetchWithRetry(`${cfg.supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
      timeoutMs: 20_000,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: cfg.supabaseAnonKey,
        Authorization: `Bearer ${cfg.supabaseAnonKey}`,
      },
      body: JSON.stringify({ refresh_token: session.refreshToken }),
    }, 'supabase /token');
    const body = await res.json().catch(() => null);
    if (!res.ok || !body?.access_token) {
      const message = `token refresh failed: HTTP ${res.status} ${body?.error_description || body?.error || ''}`.trim();
      const revoked = /invalid_grant|refresh_token_not_found|already used|revoked/i.test(
        `${body?.error || ''} ${body?.error_description || ''} ${body?.msg || ''}`,
      );
      if (revoked) {
        slot.revokedUntil = Date.now() + REVOKED_TTL_MS;
        slot.state = 'expired';
        emit('ERROR', {
          code: 'refresh_revoked',
          message: 'Refresh token was rejected as already used or revoked; re-login required.',
          file: slot.file,
        });
      }
      slot.refreshFailAt = Date.now();
      emit('WARN', { code: 'refresh_failed', message, file: slot.file });
      throw Object.assign(new Error(message), { code: 'refresh_failed', status: 401 });
    }

    const next = {
      ...session,
      accessToken: body.access_token,
      refreshToken: body.refresh_token ?? session.refreshToken,
      expiresAt: typeof body.expires_at === 'number'
        ? body.expires_at
        : Math.floor(Date.now() / 1000) + (body.expires_in ?? 3600),
      userId: body.user?.id ?? session.userId,
      email: body.user?.email ?? session.email,
      updatedAt: new Date().toISOString(),
    };
    await this.#persist(slot, next);
    slot.lastRefreshAt = Date.now();
    slot.refreshCount += 1;
    emit('INFO', { code: 'token_refreshed', message: 'Access token refreshed.', file: slot.file });
  }

  async #persist(slot, session) {
    slot.session = session;
    try {
      await fsp.mkdir(path.dirname(slot.file), { recursive: true, mode: 0o700 });
      const tmp = `${slot.file}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify(session, null, 0), { mode: 0o600 });
      await fsp.rename(tmp, slot.file);
    } catch (error) {
      slot.error = `could not persist refreshed session: ${error.message}`;
    }
  }

  // ---- account / plan / usage -------------------------------------------

  async #fetchAccount(slot, token, { force = false } = {}) {
    if (!force && slot.account && Date.now() - slot.accountAt < ACCOUNT_TTL_MS) return slot.account;
    const base = (slot.session?.appUrl || config.appUrl).replace(/\/+$/, '');
    const res = await fetch(`${base}/api/perchai/account`, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        'User-Agent': config.userAgent,
        'x-perch-locale': config.locale,
      },
      signal: AbortSignal.timeout(15_000),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      throw Object.assign(new Error(`account HTTP ${res.status}`), { status: res.status, code: 'account_failed' });
    }
    slot.account = data;
    slot.accountAt = Date.now();
    return data;
  }

  /**
   * `manual_rolling` windows: 5h and 7d. Either one being full means the account
   * cannot serve, which is worth knowing before spending a call on it.
   */
  static manualWindowState(data) {
    const meter = data?.usageMeter ?? {};
    const m = meter.manual_rolling ?? meter.manualRolling ?? null;
    if (!m || m.enabled === false) {
      return { enabled: false, exhausted: false, reason: null, nextFreedAt: null, windows: [] };
    }
    const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
    const windows = [
      { id: '5h', used: num(m.window5hUsd), cap: num(m.window5hCapUsd), next: m.window5hNextFreedAt ?? null },
      { id: '7d', used: num(m.window7dUsd), cap: num(m.window7dCapUsd), next: m.window7dNextFreedAt ?? null },
    ];
    const full = (w) => w.cap != null && w.cap > 0 && w.used != null && w.used >= w.cap - 1e-9;
    const reasons = windows.filter(full).map((w) => `${w.id} ${w.used.toFixed(2)}/${w.cap}`);
    const nexts = windows.map((w) => (w.next ? Date.parse(w.next) : NaN)).filter(Number.isFinite);
    return {
      enabled: true,
      exhausted: reasons.length > 0,
      reason: reasons.length ? reasons.join(' / ') : null,
      nextFreedAt: nexts.length ? new Date(Math.min(...nexts)).toISOString() : null,
      windows,
    };
  }

  /** Account snapshot for the panel, plus the derived plan/usage state. */
  async accountInfo(slot, { force = false } = {}) {
    const token = await this.token(slot);
    const account = await this.#fetchAccount(slot, token, { force });
    const windows = SessionStore.manualWindowState(account);
    return {
      email: account?.email ?? slot.session?.email ?? null,
      userId: account?.userId ?? account?.user?.id ?? slot.session?.userId ?? null,
      planCode: account?.planCode ?? null,
      tierSelectionRequired: account?.tierSelectionRequired ?? null,
      blockedReason: account?.blockedReason ?? null,
      usage: windows,
      raw: account,
    };
  }

  /**
   * Re-select the starter plan when the account lost its plan.
   * Returns {repaired, changed, planCode}.
   */
  async healPlan(slot) {
    const info = await this.accountInfo(slot, { force: true });
    if (info.planCode || info.tierSelectionRequired !== true) {
      return { repaired: false, changed: false, planCode: info.planCode };
    }
    const base = (slot.session?.appUrl || config.appUrl).replace(/\/+$/, '');
    const token = await this.token(slot);
    const headers = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'User-Agent': config.userAgent,
      'x-perch-locale': config.locale,
    };
    const planRes = await fetch(`${base}/api/perch-terminal/cli-plan`, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    const plan = await planRes.json().catch(() => null);
    const noticeVersion = plan?.starter?.noticeVersion ?? plan?.noticeVersion ?? null;
    if (!planRes.ok || noticeVersion == null) {
      emit('WARN', {
        code: 'plan_heal_unavailable',
        message: `cli-plan did not expose a starter noticeVersion (HTTP ${planRes.status}).`,
        file: slot.file,
      });
      slot.state = 'plan_lost';
      return { repaired: false, changed: false, planCode: null };
    }
    const post = await fetch(`${base}/api/perch-terminal/cli-plan`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ plan: 'starter', noticeVersion }),
      signal: AbortSignal.timeout(20_000),
    });
    const applied = await post.json().catch(() => null);
    const after = await this.accountInfo(slot, { force: true });
    slot.state = after.planCode ? 'ok' : 'plan_lost';
    emit(after.planCode ? 'INFO' : 'WARN', {
      code: after.planCode ? 'plan_healed' : 'plan_heal_failed',
      message: after.planCode
        ? `Re-selected the starter plan; planCode is now ${after.planCode}.`
        : `Plan re-selection returned HTTP ${post.status} but planCode is still null.`,
      file: slot.file,
      response: applied,
    });
    return { repaired: Boolean(after.planCode), changed: true, planCode: after.planCode };
  }

  /** Mark a slot banned and stop selecting it. */
  markBanned(slot, blockedReason = 'banned') {
    slot.state = 'banned';
    slot.bannedAt = Date.now();
    slot.blockedReason = blockedReason;
    emit('ERROR', {
      code: 'banned',
      message: 'Session marked banned; no further calls will be sent with it.',
      file: slot.file,
      blockedReason,
    });
  }

  describe() {
    return this.slots.map((slot) => ({
      file: slot.file,
      email: slot.session?.email ?? null,
      userId: slot.session?.userId ?? null,
      expiresAt: slot.session?.expiresAt ?? null,
      ok: Boolean(slot.session),
      error: slot.error,
      inflight: slot.inflight,
      state: slot.state,
      bannedAt: slot.bannedAt,
      blockedReason: slot.blockedReason,
      planCode: slot.account?.planCode ?? null,
      tierSelectionRequired: slot.account?.tierSelectionRequired ?? null,
      usage: slot.account ? SessionStore.manualWindowState(slot.account) : null,
      refreshCount: slot.refreshCount,
      lastRefreshAt: slot.lastRefreshAt,
      lastUsed: slot.lastUsed || null,
    }));
  }
}
