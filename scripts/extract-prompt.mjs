#!/usr/bin/env node
/**
 * Extract the operator prompt from a locally installed `perchai-cli`, so the
 * `full` / `full-agents` modes have something to inject.
 *
 * Why this exists instead of shipping the text: it is Perch's prompt, not ours to
 * redistribute. Extract it from a copy you installed yourself.
 *
 * How it works: the prompt is assembled at runtime — 91.7% of it from a static
 * template in the bundle, the rest from cwd / mode / enabled tools. The client
 * builds and sends the body before it cares whether the server answers, so we point
 * it at a throwaway local endpoint and read the body back. `PERCH_DUMP_MODEL_PAYLOAD`
 * makes it write the exact payload to disk, which is more faithful than parsing SSE.
 *
 *   npm pack perchai-cli@2.4.134 && tar xzf perchai-cli-*.tgz
 *   node scripts/extract-prompt.mjs --cli ./package
 *   -> .perch-prefix.txt (ask), .perch-prompt-agents.txt (agents)
 *
 * Nothing is sent to Perch: both app URLs are overridden to 127.0.0.1, and any
 * non-loopback connection attempt is refused by an egress guard passed via
 * NODE_OPTIONS. If you want belt and braces, check that the recorder saw the calls
 * and Perch saw nothing.
 *
 * Notes from getting this working, in case it breaks later:
 *   - Run `bin/perch`, not `dist/perch.mjs`. The wrapper sets PERCH_CLI_VERSION from
 *     package.json; skipping it makes the User-Agent degrade to `perchai-cli/unknown`.
 *   - PERCH_CLI_HEAP_REEXEC=1 is needed, otherwise the CLI exits before model-call.
 *   - Give each run its own PERCH_CLI_STATE_DIR / PERCH_CLI_SETTINGS_DIR, or the
 *     second run resumes the first one's thread and you capture a mid-conversation
 *     body instead of a first turn.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const flag = (name) => args.includes(`--${name}`);

const cliRoot = arg('cli');
if (!cliRoot) {
  console.error('usage: node scripts/extract-prompt.mjs --cli <unpacked perchai-cli package dir>');
  process.exit(2);
}
const RESOLVED = path.resolve(cliRoot);
// Prefer the wrapper: it exports PERCH_CLI_VERSION.
const entry = [
  path.join(RESOLVED, 'bin', 'perch'),
  path.join(RESOLVED, 'dist', 'perch.mjs'),
].find((p) => fs.existsSync(p));
if (!entry) {
  console.error(`no entry point under ${RESOLVED} (looked for bin/perch, dist/perch.mjs)`);
  process.exit(2);
}

const PORT = Number(arg('port', '19090'));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'perch-extract-'));
const APP = `http://127.0.0.1:${PORT}`;
const captured = [];

// --- egress guard: refuse anything that is not loopback ---------------------
const guardPath = path.join(WORK, 'guard.mjs');
fs.writeFileSync(guardPath, `
import net from 'node:net';
import fs from 'node:fs';
const LOG = ${JSON.stringify(path.join(WORK, 'egress.log'))};
const isLoop = (h) => !h || h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
const origConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...a) {
  try {
    const o = typeof a[0] === 'object' && a[0] !== null ? a[0] : { port: a[0], host: a[1] };
    if (!isLoop(o && o.host)) {
      fs.appendFileSync(LOG, 'blocked connect ' + JSON.stringify(o) + '\\n');
      this.destroy(new Error('egress blocked by extract-prompt guard'));
      return this;
    }
  } catch {}
  return origConnect.apply(this, a);
};
const origFetch = globalThis.fetch;
globalThis.fetch = function (input, init) {
  try {
    const u = typeof input === 'string' ? input : input && input.url;
    const h = u ? new URL(u).hostname : '';
    if (!isLoop(h)) {
      fs.appendFileSync(LOG, 'blocked fetch ' + u + '\\n');
      return Promise.reject(new Error('egress blocked by extract-prompt guard'));
    }
  } catch {}
  return origFetch.call(this, input, init);
};
`);

// --- recorder ---------------------------------------------------------------
const sse = (res, payloads) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const p of payloads) res.write(`data: ${JSON.stringify(p)}\n\n`);
  res.end();
};
const json = (res, o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };

const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    const p = req.url.split('?')[0];
    if (p.includes('model-call')) captured.push({ path: p, body: raw });
    if (p.endsWith('/cli-auth/config')) {
      return json(res, {
        ok: true, supabaseUrl: `${APP}/supabase`, supabaseAnonKey: 'extract-only',
        providers: ['github'], redirectHost: '127.0.0.1',
      });
    }
    if (p.includes('turn-ticket')) {
      return json(res, {
        ok: true, ticket: 'tkt-extract', ticketId: 'tid-extract',
        runId: 'tkt-cli-extract', expiresAt: new Date(Date.now() + 300_000).toISOString(),
        enforced: false,
      });
    }
    if (p.includes('model-call')) {
      return sse(res, [
        { type: 'answer_delta', text: 'ok' },
        { type: 'done', ok: true, text: 'ok', finishReason: 'stop', model: 'extract/model', provider: 'extract', usage: { inputTokens: 1, outputTokens: 1 } },
      ]);
    }
    if (p.includes('cli-plan')) return json(res, { ok: true, planRequired: false });
    if (p.includes('/account')) {
      return json(res, {
        email: 'extract@example.test', userId: '00000000-0000-0000-0000-000000000000',
        planCode: 'starter', tierSelectionRequired: false,
      });
    }
    json(res, { ok: true });
  });
});

// --- run one mode -----------------------------------------------------------
function runMode(mode) {
  return new Promise((resolve) => {
    const stateDir = path.join(WORK, `state-${mode}`);
    const settingsDir = path.join(WORK, `settings-${mode}`);
    const authDir = path.join(WORK, `home-${mode}`);
    const dumpDir = path.join(WORK, `dump-${mode}`);
    for (const d of [stateDir, settingsDir, authDir, dumpDir]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(authDir, 'cli-auth-session.json'), JSON.stringify({
      version: 1, appUrl: APP, accessToken: 'extract-access-token', refreshToken: 'extract-refresh',
      expiresAt: 4102444800, userId: '00000000-0000-0000-0000-000000000000', email: 'extract@example.test',
    }));

    const child = spawn(process.execPath, [entry, 'run', 'x', '--json', '--mode', mode], {
      cwd: WORK,
      env: {
        ...process.env,
        HOME: authDir,
        PERCH_CLI_AUTH_DIR: authDir,
        PERCH_CLI_STATE_DIR: stateDir,
        PERCH_CLI_SETTINGS_DIR: settingsDir,
        PERCH_APP_URL: APP,
        PERCH_CLI_APP_URL: APP,
        PERCH_MODEL_CALL_PROXY_URL: `${APP}/api/perch-terminal/model-call`,
        PERCH_MODEL_CALL_PROXY_TOKEN: 'extract-model-proxy-token',
        PERCH_DUMP_MODEL_PAYLOAD: '1',
        PERCH_MODEL_PAYLOAD_DUMP_DIR: dumpDir,
        PERCH_CLI_HEAP_REEXEC: '1',
        NODE_OPTIONS: `--import=file://${guardPath}`,
        NO_COLOR: '1', TERM: 'dumb', CI: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    child.stdout.on('data', (d) => { log += d; });
    child.stderr.on('data', (d) => { log += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.on('close', () => {
      clearTimeout(timer);
      if (flag('verbose') || !captured.length) {
        const tail = log.trim().split('\n').slice(-6).join('\n    ');
        if (tail) console.error(`  [${mode}] cli output:\n    ${tail}`);
      }
      resolve(dumpDir);
    });
  });
}

// --- main -------------------------------------------------------------------
server.listen(PORT, '127.0.0.1', async () => {
  console.log(`recorder on 127.0.0.1:${PORT}`);
  console.log(`cli entry: ${entry}`);
  const results = [];

  for (const [mode, outFile] of [['ask', '.perch-prefix.txt'], ['agents', '.perch-prompt-agents.txt']]) {
    const before = captured.length;
    const dumpDir = await runMode(mode);

    // Prefer the payload dump: it is the exact body, pre-serialisation.
    let sys = null;
    if (fs.existsSync(dumpDir)) {
      for (const f of fs.readdirSync(dumpDir).sort()) {
        try {
          const body = JSON.parse(fs.readFileSync(path.join(dumpDir, f), 'utf8'));
          const m = (body?.request?.messages ?? []).find((x) => x.role === 'system');
          if (m?.content) sys = m.content;
        } catch { /* not a payload file */ }
      }
    }
    if (!sys) {
      const got = captured.slice(before).filter((c) => c.body);
      for (const g of got) {
        try {
          const m = (JSON.parse(g.body)?.request?.messages ?? []).find((x) => x.role === 'system');
          if (m?.content) sys = m.content;
        } catch { /* ignore */ }
      }
    }
    if (!sys) {
      console.error(`  ✗ ${mode}: no system prompt captured`);
      continue;
    }
    fs.writeFileSync(outFile, sys);
    results.push({ mode, outFile, chars: sys.length });
    console.log(`  ✓ ${mode}: ${sys.length} chars -> ${outFile}`);
  }

  const egressLog = path.join(WORK, 'egress.log');
  const blocked = fs.existsSync(egressLog) ? fs.readFileSync(egressLog, 'utf8').trim() : '';
  console.log(`\negress guard: ${blocked ? `blocked ${blocked.split('\n').length} attempt(s)` : 'no non-loopback attempt'}`);
  console.log(`work dir: ${WORK}`);

  if (results.length === 2) {
    const a = fs.readFileSync('.perch-prefix.txt', 'utf8');
    const b = fs.readFileSync('.perch-prompt-agents.txt', 'utf8');
    let i = 0;
    while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++;
    console.log(`\nshared prefix across modes: ${i} chars`);
    console.log('  `full` and `full-agents` differ only from that point on.');

    // Report which parts of each prompt are generated rather than static. This
    // matters: a prompt file with a stale generated section is worse than no file.
    const DYN = [
      [/^Workspace root: .*$/m, 'Workspace root (this machine)'],
      [/^Today is .*$/m, 'Today is (this day)'],
      [/^Enabled tools this turn: .*$/m, 'tool list (this run\'s tool set)'],
      [/^## Chat history$/m, 'Chat history section (only when a prior turn exists)'],
      [/^## Prior turn context.*$/m, 'prior turn context (thread-dependent)'],
      [/^## Loaded skills$/m, 'loaded skills (turn-dependent)'],
    ];
    console.log('\n  generated sections found:');
    for (const [name, label, text] of [['ask', '.perch-prefix.txt', a], ['agents', '.perch-prompt-agents.txt', b]]) {
      const found = DYN.filter(([re]) => re.test(text)).map(([, l]) => l);
      console.log(`    ${name.padEnd(7)} ${found.length ? found.join('; ') : 'none — fully static'}`);
    }
    console.log('\n  freshenPrompt() rewrites Workspace root / Today is at send time.');
    console.log('  The rest are NOT rewritten: a tool list or chat-history section baked');
    console.log('  into a file describes the extraction run, not your traffic.');
    console.log('\nSet PERCH_PROMPT_MODE=full or full-agents, then restart the service.');
  } else {
    console.log('\nExtraction incomplete. Re-run with --verbose to see what the CLI said.');
    console.log('Common causes: wrong --cli path, or a CLI version whose login flow changed.');
  }

  server.close();
  process.exit(results.length === 2 ? 0 : 1);
});
