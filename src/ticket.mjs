/**
 * Turn tickets.
 *
 * The gateway fetches one before every model call when `PERCH_TICKET_MODE` says so
 * and attaches it as `x-perch-turn-ticket`, then adopts the `runId` the ticket
 * returns — the run id the server will bill against is the ticket's, not ours.
 *
 * The probes did none of that: they built a body, posted it, and reported the
 * result under a `ticketMode` that was never actually exercised. Two callers
 * claiming the same configuration while sending different requests makes every
 * comparison between them meaningless, so the fetch lives here and everybody
 * imports it.
 */

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Ask the server for a ticket.
 *
 * @returns {Promise<{token:string, ticketId:string, runId:string, expiresAt:number}>}
 * @throws an object with `status` and `code` — callers branch on `code`, not text.
 */
export async function requestTurnTicket({ baseUrl, token, userAgent, locale, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const base = String(baseUrl).replace(/\/+$/, '');
  let res;
  try {
    res = await fetch(`${base}/api/perch-terminal/turn-ticket`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        'User-Agent': userAgent,
        'x-perch-locale': locale,
      },
      body: JSON.stringify({ surface: 'cli', profile: 'standard', ticketClient: 2 }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw Object.assign(new Error(`turn-ticket unreachable: ${error?.cause?.code || error.message}`), {
      status: 503, code: 'turn_ticket_network',
    });
  }
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.ticket || !data?.ticketId || !data?.runId) {
    throw Object.assign(new Error(data?.error || `turn ticket HTTP ${res.status}`), {
      status: res.status,
      code: data?.errorCode || 'turn_ticket_unavailable',
    });
  }
  const expiresAt = data.expiresAt ? Date.parse(data.expiresAt) : Date.now() + 300_000;
  return {
    token: data.ticket,
    ticketId: data.ticketId,
    runId: data.runId,
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : Date.now() + 300_000,
  };
}

/**
 * Ticket or no ticket, according to `mode`.
 *
 * `required` throws, `best-effort` returns null and lets the caller continue,
 * `off` never makes the request at all. That distinction is the whole point of
 * the setting, so it is enforced here rather than at each call site.
 *
 * @param {object} options
 * @param {'off'|'best-effort'|'required'} options.mode
 * @param {(info:object)=>void} [options.onWarn] called when a best-effort fetch fails
 */
export async function maybeRequestTurnTicket({ mode, onWarn, ...rest }) {
  if (mode === 'off') return null;
  try {
    return await requestTurnTicket(rest);
  } catch (error) {
    if (mode === 'required') throw error;
    onWarn?.({ code: 'ticket_failed', message: error.message, status: error.status ?? null });
    return null;
  }
}
