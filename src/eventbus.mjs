/**
 * In-process observability bus.
 *
 * Two ring buffers — one for request-flow records, one for graded events — plus
 * a tiny subscriber set that the panel's SSE endpoint drains. Everything is
 * best-effort: a slow panel must never slow an upstream call, so emitters never
 * await, and subscriber errors are swallowed.
 *
 * No dependencies, no persistence. Bounded memory is the point: 5,000 records of
 * each kind is a few MB and survives days of traffic.
 */

const RING_REQUESTS = 5_000;
const RING_EVENTS = 5_000;

const requests = [];
const events = [];
const subscribers = new Set();

let requestSeq = 0;
let eventSeq = 0;

/** Rolling counters for the overview tab. */
export const stats = {
  startedAt: Date.now(),
  total: 0,
  ok: 0,
  http401: 0,
  http403: 0,
  http429: 0,
  http5xx: 0,
  other: 0,
  ttftMsSum: 0,
  ttftSamples: 0,
  inTokens: 0,
  outTokens: 0,
  lastOkAt: null,
  lastFailAt: null,
  lastFailCode: null,
  lastFailMessage: null,
  /** fingerprint -> { ok, http403, http429, other, lastAt, lastStatus } */
  envelopes: new Map(),
};

/** Reset the daily counters (called when the local date rolls over). */
let dayKey = new Date().toISOString().slice(0, 10);
export function rollDay() {
  const today = new Date().toISOString().slice(0, 10);
  if (today === dayKey) return false;
  dayKey = today;
  stats.total = 0;
  stats.ok = 0;
  stats.http401 = 0;
  stats.http403 = 0;
  stats.http429 = 0;
  stats.http5xx = 0;
  stats.other = 0;
  stats.ttftMsSum = 0;
  stats.ttftSamples = 0;
  stats.inTokens = 0;
  stats.outTokens = 0;
  return true;
}

export function today() {
  return dayKey;
}

function pushRing(ring, rec) {
  ring.push(rec);
  if (ring.length > RING_REQUESTS) ring.splice(0, ring.length - RING_REQUESTS);
}

function fanout(rec) {
  for (const fn of subscribers) {
    try {
      fn(rec);
    } catch {
      /* a broken panel view must not break the API */
    }
  }
}

/**
 * Record one graded event.
 * @param {'INFO'|'WARN'|'ERROR'} level
 * @param {object} event  { code, message, ...detail }
 */
export function emit(level, event) {
  const rec = { id: ++eventSeq, at: Date.now(), level, ...event };
  pushRing(events, rec);
  if (level === 'ERROR') {
    stats.lastFailAt = rec.at;
    stats.lastFailCode = rec.code ?? null;
    stats.lastFailMessage = rec.message ?? null;
  }
  fanout({ kind: 'event', rec });
  return rec;
}

/** Record one upstream call and fold it into the counters. */
export function recordRequest(entry) {
  const status = Number(entry.status) || 0;
  const rec = { id: ++requestSeq, at: Date.now(), ...entry, status };
  pushRing(requests, rec);

  stats.total += 1;
  if (status === 200) {
    stats.ok += 1;
    stats.lastOkAt = rec.at;
  } else if (status === 401) stats.http401 += 1;
  else if (status === 403) stats.http403 += 1;
  else if (status === 429) stats.http429 += 1;
  else if (status >= 500) stats.http5xx += 1;
  else stats.other += 1;

  if (status !== 200) {
    stats.lastFailAt = rec.at;
    stats.lastFailCode = rec.code ?? `http_${status}`;
    stats.lastFailMessage = rec.message ?? null;
  }

  if (Number.isFinite(entry.ttftMs) && entry.ttftMs > 0) {
    stats.ttftMsSum += entry.ttftMs;
    stats.ttftSamples += 1;
  }
  if (Number.isFinite(entry.inputTokens)) stats.inTokens += entry.inputTokens;
  if (Number.isFinite(entry.outputTokens)) stats.outTokens += entry.outputTokens;

  if (entry.envelope) {
    const cur = stats.envelopes.get(entry.envelope) ?? { ok: 0, http403: 0, http429: 0, other: 0, lastAt: 0, lastStatus: 0 };
    if (status === 200) cur.ok += 1;
    else if (status === 403) cur.http403 += 1;
    else if (status === 429) cur.http429 += 1;
    else cur.other += 1;
    cur.lastAt = rec.at;
    cur.lastStatus = status;
    stats.envelopes.set(entry.envelope, cur);
  }

  fanout({ kind: 'request', rec });
  return rec;
}

/** Request records with id > since, oldest first. */
export function sinceRequests(since = 0, limit = 200) {
  const out = [];
  for (let i = requests.length - 1; i >= 0 && out.length < limit; i -= 1) {
    if (requests[i].id <= since) break;
    out.push(requests[i]);
  }
  return out.reverse();
}

/** Event records with id > since, oldest first, optionally filtered. */
export function sinceEvents(since = 0, limit = 200, level = null) {
  const out = [];
  for (let i = events.length - 1; i >= 0 && out.length < limit; i -= 1) {
    const rec = events[i];
    if (rec.id <= since) break;
    if (level && rec.level !== level) continue;
    out.push(rec);
  }
  return out.reverse();
}

export function recent(limit = 50) {
  return {
    requests: requests.slice(-limit),
    events: events.slice(-limit),
  };
}

export function subscribe(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export function subscriberCount() {
  return subscribers.size;
}
