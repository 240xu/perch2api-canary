/**
 * Perch model-call transport.
 *
 * Endpoint (OBSERVED): POST {appUrl}/api/perch-terminal/model-call
 * Headers: Authorization: Bearer <supabase access token>
 *          User-Agent: perchai-cli/<version>
 *          x-perch-locale: en
 *          Accept: text/event-stream
 *          x-perch-call-delta: 1        (optional: enables held-context deltas)
 * Body (honeypot dialect, the default — eight top-level keys, no extras):
 *        { request: { messages, tools?, temperature, maxTokens, toolChoice },
 *          runId, lane, strictManual, preferredModelId, avoidModelIds,
 *          attribution, clientSurface }
 *        `PERCH_ENVELOPE_MODE=magpie` additionally emits resendAfterOutput,
 *        roostReasoning/effort, manualModelOptionId and request.preferredModelId.
 *
 * Response: text/event-stream of JSON events —
 *   {"type":"reasoning_delta","text":...}
 *   {"type":"answer_delta","text":...}
 *   {"type":"tool_call_delta","toolCalls":[...]}
 *   {"type":"stream_restart"} | {"type":"continuation_seam","at":n}
 *   {"type":"model_call_failed",...}
 *   {"type":"done","ok":true,"text","content","toolCalls","finishReason",
 *                  "provider","model","durationMs","usage":{...}}
 */
import { config } from './config.mjs';

export class PerchError extends Error {
  constructor(message, { status = 0, code = 'perch_error', limit = null } = {}) {
    super(message);
    this.name = 'PerchError';
    this.status = status;
    this.code = code;
    this.limit = limit;
  }
}

/**
 * Build the upstream body from already-normalised messages + options.
 *
 * The authority for this shape is a captured official call
 * (`honeypot/…-model-call`, 2026-10-13), whose top level has exactly eight keys:
 *
 *   request, runId, lane, strictManual, preferredModelId, avoidModelIds,
 *   attribution, clientSurface
 *
 * and whose `request` has only messages/tools/temperature/maxTokens/toolChoice.
 * Three deviations from that shape were in the previous build and are the
 * cheapest possible things for the server to notice:
 *
 *   - `resendAfterOutput` at the top level (not in the capture),
 *   - `stop` inside `request` (not in the capture),
 *   - `preferredModelId` sent only for pins (the capture always carries one).
 *
 * `PERCH_ENVELOPE_MODE=magpie` reproduces the newer 2.4.132 reconstruction
 * instead, for A/B testing on a live account. The panel shows both fingerprints
 * side by side so the outcome is attributable.
 */
export function buildRequestBody({
  messages, tools, toolChoice, maxTokens, temperature, stop,
  model, runId, reasoning, attribution, lane,
}) {
  const mode = config.envelopeMode;
  const magpie = mode === 'magpie';

  const request = { messages };
  if (Array.isArray(tools) && tools.length) {
    request.tools = tools;
    request.temperature = Number.isFinite(temperature) ? temperature : undefined;
    request.maxTokens = Number.isFinite(maxTokens) ? maxTokens : undefined;
    request.toolChoice = toolChoice || 'auto';
  } else {
    if (Number.isFinite(temperature)) request.temperature = temperature;
    if (Number.isFinite(maxTokens)) request.maxTokens = maxTokens;
  }
  // The capture has no `stop`, so it is only forwarded in the dialect that also
  // reintroduces the other extras. Callers that need it can use magpie mode.
  if (magpie && Array.isArray(stop) && stop.length) request.stop = stop;
  // `request.reasoning` and `request.preferredModelId` were measured absent in 14/14
  // captures of 2.4.108 through 2.4.134. Sending either is a tell, so neither is
  // emitted here even when a caller asks for reasoning; reasoning travels as the
  // top-level `roostReasoning` / `effort` pair instead.

  const body = {
    request,
    runId,
    lane: lane || config.lane,
    strictManual: false,
    // Always present. Measured null in every capture, including when a model is
    // pinned — the pin travels in `manualModelOptionId`, never here.
    preferredModelId: null,
    avoidModelIds: [],
    attribution,
    clientSurface: config.clientSurface,
  };

  // Present since 2.4.114. `magpie` emits it unconditionally because every modern
  // capture carries it; `honeypot` deliberately omits it to reproduce the 2.4.108
  // shape byte for byte, which is the only reason that dialect still exists.
  // Assigned before the effort block so key order matches the wire: `resendAfterOutput`
  // precedes `roostModelChoice` / `roostReasoning` / `effort` in every capture.
  if (magpie) body.resendAfterOutput = true;

  // Measured: `effort` / `roostModelChoice` / `roostReasoning` appear together or not
  // at all, and the only trigger is whether the CLI was invoked with `--effort`.
  // roostReasoning is derived server-side as `effort.level !== 'off'`. The official
  // default (no flag) sends none of the three, so we do the same unless asked.
  if (config.sendRoostExtras) {
    const level = config.effortLevel;
    body.roostModelChoice = model.roostModelChoice || 'standard';
    body.roostReasoning = level !== 'off';
    body.effort = { level, orchestration: false };
  }

  // Measured: sent whenever a model is pinned, unconditionally — not only in one
  // envelope dialect. `preferredModelId` stays null in that case. Gated on `magpie`
  // because 2.4.108 predates the key; the honeypot dialect must stay 8 keys.
  if (model.kind === 'pin' && magpie) {
    body.manualModelOptionId = model.preferredModelId;
  }


  // Cheap regression guard: a lane inside `request` makes Perch treat the call
  // as coming from somewhere other than its own CLI and answer
  // `perch_surface_required`. This assertion has caught it once already.
  if (Object.prototype.hasOwnProperty.call(request, 'lane')) {
    throw new Error('buildRequestBody: lane must never appear inside request');
  }

  return body;
}

function parseSseChunk(buffer, onEvent) {
  const lines = buffer.split('\n');
  const rest = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload) continue;
    try {
      onEvent(JSON.parse(payload));
    } catch {
      /* keepalive or partial frame — ignore */
    }
  }
  return rest;
}

/**
 * Execute one model call and drive `onEvent` for every streamed frame.
 * Resolves with the terminal `done` frame (or throws PerchError).
 */
export async function callModel({
  baseUrl,
  token,
  ticket,
  body,
  signal,
  onEvent,
  onRetry,
}) {
  let attempt = 0;
  let lastError = null;

  for (;;) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('perch request timeout')), config.requestTimeoutMs);
    const onAbort = () => controller.abort(signal?.reason ?? new Error('client aborted'));
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    let sawEvent = false;
    try {
      if (process.env.PERCH_DEBUG_WIRE === '1') {
        console.log('[wire]', `${baseUrl}/api/perch-terminal/model-call`,
          'ticket=', ticket?.ticketId ?? 'none', 'ticketRun=', ticket?.runId ?? 'none',
          'bodyRun=', body?.runId ?? 'none', 'bytes=', JSON.stringify(body).length,
          'syslen=', body?.request?.messages?.[0]?.content?.length ?? 0,
          'roles=', (body?.request?.messages || []).map((m) => m.role).join(','));
      }
      const response = await fetch(`${baseUrl}/api/perch-terminal/model-call`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          Authorization: `Bearer ${token}`,
          'User-Agent': config.userAgent,
          'x-perch-locale': config.locale,
          'x-perch-call-delta': '1',
          ...(ticket?.token ? { 'x-perch-turn-ticket': ticket.token } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const raw = await response.text().catch(() => '');
        let payload = null;
        try { payload = JSON.parse(raw); } catch { /* non-JSON error page */ }
        const error = new PerchError(
          payload?.error || `Perch model-call failed: HTTP ${response.status}`,
          { status: response.status, code: payload?.errorCode || `http_${response.status}`, limit: payload?.limit ?? null },
        );
        // 401 = stale token: caller can refresh and retry once.
        if (response.status === 401) throw Object.assign(error, { retryable: false, auth: true });
        // 429 / 403 plan refusals are terminal.
        if (response.status === 429 || response.status === 403) throw Object.assign(error, { retryable: false });
        if (response.status >= 500 || response.status === 408 || response.status === 425) {
          throw Object.assign(error, { retryable: true });
        }
        throw error;
      }
      if (!response.body) throw new PerchError('Perch returned an empty body', { status: 502 });

      // The delta protocol announces itself in response headers; surfacing them
      // lets the panel show whether the server considers this a held-context turn.
      const meta = {
        callDelta: response.headers.get('x-perch-call-delta'),
        heldLength: response.headers.get('x-perch-call-held-length'),
        heldDigest: response.headers.get('x-perch-call-held-digest'),
        heldTools: response.headers.get('x-perch-call-held-tools'),
      };

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let done = null;

      try {
        for (;;) {
          const { value, done: eof } = await reader.read();
          if (eof) break;
          buffer += decoder.decode(value, { stream: true });
          buffer = parseSseChunk(buffer, (event) => {
            sawEvent = true;
            if (event.type === 'done') {
              done = event;
            } else {
              onEvent(event);
            }
          });
        }
        if (buffer.trim()) {
          parseSseChunk(`${buffer}\n`, (event) => {
            sawEvent = true;
            if (event.type === 'done') done = event;
            else onEvent(event);
          });
        }
      } finally {
        reader.cancel().catch(() => {});
        reader.releaseLock?.();
      }

      if (!done) {
        throw Object.assign(new PerchError('Perch stream ended without a done event', { status: 502, code: 'incomplete_stream' }),
          { retryable: !sawEvent });
      }
      if (done.ok === false) {
        throw new PerchError(done.error || 'Perch reported a failed model call',
          { status: 502, code: done.errorCode || 'model_call_failed', limit: done.limit ?? null });
      }
      return { ...done, meta };
    } catch (error) {
      lastError = error;
      const aborted = signal?.aborted;
      if (aborted) throw Object.assign(new PerchError('client aborted', { status: 499, code: 'client_aborted' }), { aborted: true });
      const retryable = error?.retryable === true || (error?.name === 'AbortError');
      if (!retryable || attempt >= config.maxRetries || sawEvent) throw normalizeError(error);
      attempt += 1;
      onRetry?.(attempt, error);
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (attempt - 1)));
    } finally {
      clearTimeout(timeout);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }
}

function normalizeError(error) {
  if (error instanceof PerchError) return error;
  if (error?.name === 'AbortError' || /timeout|aborted/i.test(error?.message || '')) {
    return new PerchError('Perch request timed out', { status: 504, code: 'timeout' });
  }
  return new PerchError(error?.message || 'Perch request failed', { status: 502, code: 'transport_error' });
}

/** Plan / usage snapshot for the account behind a session. */
export async function fetchAccount({ baseUrl, token, signal }) {
  const res = await fetch(`${baseUrl}/api/perchai/account`, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      'User-Agent': config.userAgent,
      'x-perch-locale': config.locale,
    },
    signal: signal ?? AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new PerchError(`account HTTP ${res.status}`, { status: res.status, code: 'account_failed' });
  return res.json();
}
