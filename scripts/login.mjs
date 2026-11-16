#!/usr/bin/env node
/**
 * Perch2API login — reproduce the official CLI's OAuth (PKCE) flow and write a
 * `cli-auth-session.json` that the gateway can use.
 *
 *   node scripts/login.mjs                 # default output: %APPDATA%/Perch AI Desktop/cli-auth-session.json
 *   node scripts/login.mjs --out accounts/acc1.json --provider github --port 45871
 *
 * Flow (OBSERVED from perchai-cli 2.4.118):
 *   1. GET  {app}/api/perch-terminal/cli-auth/config   -> supabaseUrl, supabaseAnonKey, providers
 *   2. Send the browser to Supabase /auth/v1/authorize with a PKCE challenge
 *   3. Catch ?code= on a loopback listener
 *   4. POST {supabaseUrl}/auth/v1/token?grant_type=pkce { auth_code, code_verifier }
 *   5. Persist { version, appUrl, accessToken, refreshToken, expiresAt, userId, email }
 */
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';

const args = process.argv.slice(2);
function arg(name, fallback = null) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
}
function flag(name) {
  return args.includes(`--${name}`);
}

const APP = (arg('app', process.env.PERCH_APP_URL || 'https://app.perchai.app')).replace(/\/+$/, '');
const PORT = Number.parseInt(arg('port', '0'), 10) || 0;
const PROVIDER = arg('provider', null);
const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const OUT = arg('out', path.join(appData, 'Perch AI Desktop', 'cli-auth-session.json'));
const NO_OPEN = flag('no-open');

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function openBrowser(url) {
  if (NO_OPEN) return;
  const platform = process.platform;
  const cmd = platform === 'win32' ? 'rundll32' : platform === 'darwin' ? 'open' : 'xdg-open';
  const argv = platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  execFile(cmd, argv, () => {});
}

async function main() {
  console.log(`[1/4] reading auth config from ${APP}`);
  const cfgRes = await fetch(`${APP}/api/perch-terminal/cli-auth/config`, {
    headers: { Accept: 'application/json' },
  });
  if (!cfgRes.ok) throw new Error(`cli-auth/config HTTP ${cfgRes.status}`);
  const cfg = await cfgRes.json();
  if (!cfg.ok || !cfg.supabaseUrl || !cfg.supabaseAnonKey) throw new Error('cli-auth/config returned no Supabase credentials');

  const provider = PROVIDER || (cfg.providers?.includes('google') ? 'google' : cfg.providers?.[0]);
  if (!provider) throw new Error('no OAuth providers advertised');

  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());

  const { server, redirectTo } = await startListener();
  const authorizeUrl = new URL(`${cfg.supabaseUrl}/auth/v1/authorize`);
  authorizeUrl.searchParams.set('provider', provider);
  authorizeUrl.searchParams.set('redirect_to', redirectTo);
  authorizeUrl.searchParams.set('code_challenge', challenge);
  authorizeUrl.searchParams.set('code_challenge_method', 's256');
  authorizeUrl.searchParams.set('apikey', cfg.supabaseAnonKey);
  if (provider === 'google') authorizeUrl.searchParams.set('prompt', 'select_account');

  console.log(`[2/4] open this URL and finish ${provider} sign-in:`);
  console.log(`      ${authorizeUrl.toString()}`);
  if (flag('dry-run')) {
    server.close();
    console.log('[dry-run] stopping before the browser step');
    return;
  }
  console.log(`      waiting for the callback on ${redirectTo} (timeout 300s)`);
  openBrowser(authorizeUrl.toString());

  const code = await waitForCode(server);
  server.close();

  console.log('[3/4] exchanging code for a session');
  const tokenBase = process.env.PERCH_SUPABASE_PROXY || cfg.supabaseUrl;
  const tokenUrl = `${tokenBase}/auth/v1/token?grant_type=pkce`;
  const payload = JSON.stringify({ auth_code: code, code_verifier: verifier });
  const raw = await new Promise((resolve, reject) => {
    execFile('curl', [
      '-sS', '--max-time', '90', '-X', 'POST', tokenUrl,
      '-H', 'Content-Type: application/json',
      '-H', `apikey: ${cfg.supabaseAnonKey}`,
      '-H', `Authorization: Bearer ${cfg.supabaseAnonKey}`,
      '--data-binary', payload,
    ], { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`token exchange curl failed: ${err.message} ${stderr || ''}`.trim()));
      else resolve(stdout);
    });
  });
  let session = null;
  try { session = JSON.parse(raw); } catch { /* non-JSON response */ }
  if (!session?.access_token) {
    throw new Error(`token exchange failed: ${raw.slice(0, 300)}`);
  }

  const record = {
    version: 1,
    appUrl: APP,
    accessToken: session.access_token,
    refreshToken: session.refresh_token ?? null,
    expiresAt: typeof session.expires_at === 'number'
      ? session.expires_at
      : Math.floor(Date.now() / 1000) + (session.expires_in ?? 3600),
    userId: session.user?.id ?? null,
    email: session.user?.email ?? null,
    updatedAt: new Date().toISOString(),
  };

  await fsp.mkdir(path.dirname(OUT), { recursive: true, mode: 0o700 });
  await fsp.writeFile(OUT, JSON.stringify(record, null, 0), { mode: 0o600 });
  console.log(`[4/4] session written to ${OUT}`);
  console.log(`      account: ${record.email} (${record.userId})`);
  console.log(`      expires: ${new Date(record.expiresAt * 1000).toISOString()}`);
}

function startListener() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.on('error', reject);
    server.listen(PORT, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        server,
        redirectTo: `http://127.0.0.1:${address.port}/callback`,
      });
    });
  });
}

function waitForCode(server) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('timed out waiting for the OAuth callback'));
    }, 900_000);

    server.on('request', (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname !== '/callback') {
        res.writeHead(404).end('not found');
        return;
      }
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error_description') || url.searchParams.get('error');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<html><body style="font-family:system-ui;padding:2rem">
        <h3>${code ? 'Perch2API login complete' : 'Perch2API login failed'}</h3>
        <p>${code ? 'You can close this tab and return to the terminal.' : String(error || 'no code returned')}</p>
      </body></html>`);
      clearTimeout(timer);
      if (code) resolve(code);
      else reject(new Error(`OAuth error: ${error || 'no code returned'}`));
    });
  });
}

main().catch((error) => {
  console.error('login failed:', error.message);
  process.exitCode = 1;
});
