/**
 * One model-call, sent the way the gateway sends it.
 *
 * The panel's matrix runner and `scripts/probe-matrix.mjs` both need to make a
 * single call with a chosen prompt mode / envelope / lane. Both used to build the
 * body themselves, and both got the same detail wrong (no turn ticket), which made
 * their results incomparable with the gateway's own traffic.
 *
 * Keeping the construction here means a change to the wire format is made once and
 * every caller inherits it — including the ticket, the run-id adoption, and the
 * header set.
 */
import { buildRequestBody } from './gateway.mjs';
import { normalizeMessages } from './openai.mjs';
import { resolveModel } from './models.mjs';
import { classify403 } from './guard.mjs';
import { maybeRequestTurnTicket } from './ticket.mjs';
import { config } from './config.mjs';

/** Pull the first streamed text out of a raw SSE body, for quick reporting. */
function firstDeltaOf(raw) {
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data:')) continue;
    try {
      const event = JSON.parse(line.slice(5).trim());
      if (event.type === 'answer_delta' && event.text) return event.text;
      if (event.type === 'done' && typeof event.text === 'string' && event.text) return event.text;
    } catch { /* keepalive or partial frame */ }
  }
  return null;
}

/**
 * Send one call. Never throws for an upstream answer — a 403 is a result, not an
 * exception. Only a transport failure rejects, and it is tagged with `status: 0`.
 *
 * @returns {Promise<{
 *   status:number, category:string|null, errorCode:string|null, error:string|null,
 *   firstDelta:string|null, ticket:{id:string,runId:string}|null, ms:number, raw:string
 * }>}
 */
export async function sendModelCallOnce({
  baseUrl,
  token,
  prompt,
  mode,
  lane,
  envelopeMode,
  userId = null,
  timeoutMs = 180_000,
  ticketMode = config.ticketMode,
}) {
  const base = String(baseUrl).replace(/\/+$/, '');
  const started = Date.now();

  const ticket = await maybeRequestTurnTicket({
    mode: ticketMode,
    baseUrl: base,
    token,
    userAgent: config.userAgent,
    locale: config.locale,
  });

  const previous = { promptMode: config.promptMode, lane: config.lane, envelopeMode: config.envelopeMode };
  config.promptMode = mode;
  config.lane = lane;
  if (envelopeMode) config.envelopeMode = envelopeMode;

  let body;
  try {
    const messages = normalizeMessages([{ role: 'user', content: prompt }], { mode });
    const runId = ticket?.runId || `probe-${Date.now().toString(36)}`;
    body = buildRequestBody({
      messages,
      tools: null,
      toolChoice: null,
      maxTokens: 512,
      temperature: 0.2,
      stop: null,
      model: resolveModel('perch'),
      runId,
      reasoning: null,
      attribution: {
        userId,
        workspaceId: process.env.PERCH_WORKSPACE_ID || null,
        runId,
        lane,
        source: 'cli',
        billingMultiplier: null,
      },
      lane,
    });
  } finally {
    config.promptMode = previous.promptMode;
    config.lane = previous.lane;
    config.envelopeMode = previous.envelopeMode;
  }

  let res;
  try {
    res = await fetch(`${base}/api/perch-terminal/model-call`, {
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
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw Object.assign(new Error(`model-call transport failure: ${error?.cause?.code || error.message}`), {
      status: 0, code: 'transport_error', body,
    });
  }

  const raw = await res.text().catch(() => '');
  let payload = null;
  try { payload = JSON.parse(raw); } catch { /* SSE */ }

  return {
    status: res.status,
    category: res.status === 403 ? classify403(payload) : null,
    errorCode: payload?.errorCode ?? null,
    error: payload?.error ?? null,
    firstDelta: firstDeltaOf(raw),
    ticket: ticket ? { id: ticket.ticketId, runId: ticket.runId } : null,
    ms: Date.now() - started,
    raw,
    body,
  };
}
