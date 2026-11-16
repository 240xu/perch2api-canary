/**
 * Developer panel for perch2api.
 *
 * A single loopback HTTP server with an inlined page: no build step, no static
 * assets, nothing to keep in sync. It is deliberately *not* exposed publicly —
 * reach it with `ssh -L 8802:127.0.0.1:8802 wx` and open
 * http://127.0.0.1:8802/?k=<PERCH2API_KEY>.
 *
 * What it is for: the earlier ban was diagnosed as an auth problem because the
 * gateway had no visibility at all. Every decision this process makes — prompt
 * mode, lane, ticket policy, envelope dialect, guards, grader category — is
 * readable here, and the fields that can be changed safely can be changed
 * without a restart.
 */
import http from 'node:http';
import { createHash } from 'node:crypto';

import { config, RUNTIME_FIELDS, writeRuntimeOverride, readRuntimeOverrides } from './config.mjs';
import {
  CANARY, PERCH_SYSTEM_PREFIX, PERCH_AGENTS_PREFIX, PROMPT_MODES, promptForMode, describeMode,
} from './perch-prefix.mjs';
import { buildRequestBody } from './gateway.mjs';
import { normalizeMessages, scrubIdentity } from './openai.mjs';
import { resolveModel } from './models.mjs';
import { emit, sinceRequests, sinceEvents, subscribe, stats, today } from './eventbus.mjs';
import { checkBan, classify403, checkCliVersion, latestPublishedVersion } from './guard.mjs';
import { SessionStore } from './session.mjs';

const PROBE_MIN_GAP_MS = 30_000;
let lastProbeAt = 0;

function json(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = 1 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        return resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function authorized(req, url) {
  if (!config.apiKey) return true;
  const header = req.headers.authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const query = url.searchParams.get('k') || '';
  return bearer === config.apiKey || query === config.apiKey;
}

/** Build the exact body a call would send, without sending it. */
function inspect({ mode, lane, model, envelopeMode, callerSystem, userText, ticketMode }) {
  const effectiveMode = mode || config.promptMode;
  const previous = { promptMode: config.promptMode, envelopeMode: config.envelopeMode, lane: config.lane };
  config.promptMode = effectiveMode;
  if (envelopeMode) config.envelopeMode = envelopeMode;
  try {
    const resolved = resolveModel(model || 'perch');
    const messages = normalizeMessages([
      ...(callerSystem ? [{ role: 'system', content: callerSystem }] : []),
      { role: 'user', content: userText || 'Say hello in five words.' },
    ], { mode: effectiveMode });
    const body = buildRequestBody({
      messages,
      tools: null,
      toolChoice: null,
      maxTokens: 1024,
      temperature: 0.6,
      stop: null,
      model: resolved,
      runId: 'inspect-0000',
      reasoning: null,
      attribution: {
        userId: 'inspect',
        workspaceId: process.env.PERCH_WORKSPACE_ID || null,
        runId: 'inspect-0000',
        lane: lane || config.lane,
        source: 'cli',
        billingMultiplier: null,
      },
      lane: lane || config.lane,
    });
    const systemMessages = body.request.messages.filter((m) => m.role === 'system');
    return {
      promptMode: effectiveMode,
      promptModeDescription: describeMode(effectiveMode),
      injectedChars: promptForMode(effectiveMode).length,
      canaryChars: CANARY.length,
      systemCount: systemMessages.length,
      systemLengths: systemMessages.map((m) => (typeof m.content === 'string' ? m.content.length : -1)),
      systemHead: systemMessages.map((m) => String(m.content ?? '').slice(0, 120)),
      roles: body.request.messages.map((m) => m.role),
      topLevelKeys: Object.keys(body),
      topLevelKeyCount: Object.keys(body).length,
      requestKeys: Object.keys(body.request),
      laneAtTop: body.lane,
      laneInsideRequest: Object.prototype.hasOwnProperty.call(body.request, 'lane'),
      hasResendAfterOutput: Object.prototype.hasOwnProperty.call(body, 'resendAfterOutput'),
      hasStop: Object.prototype.hasOwnProperty.call(body.request, 'stop'),
      preferredModelId: body.preferredModelId,
      manualModelOptionId: body.manualModelOptionId ?? null,
      roostModelChoice: body.roostModelChoice ?? null,
      roostReasoning: body.roostReasoning ?? null,
      effort: body.effort ?? null,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        'User-Agent': config.userAgent,
        'x-perch-locale': config.locale,
        'x-perch-call-delta': '1',
        'x-perch-turn-ticket': ticketMode === 'off' ? null : '<minted when the call runs>',
      },
      attribution: body.attribution,
      bodyBytes: JSON.stringify(body).length,
      scrub: (() => {
        if (!callerSystem) return null;
        const { hits } = scrubIdentity(callerSystem);
        return { callerSystemChars: callerSystem.length, identityHits: hits };
      })(),
      body,
    };
  } finally {
    config.promptMode = previous.promptMode;
    config.envelopeMode = previous.envelopeMode;
    config.lane = previous.lane;
  }
}

const PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>perch2api · developer panel</title>
<style>
  :root { color-scheme: dark; --bg:#0f1115; --panel:#171a21; --line:#252a34; --text:#e6e9ef; --dim:#8b93a3;
          --ok:#3fb950; --warn:#d29922; --err:#f85149; --accent:#58a6ff; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; }
  header { display:flex; gap:16px; align-items:center; padding:10px 16px; border-bottom:1px solid var(--line); background:var(--panel); flex-wrap:wrap; }
  header .brand { font-weight:700; letter-spacing:.5px; }
  .pill { padding:2px 8px; border-radius:10px; border:1px solid var(--line); color:var(--dim); }
  .pill.ok { color:var(--ok); border-color:var(--ok); }
  .pill.warn { color:var(--warn); border-color:var(--warn); }
  .pill.err { color:var(--err); border-color:var(--err); }
  nav { display:flex; gap:4px; padding:8px 16px 0; border-bottom:1px solid var(--line); background:var(--panel); flex-wrap:wrap; }
  nav button { background:none; border:1px solid transparent; border-bottom:none; color:var(--dim); padding:6px 12px; cursor:pointer; font:inherit; border-radius:6px 6px 0 0; }
  nav button.active { color:var(--text); background:var(--bg); border-color:var(--line); }
  main { padding:16px; }
  section { display:none; }
  section.active { display:block; }
  h2 { font-size:13px; text-transform:uppercase; letter-spacing:1px; color:var(--dim); margin:22px 0 8px; }
  table { border-collapse:collapse; width:100%; }
  th, td { text-align:left; padding:4px 8px; border-bottom:1px solid var(--line); white-space:nowrap; }
  th { color:var(--dim); font-weight:500; }
  td.wrap { white-space:normal; word-break:break-word; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); gap:12px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:12px; }
  .kv { display:flex; justify-content:space-between; gap:12px; padding:2px 0; }
  .kv span:first-child { color:var(--dim); }
  .ok { color:var(--ok); } .warn { color:var(--warn); } .err { color:var(--err); } .dim { color:var(--dim); }
  .bar { height:6px; background:#242a35; border-radius:3px; overflow:hidden; margin-top:4px; }
  .bar > i { display:block; height:100%; background:var(--accent); }
  button.act { background:#21262d; border:1px solid var(--line); color:var(--text); padding:4px 10px; border-radius:6px; cursor:pointer; font:inherit; }
  button.act:hover { border-color:var(--accent); }
  button.act.danger { border-color:var(--err); color:var(--err); }
  input, select, textarea { background:#0b0d11; color:var(--text); border:1px solid var(--line); border-radius:6px; padding:4px 8px; font:inherit; }
  textarea { width:100%; min-height:70px; }
  pre { background:#0b0d11; border:1px solid var(--line); border-radius:6px; padding:10px; overflow:auto; max-height:420px; }
  .row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin:6px 0; }
  .tag { font-size:11px; padding:1px 6px; border-radius:4px; border:1px solid var(--line); }
  .tag.INFO { color:var(--accent); } .tag.WARN { color:var(--warn); } .tag.ERROR { color:var(--err); }
</style>
</head>
<body>
<header>
  <span class="brand">perch2api</span>
  <span id="pill-run" class="pill">…</span>
  <span id="pill-breaker" class="pill">…</span>
  <span id="pill-conc" class="pill">…</span>
  <span id="pill-account" class="pill">…</span>
  <span class="dim" id="pill-ua"></span>
  <span style="flex:1"></span>
  <button class="act" id="btn-pause">暂停</button>
  <button class="act" id="btn-refresh">刷新</button>
</header>
<nav>
  <button data-tab="overview" class="active">概览</button>
  <button data-tab="flow">流水</button>
  <button data-tab="events">事件</button>
  <button data-tab="switches">开关</button>
  <button data-tab="diag">诊断</button>
  <button data-tab="redline">红线</button>
</nav>
<main>
  <section id="overview" class="active">
    <div class="grid" id="ov-cards"></div>
    <h2>账号</h2>
    <div id="ov-accounts"></div>
    <h2>最近失败</h2>
    <div id="ov-fails"></div>
  </section>

  <section id="flow">
    <div class="row"><span class="dim">实时（SSE）</span><button class="act" id="btn-flow-clear">清屏</button></div>
    <table><thead><tr>
      <th>时间</th><th>模型</th><th>lane</th><th>prompt</th><th>ticket</th><th>env</th>
      <th>状态</th><th>TTFT</th><th>tokens</th><th>sysLen</th><th>说明</th>
    </tr></thead><tbody id="flow-body"></tbody></table>
  </section>

  <section id="events">
    <div class="row">
      <select id="ev-level"><option value="">全部</option><option>INFO</option><option>WARN</option><option>ERROR</option></select>
      <button class="act" id="btn-ev-reload">重载</button>
      <button class="act" id="btn-ev-export">导出 JSONL</button>
    </div>
    <table><thead><tr><th>时间</th><th>级别</th><th>code</th><th>内容</th></tr></thead><tbody id="ev-body"></tbody></table>
  </section>

  <section id="switches">
    <div class="grid" id="sw-form"></div>
    <h2>说明</h2>
    <div class="card dim" id="sw-note"></div>
  </section>

  <section id="diag">
    <div class="grid">
      <div class="card">
        <h2 style="margin-top:0">构造 body 预览（不发请求）</h2>
        <div class="row"><label>mode</label><select id="dg-mode"></select>
          <label>lane</label><select id="dg-lane"><option>chat</option><option>code</option><option>worker</option></select>
          <label>model</label><input id="dg-model" value="perch" size="12">
        </div>
        <div class="row"><label>caller system</label></div>
        <textarea id="dg-system" placeholder="可选：粘贴客户端自己的 system prompt，用来看 scrub / 合并效果"></textarea>
        <div class="row"><button class="act" id="btn-inspect">生成预览</button></div>
        <pre id="dg-out" class="dim">尚未运行</pre>
      </div>
      <div class="card">
        <h2 style="margin-top:0">账号检查</h2>
        <div class="row">
          <button class="act" id="btn-ban">封禁检查</button>
          <button class="act" id="btn-plan">套餐检查</button>
          <button class="act" id="btn-heal">重选 Starter</button>
        </div>
        <pre id="dg-acc" class="dim">尚未运行</pre>
        <h2>版本</h2>
        <pre id="dg-ver" class="dim">尚未运行</pre>
      </div>
    </div>
    <h2>envelope 对照表</h2>
    <table><thead><tr><th>指纹</th><th>200</th><th>403</th><th>429</th><th>其它</th><th>最后状态</th><th>最后时间</th></tr></thead><tbody id="dg-env"></tbody></table>
  </section>

  <section id="redline">
    <div class="grid" id="rl-cards"></div>
    <h2>刻意不做的事（写进代码，不靠记性）</h2>
    <div class="card">
      <div class="kv"><span>端点遍历</span><span class="dim">只碰 model-call / account / cli-plan / turn-ticket / cli-auth</span></div>
      <div class="kv"><span>多认证方式探测</span><span class="dim">只用 Bearer</span></div>
      <div class="kv"><span>伪造 cli-turn / cli-learning</span><span class="dim">默认不发；面板长期显示该偏离</span></div>
      <div class="kv"><span>批量注册 / 指纹伪装 / 代理轮换</span><span class="dim">不做</span></div>
      <div class="kv"><span>单次探针间隔</span><span class="dim">≥30s，失败不重试</span></div>
      <div class="kv"><span>公网暴露</span><span class="dim">面板只听 127.0.0.1:8802</span></div>
    </div>
  </section>
</main>
<script>
const KEY = new URLSearchParams(location.search).get('k') || '';
const H = KEY ? { Authorization: 'Bearer ' + KEY } : {};
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const t = (ms) => ms ? new Date(ms).toLocaleTimeString() : '—';
let lastReqId = 0, lastEvId = 0, stream = null;

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { ...H, ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) } });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error((data && data.error) || ('HTTP ' + res.status));
  return data;
}

document.querySelectorAll('nav button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('nav button').forEach((x) => x.classList.toggle('active', x === b));
  document.querySelectorAll('section').forEach((s) => s.classList.toggle('active', s.id === b.dataset.tab));
}));

function pill(el, text, kind) { el.textContent = text; el.className = 'pill' + (kind ? ' ' + kind : ''); }

async function loadState() {
  const s = await api('/api/state');
  pill($('pill-run'), s.paused ? 'paused' : (s.breakerOpen ? 'breaker open' : 'running'), s.paused || s.breakerOpen ? 'err' : 'ok');
  pill($('pill-breaker'), 'failures ' + s.consecutiveFailures + '/' + s.breakerThreshold, s.consecutiveFailures ? 'warn' : 'ok');
  pill($('pill-conc'), 'concurrency ' + s.concurrency.active + '/' + s.concurrency.limit);
  const acc = (s.sessions || [])[0] || {};
  pill($('pill-account'), (acc.email || 'no session') + ' · ' + (acc.state || '?') + (acc.planCode ? ' · ' + acc.planCode : ' · plan —'),
    acc.state === 'banned' ? 'err' : (acc.state === 'ok' ? 'ok' : 'warn'));
  $('pill-ua').textContent = s.userAgent;
  $('btn-pause').textContent = s.paused ? '恢复' : '暂停';
  $('btn-pause').dataset.paused = s.paused ? '1' : '0';

  const st = s.stats || {};
  $('ov-cards').innerHTML = [
    card('今日请求', st.total ?? 0, '成功 ' + (st.ok ?? 0)),
    card('403 / 429', (st.http403 ?? 0) + ' / ' + (st.http429 ?? 0), '5xx ' + (st.http5xx ?? 0), (st.http403 || st.http429) ? 'err' : ''),
    card('平均 TTFT', st.ttftSamples ? (st.ttftMsSum / st.ttftSamples / 1000).toFixed(2) + 's' : '—', '样本 ' + (st.ttftSamples ?? 0)),
    card('token', (st.inTokens ?? 0) + ' 入 / ' + (st.outTokens ?? 0) + ' 出', '估算 PT ≈ ' + (((st.inTokens ?? 0) + (st.outTokens ?? 0) * 4) / 1000).toFixed(2)),
    card('prompt 模式', s.prompt.mode, '注入 ' + (s.prompt.canaryChars || 0) + ' 字（canary）'),
    card('lane / ticket', s.lane + ' / ' + s.ticketMode, 'envelope ' + s.envelopeMode),
  ].join('');

  $('ov-accounts').innerHTML = (s.sessions || []).map((a) => {
    const u = a.usage || {};
    const bars = (u.windows || []).map((w) => {
      const pct = (w.cap && w.used != null) ? Math.min(100, Math.round((w.used / w.cap) * 100)) : 0;
      return '<div class="kv"><span>' + esc(w.id) + '</span><span>' + (w.used ?? '—') + ' / ' + (w.cap ?? '—') + ' (' + pct + '%)</span></div>'
        + '<div class="bar"><i style="width:' + pct + '%"></i></div>';
    }).join('');
    return '<div class="card">'
      + '<div class="kv"><span>邮箱</span><span>' + esc(a.email || '—') + '</span></div>'
      + '<div class="kv"><span>状态</span><span class="' + (a.state === 'banned' ? 'err' : 'ok') + '">' + esc(a.state) + '</span></div>'
      + '<div class="kv"><span>planCode</span><span>' + esc(a.planCode ?? '—') + '</span></div>'
      + '<div class="kv"><span>tierSelectionRequired</span><span>' + esc(a.tierSelectionRequired ?? '—') + '</span></div>'
      + '<div class="kv"><span>blockedReason</span><span>' + esc(a.blockedReason ?? '—') + '</span></div>'
      + '<div class="kv"><span>封禁时间</span><span>' + (a.bannedAt ? new Date(a.bannedAt).toLocaleString() : '—') + '</span></div>'
      + '<div class="kv"><span>刷新次数</span><span>' + (a.refreshCount ?? 0) + '</span></div>'
      + bars
      + '<div class="kv"><span>session 文件</span><span class="dim">' + esc(a.file) + '</span></div>'
      + '</div>';
  }).join('') || '<div class="card dim">没有发现会话</div>';

  const fails = await api('/api/requests?limit=50');
  const bad = (fails.data || []).filter((r) => r.status !== 200).slice(-10).reverse();
  $('ov-fails').innerHTML = bad.length
    ? '<table><thead><tr><th>时间</th><th>状态</th><th>code</th><th>信息</th><th>env</th></tr></thead><tbody>'
      + bad.map((r) => '<tr><td>' + t(r.at) + '</td><td class="err">' + r.status + '</td><td>' + esc(r.code || '') + '</td><td class="wrap">' + esc(r.message || '') + '</td><td>' + esc(r.envelope || '') + '</td></tr>').join('')
      + '</tbody></table>'
    : '<div class="card dim">没有失败记录</div>';

  renderSwitches(s);
}

function card(title, value, sub, kind) {
  return '<div class="card"><div class="dim">' + esc(title) + '</div><div class="' + (kind || '') + '" style="font-size:20px;margin:4px 0">' + esc(value) + '</div><div class="dim">' + esc(sub || '') + '</div></div>';
}

let switchesBuilt = false;
function renderSwitches(s) {
  if (!switchesBuilt) {
    const defs = [
      ['promptMode', 'select', ${JSON.stringify(PROMPT_MODES)}],
      ['lane', 'select', ['chat', 'code', 'worker']],
      ['ticketMode', 'select', ['off', 'best-effort', 'required']],
      ['envelopeMode', 'select', ['honeypot', 'magpie']],
      ['maxConcurrency', 'number', [1, 8]],
      ['minIntervalMs', 'number', [0, 60000]],
      ['breakerThreshold', 'number', [1, 50]],
      ['sendManualOption', 'bool', null],
      ['sendRoostExtras', 'bool', null],
      ['scrubIdentity', 'bool', null],
      ['turnContext', 'bool', null],
    ];
    $('sw-form').innerHTML = defs.map(([key, kind, extra]) => {
      let control;
      if (kind === 'select') control = '<select data-key="' + key + '">' + extra.map((v) => '<option value="' + v + '">' + v + '</option>').join('') + '</select>';
      else if (kind === 'number') control = '<input data-key="' + key + '" type="number" min="' + extra[0] + '" max="' + extra[1] + '" style="width:90px">';
      else control = '<select data-key="' + key + '"><option value="true">on</option><option value="false">off</option></select>';
      return '<div class="card"><div class="kv"><span>' + key + '</span>' + control + '</div></div>';
    }).join('');
    $('sw-form').addEventListener('change', async (ev) => {
      const el = ev.target.closest('[data-key]');
      if (!el) return;
      const key = el.dataset.key;
      let value = el.value;
      if (value === 'true') value = true; else if (value === 'false') value = false;
      else if (/^[0-9]+$/.test(value)) value = Number(value);
      try {
        await api('/api/config', { method: 'PUT', body: JSON.stringify({ key, value }) });
        $('sw-note').textContent = key + ' = ' + value + '（已写入 runtime.json，下一个请求生效）';
        await loadState();
      } catch (error) { $('sw-note').textContent = '失败：' + error.message; }
    });
    switchesBuilt = true;
  }
  for (const el of $('sw-form').querySelectorAll('[data-key]')) {
    const key = el.dataset.key;
    let v;
    if (key === 'promptMode') v = s.prompt.mode; else if (key === 'lane') v = s.lane;
    else if (key === 'ticketMode') v = s.ticketMode; else if (key === 'envelopeMode') v = s.envelopeMode;
    else if (key === 'maxConcurrency') v = s.concurrency.limit;
    else if (key === 'minIntervalMs') v = s.pacing.minIntervalMs;
    else if (key === 'breakerThreshold') v = s.breakerThreshold;
    else if (key === 'scrubIdentity') v = s.prompt.mode.includes('scrub');
    else continue;
    if (v !== undefined && v !== null) el.value = String(v);
  }
  $('sw-note').textContent = '改动写入 runtime.json，并立即覆盖 .env；删除 runtime.json 即回到 .env 的值。';
}

async function loadFlow() {
  const data = await api('/api/requests?limit=200');
  const rows = data.data || [];
  if (!rows.length) { $('flow-body').innerHTML = '<tr><td colspan="11" class="dim">还没有请求</td></tr>'; return; }
  $('flow-body').innerHTML = rows.slice().reverse().map((r) => '<tr>'
    + '<td>' + t(r.at) + '</td><td>' + esc(r.model) + '</td><td>' + esc(r.lane) + '</td><td>' + esc(r.promptMode) + '</td>'
    + '<td>' + esc(r.ticketMode) + '</td><td>' + esc(r.envelope) + '</td>'
    + '<td class="' + (r.status === 200 ? 'ok' : 'err') + '">' + r.status + '</td>'
    + '<td>' + (r.ttftMs ? (r.ttftMs / 1000).toFixed(2) + 's' : '—') + '</td>'
    + '<td>' + (r.inputTokens ?? '—') + ' / ' + (r.outputTokens ?? '—') + '</td>'
    + '<td>' + (r.sysLen ?? '—') + '</td><td class="wrap">' + esc(r.code || '') + ' ' + esc(r.message || '') + '</td></tr>').join('');
  lastReqId = rows[rows.length - 1].id;
}

async function loadEvents(level) {
  const q = new URLSearchParams({ limit: '300' });
  if (level) q.set('level', level);
  const data = await api('/api/events?' + q);
  const rows = data.data || [];
  $('ev-body').innerHTML = rows.length ? rows.slice().reverse().map((e) => '<tr>'
    + '<td>' + t(e.at) + '</td><td><span class="tag ' + esc(e.level) + '">' + esc(e.level) + '</span></td>'
    + '<td>' + esc(e.code || '') + '</td><td class="wrap">' + esc(e.message || '') + '</td></tr>').join('')
    : '<tr><td colspan="4" class="dim">没有事件</td></tr>';
  if (rows.length) lastEvId = rows[rows.length - 1].id;
}

async function loadEnvelopes() {
  const data = await api('/api/envelopes');
  const rows = Object.entries(data.data || {});
  $('dg-env').innerHTML = rows.length ? rows.map(([k, v]) => '<tr><td>' + esc(k) + '</td><td class="ok">' + v.ok + '</td>'
    + '<td class="err">' + v.http403 + '</td><td class="warn">' + v.http429 + '</td><td>' + v.other + '</td>'
    + '<td>' + v.lastStatus + '</td><td>' + t(v.lastAt) + '</td></tr>').join('')
    : '<tr><td colspan="7" class="dim">还没有数据</td></tr>';
}

async function loadRedline() {
  const s = await api('/api/state');
  const st = s.stats || {};
  const acc = (s.sessions || [])[0] || {};
  const env = Object.entries(st.envelopes || {}).sort((a, b) => (b[1].lastAt || 0) - (a[1].lastAt || 0))[0];
  $('rl-cards').innerHTML = [
    card('今日 403 / 429', (st.http403 ?? 0) + ' / ' + (st.http429 ?? 0), (st.http403 || st.http429) ? '有触发' : '无', (st.http403 || st.http429) ? 'err' : 'ok'),
    card('距上次失败', st.lastFailAt ? Math.round((Date.now() - st.lastFailAt) / 1000) + 's' : '—', st.lastFailCode || ''),
    card('连续失败', (s.consecutiveFailures ?? 0) + ' / ' + s.breakerThreshold, s.breakerOpen ? '熔断已打开' : '熔断关闭', s.breakerOpen ? 'err' : 'ok'),
    card('当前 envelope', env ? env[0] : '—', env ? ('200×' + env[1].ok + ' 403×' + env[1].http403) : ''),
    card('账号', acc.state || '—', acc.blockedReason || '—', acc.state === 'banned' ? 'err' : ''),
    card('与官方流量基线的偏离', '1 步 vs 7–8 步', '官方每轮还有 cli-context/领票/cli-turn 等；我们只发 model-call', 'warn'),
  ].join('');
}

// SSE
function connect() {
  if (stream) stream.close();
  const q = KEY ? ('?k=' + encodeURIComponent(KEY)) : '';
  stream = new EventSource('/api/stream' + q);
  stream.addEventListener('request', (ev) => {
    const r = JSON.parse(ev.data);
    if (!document.getElementById('flow').classList.contains('active')) return;
    const body = $('flow-body');
    if (body.firstElementChild && body.firstElementChild.children.length === 1) body.innerHTML = '';
    body.insertAdjacentHTML('afterbegin', '<tr><td>' + t(r.at) + '</td><td>' + esc(r.model) + '</td><td>' + esc(r.lane) + '</td><td>' + esc(r.promptMode) + '</td>'
      + '<td>' + esc(r.ticketMode) + '</td><td>' + esc(r.envelope) + '</td>'
      + '<td class="' + (r.status === 200 ? 'ok' : 'err') + '">' + r.status + '</td><td>' + (r.ttftMs ? (r.ttftMs / 1000).toFixed(2) + 's' : '—') + '</td>'
      + '<td>' + (r.inputTokens ?? '—') + ' / ' + (r.outputTokens ?? '—') + '</td><td>' + (r.sysLen ?? '—') + '</td>'
      + '<td class="wrap">' + esc(r.code || '') + ' ' + esc(r.message || '') + '</td></tr>');
  });
  stream.addEventListener('event', (ev) => {
    const e = JSON.parse(ev.data);
    if (e.level === 'ERROR' || e.level === 'WARN') loadState().catch(() => {});
  });
  stream.onerror = () => { setTimeout(connect, 3000); };
}

$('btn-refresh').onclick = () => { loadState().catch(alert); loadEnvelopes().catch(() => {}); };
$('btn-pause').onclick = async () => {
  const paused = $('btn-pause').dataset.paused === '1';
  await api(paused ? '/api/resume' : '/api/pause', { method: 'POST' });
  await loadState();
};
$('btn-flow-clear').onclick = () => { $('flow-body').innerHTML = ''; };
$('btn-ev-reload').onclick = () => loadEvents($('ev-level').value).catch(() => {});
$('btn-ev-export').onclick = async () => {
  const data = await api('/api/events?limit=5000');
  const blob = new Blob((data.data || []).map((e) => JSON.stringify(e)).join('\\n'), { type: 'application/x-ndjson' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'perch2api-events.jsonl'; a.click();
};

// diagnostics
async function initDiag() {
  const s = await api('/api/state');
  $('dg-mode').innerHTML = ${JSON.stringify(PROMPT_MODES)}.map((m) => '<option' + (m === s.prompt.mode ? ' selected' : '') + '>' + m + '</option>').join('');
  $('dg-lane').value = s.lane;
}
$('btn-inspect').onclick = async () => {
  const payload = {
    mode: $('dg-mode').value, lane: $('dg-lane').value, model: $('dg-model').value,
    callerSystem: $('dg-system').value || null,
  };
  try {
    const data = await api('/api/inspect', { method: 'POST', body: JSON.stringify(payload) });
    const { body, ...summary } = data;
    $('dg-out').textContent = JSON.stringify(summary, null, 2);
  } catch (error) { $('dg-out').textContent = '失败：' + error.message; }
};
$('btn-ban').onclick = async () => { try { $('dg-acc').textContent = JSON.stringify(await api('/api/check-ban', { method: 'POST' }), null, 2); } catch (e) { $('dg-acc').textContent = '失败：' + e.message; } };
$('btn-plan').onclick = async () => { try { $('dg-acc').textContent = JSON.stringify(await api('/api/check-plan', { method: 'POST' }), null, 2); } catch (e) { $('dg-acc').textContent = '失败：' + e.message; } };
$('btn-heal').onclick = async () => { try { $('dg-acc').textContent = JSON.stringify(await api('/api/select-plan', { method: 'POST' }), null, 2); } catch (e) { $('dg-acc').textContent = '失败：' + e.message; } };

loadState().catch((e) => { document.body.insertAdjacentHTML('afterbegin', '<div class="card err">' + esc(e.message) + '</div>'); });
loadFlow().catch(() => {});
loadEnvelopes().catch(() => {});
loadRedline().catch(() => {});
initDiag().catch(() => {});
connect();
setInterval(() => { loadState().catch(() => {}); }, 5000);
setInterval(() => { if (document.getElementById('redline').classList.contains('active')) loadRedline().catch(() => {}); }, 5000);
</script>
</body>
</html>`;

export async function startPanel({ state, store, guardState, config: cfg }) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const route = url.pathname.replace(/\/+$/, '') || '/';

    if (route === '/' || route === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(PAGE);
      return;
    }

    if (!authorized(req, url)) {
      json(res, 401, { error: 'missing or invalid key (append ?k=<PERCH2API_KEY>)' });
      return;
    }

    try {
      if (req.method === 'GET' && route === '/api/state') {
        json(res, 200, await state());
        return;
      }

      if (req.method === 'GET' && route === '/api/stream') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
        });
        res.write(': connected\n\n');
        const beat = setInterval(() => {
          if (res.writableEnded) return;
          res.write(': ping\n\n');
        }, 15_000);
        if (beat.unref) beat.unref();
        const unsubscribe = subscribe((msg) => {
          if (res.writableEnded) return;
          res.write(`event: ${msg.kind}\ndata: ${JSON.stringify(msg.rec)}\n\n`);
        });
        req.on('close', () => {
          clearInterval(beat);
          unsubscribe();
          if (!res.writableEnded) res.end();
        });
        return;
      }

      if (req.method === 'GET' && route === '/api/requests') {
        const since = Number.parseInt(url.searchParams.get('since') || '0', 10);
        const limit = Math.min(Number.parseInt(url.searchParams.get('limit') || '200', 10), 2000);
        json(res, 200, { today: today(), data: sinceRequests(since, limit) });
        return;
      }

      if (req.method === 'GET' && route === '/api/events') {
        const since = Number.parseInt(url.searchParams.get('since') || '0', 10);
        const limit = Math.min(Number.parseInt(url.searchParams.get('limit') || '200', 10), 5000);
        const level = url.searchParams.get('level') || null;
        json(res, 200, { data: sinceEvents(since, limit, level) });
        return;
      }

      if (req.method === 'GET' && route === '/api/envelopes') {
        json(res, 200, { data: Object.fromEntries(stats.envelopes) });
        return;
      }

      if (req.method === 'GET' && route === '/api/config') {
        const values = {};
        for (const key of Object.keys(RUNTIME_FIELDS)) values[key] = config[key];
        json(res, 200, { values, overrides: readRuntimeOverrides(), file: config.runtimeFile });
        return;
      }

      if (req.method === 'PUT' && route === '/api/config') {
        const body = await readBody(req);
        if (!body?.key) {
          json(res, 400, { error: 'key is required' });
          return;
        }
        const value = writeRuntimeOverride(body.key, body.value);
        if (body.key === 'paused') guardState.paused = Boolean(value);
        emit('INFO', { code: 'config_changed', message: `${body.key} = ${value}`, key: body.key, value });
        json(res, 200, { ok: true, key: body.key, value });
        return;
      }

      if (req.method === 'POST' && (route === '/api/pause' || route === '/api/resume')) {
        const paused = route.endsWith('pause');
        guardState.paused = paused;
        if (!paused) {
          guardState.breakerOpen = false;
          guardState.breakerOpenedAt = null;
          guardState.consecutiveFailures = 0;
        }
        try {
          writeRuntimeOverride('paused', paused);
        } catch {
          /* the switch still applies in-process even when the file is read-only */
        }
        emit(paused ? 'WARN' : 'INFO', {
          code: paused ? 'paused' : 'resumed',
          message: paused ? 'Gateway paused: no upstream calls will be sent.' : 'Gateway resumed.',
        });
        json(res, 200, { ok: true, paused });
        return;
      }

      if (req.method === 'POST' && route === '/api/check-ban') {
        const { slot, release } = store.pick();
        try {
          const token = await store.token(slot);
          const result = await checkBan({ baseUrl: slot.session?.appUrl || config.appUrl, token });
          if (result.banned) store.markBanned(slot, result.blockedReason);
          json(res, 200, { ...result, file: slot.file });
        } finally {
          release();
        }
        return;
      }

      if (req.method === 'POST' && route === '/api/check-plan') {
        const { slot, release } = store.pick();
        try {
          const info = await store.accountInfo(slot, { force: true });
          json(res, 200, { file: slot.file, planCode: info.planCode, tierSelectionRequired: info.tierSelectionRequired, blockedReason: info.blockedReason, usage: info.usage });
        } finally {
          release();
        }
        return;
      }

      if (req.method === 'POST' && route === '/api/select-plan') {
        const { slot, release } = store.pick();
        try {
          json(res, 200, await store.healPlan(slot));
        } finally {
          release();
        }
        return;
      }

      if (req.method === 'POST' && route === '/api/inspect') {
        const body = await readBody(req);
        const result = inspect({
          mode: body.mode,
          lane: body.lane,
          model: body.model,
          envelopeMode: body.envelopeMode,
          callerSystem: body.callerSystem,
          userText: body.userText,
          ticketMode: config.ticketMode,
        });
        json(res, 200, result);
        return;
      }

      if (req.method === 'POST' && route === '/api/version') {
        json(res, 200, { ...checkCliVersion(), latest: await latestPublishedVersion() });
        return;
      }

      if (req.method === 'POST' && route === '/api/probe') {
        const now = Date.now();
        if (now - lastProbeAt < PROBE_MIN_GAP_MS) {
          json(res, 429, { error: `probe is rate limited to one per ${PROBE_MIN_GAP_MS / 1000}s` });
          return;
        }
        lastProbeAt = now;
        const { slot, release } = store.pick();
        try {
          const token = await store.token(slot);
          const messages = normalizeMessages([{ role: 'user', content: 'Reply with exactly one word: PONG' }], { mode: config.promptMode });
          const model = resolveModel('perch');
          const runId = `probe-${now.toString(36)}`;
          const body = buildRequestBody({
            messages, tools: null, toolChoice: null, maxTokens: 512, temperature: 0.2, stop: null,
            model, runId, reasoning: null,
            attribution: { userId: slot.session?.userId ?? null, workspaceId: process.env.PERCH_WORKSPACE_ID || null, runId, lane: config.lane, source: 'cli', billingMultiplier: null },
            lane: config.lane,
          });
          const res2 = await fetch(`${slot.session?.appUrl || config.appUrl}/api/perch-terminal/model-call`, {
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
            signal: AbortSignal.timeout(120_000),
          });
          const raw = await res2.text();
          emit(res2.ok ? 'INFO' : 'WARN', {
            code: res2.ok ? 'probe_ok' : 'probe_failed',
            message: `Single probe returned HTTP ${res2.status} (${raw.length} bytes).`,
            status: res2.status,
          });
          json(res, 200, {
            status: res2.status,
            promptMode: config.promptMode,
            lane: config.lane,
            envelopeMode: config.envelopeMode,
            requestBytes: JSON.stringify(body).length,
            responseHead: raw.slice(0, 4000),
          });
        } finally {
          release();
        }
        return;
      }

      json(res, 404, { error: `unknown route ${route}` });
    } catch (error) {
      json(res, error.status || 500, { error: error.message, code: error.code ?? null });
    }
  });

  server.listen(config.panelPort, config.panelHost, () => {
    console.log(`  panel: http://${config.panelHost}:${config.panelPort}/?k=<PERCH2API_KEY>`);
    console.log('         reach it with  ssh -L 8802:127.0.0.1:8802 wx');
  });
  server.on('error', (error) => {
    console.warn(`panel listen failed on ${config.panelHost}:${config.panelPort}: ${error.message}`);
  });

  emit('INFO', {
    code: 'panel_started',
    message: `Developer panel on http://${config.panelHost}:${config.panelPort}`,
    promptMode: config.promptMode,
    lane: config.lane,
    ticketMode: config.ticketMode,
    envelopeMode: config.envelopeMode,
  });

  return server;
}

export { inspect };
