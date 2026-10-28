'use strict';
/*
 * Single-user password protection for Marginalia.
 *
 * The password comes from, in order:
 *   1. the MARGINALIA_PASSWORD environment variable, or
 *   2. data/.auth.json, written by `node server.js set-password` (stored as a scrypt hash).
 * With neither set, auth is off — which the server only allows on localhost.
 *
 * Sessions are stateless signed cookies (HMAC-SHA256), so they survive restarts.
 * The signing key is derived from a random secret in data/.secret *and* the current
 * password, so changing the password signs everyone out.
 */

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const readline = require('node:readline');

const COOKIE = 'marginalia_session';
const DAY = 24 * 60 * 60 * 1000;
const REMEMBER_MS = 30 * DAY;        // "keep me signed in"
const SESSION_MS = 12 * 60 * 60 * 1000; // otherwise: until the browser closes, at most 12 hours
const MAX_FAILS = 8;
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function scrypt(password, salt, { N, r, p, keylen } = SCRYPT) {
  return new Promise((resolve, reject) =>
    crypto.scrypt(password.normalize('NFC'), salt, keylen, { N, r, p, maxmem: 64 * 1024 * 1024 },
      (err, key) => (err ? reject(err) : resolve(key))));
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${b64u(salt)}$${b64u(key)}`;
}

async function verifyHash(password, stored) {
  const [alg, N, r, p, salt, key] = String(stored).split('$');
  if (alg !== 'scrypt' || !key) return false;
  const want = Buffer.from(key, 'base64url');
  const got = await scrypt(password, Buffer.from(salt, 'base64url'), { N: +N, r: +r, p: +p, keylen: want.length });
  return crypto.timingSafeEqual(got, want);
}

function safeEqual(a, b) {
  const x = sha256(String(a)), y = sha256(String(b));
  return crypto.timingSafeEqual(x, y);
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const isLoopback = (host) => ['127.0.0.1', 'localhost', '::1'].includes(host);

async function readOrCreateSecret(dataDir) {
  const file = path.join(dataDir, '.secret');
  try {
    const s = (await fs.readFile(file, 'utf8')).trim();
    if (s.length >= 32) return s;
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const s = crypto.randomBytes(32).toString('hex');
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(file, s + '\n', { mode: 0o600 });
  return s;
}

async function createAuth({ dataDir, env = process.env }) {
  const authFile = path.join(dataDir, '.auth.json');
  const trustProxy = /^(1|true|yes)$/i.test(env.TRUST_PROXY || '');
  const cookieSecure = (env.COOKIE_SECURE || 'auto').toLowerCase();

  let mode = 'off', storedHash = null, envPassword = null;
  if (env.MARGINALIA_PASSWORD) {
    mode = 'env';
    envPassword = env.MARGINALIA_PASSWORD;
  } else {
    try {
      storedHash = JSON.parse(await fs.readFile(authFile, 'utf8')).password;
      if (storedHash) mode = 'file';
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }

  const enabled = mode !== 'off';
  const secret = enabled ? await readOrCreateSecret(dataDir) : '';
  const verifierId = mode === 'env' ? 'env:' + sha256(envPassword).toString('hex') : 'file:' + storedHash;
  const key = enabled ? crypto.createHmac('sha256', secret).update(verifierId).digest() : null;

  const sign = (payload) => b64u(crypto.createHmac('sha256', key).update(payload).digest());

  function clientIp(req) {
    if (trustProxy) {
      const xff = req.headers['x-forwarded-for'];
      if (xff) return String(xff).split(',')[0].trim();
    }
    return req.socket.remoteAddress || '?';
  }

  function isHttps(req) {
    if (req.socket.encrypted) return true;
    return trustProxy && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
  }

  function cookieHeader(req, value, maxAgeMs) {
    const secure = cookieSecure === 'true' || (cookieSecure === 'auto' && isHttps(req));
    const parts = [`${COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
    if (maxAgeMs !== undefined) parts.push(`Max-Age=${Math.floor(maxAgeMs / 1000)}`);
    if (secure) parts.push('Secure');
    return parts.join('; ');
  }

  function isAuthed(req) {
    if (!enabled) return true;
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (!token) return false;
    const [exp, flag, mac] = token.split('.');
    if (!exp || !mac || !/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
    return safeEqual(sign(`${exp}.${flag}`), mac);
  }

  async function checkPassword(pw) {
    if (typeof pw !== 'string' || !pw || pw.length > 1024) return false;
    if (mode === 'env') return safeEqual(pw, envPassword);
    return verifyHash(pw, storedHash);
  }

  // Brute-force brake: per client address.
  const fails = new Map();
  function lockedFor(ip) {
    const f = fails.get(ip);
    if (!f) return 0;
    if (Date.now() - f.first > FAIL_WINDOW_MS) { fails.delete(ip); return 0; }
    return f.count >= MAX_FAILS ? f.first + FAIL_WINDOW_MS - Date.now() : 0;
  }
  function recordFail(ip) {
    const f = fails.get(ip);
    if (!f || Date.now() - f.first > FAIL_WINDOW_MS) fails.set(ip, { count: 1, first: Date.now() });
    else f.count++;
    if (fails.size > 10000) fails.delete(fails.keys().next().value);
  }

  /** Handles auth's own routes. Returns true if it answered the request. */
  async function route(req, res, url, { send, readJson, serveFile }) {
    const p = url.pathname;

    if (p === '/login' && req.method === 'GET') {
      if (!enabled || isAuthed(req)) {
        res.writeHead(302, { Location: '/' });
        res.end();
      } else {
        await serveFile('login.html', res);
      }
      return true;
    }

    if (p === '/api/auth/status' && req.method === 'GET') {
      send(res, 200, { enabled, authed: isAuthed(req) });
      return true;
    }

    if (p === '/api/auth/login' && req.method === 'POST') {
      if (!enabled) { send(res, 204); return true; }
      const ip = clientIp(req);
      const wait = lockedFor(ip);
      if (wait > 0) {
        send(res, 429, { error: `Too many attempts. Try again in ${Math.ceil(wait / 60000)} min.` },
          { 'Retry-After': String(Math.ceil(wait / 1000)) });
        return true;
      }
      const body = await readJson(req);
      if (!(await checkPassword(body.password))) {
        recordFail(ip);
        await sleep(400 + Math.random() * 300);
        console.warn(`  Failed sign-in from ${ip}`);
        send(res, 401, { error: 'That is not the password.' });
        return true;
      }
      fails.delete(ip);
      const remember = body.remember === true;
      const exp = Date.now() + (remember ? REMEMBER_MS : SESSION_MS);
      const payload = `${exp}.${remember ? 'r' : 's'}`;
      send(res, 204, null, { 'Set-Cookie': cookieHeader(req, `${payload}.${sign(payload)}`, remember ? REMEMBER_MS : undefined) });
      return true;
    }

    if (p === '/api/auth/logout' && req.method === 'POST') {
      send(res, 204, null, { 'Set-Cookie': cookieHeader(req, '', 0) });
      return true;
    }

    return false;
  }

  return { enabled, mode, isAuthed, route };
}

/* ------------------------------------------------------------------ CLI */

// One shared reader, so piped input (e.g. `printf 'pw\npw\n' | node server.js set-password`) works too.
function prompter() {
  const tty = Boolean(process.stdin.isTTY);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: tty });
  const lines = [];
  const waiting = [];
  let current = null;
  rl.on('line', (l) => (waiting.length ? waiting.shift()(l) : lines.push(l)));
  rl.on('close', () => { while (waiting.length) waiting.shift()(''); });
  if (tty) {
    // Echo the prompt, hide what is typed.
    rl._writeToOutput = (s) => {
      if (current && s.includes(current)) process.stdout.write(current);
      else if (/[\r\n]/.test(s)) process.stdout.write('\n');
    };
  }
  return {
    ask(question) {
      current = question;
      process.stdout.write(question);
      if (!tty && lines.length) { process.stdout.write('\n'); return Promise.resolve(lines.shift()); }
      return new Promise((resolve) => waiting.push((l) => { if (!tty) process.stdout.write('\n'); resolve(l); }));
    },
    close: () => rl.close(),
  };
}

async function setPasswordCli(dataDir, env = process.env) {
  if (env.MARGINALIA_PASSWORD) {
    console.log('\n  MARGINALIA_PASSWORD is set in the environment, and it takes precedence.');
    console.log('  Change it there (e.g. in .env) and restart instead.\n');
    process.exit(1);
  }
  const io = prompter();
  const pw = await io.ask('  New password: ');
  if (pw.length < 8) { console.log('  Please use at least 8 characters.'); process.exit(1); }
  const again = await io.ask('  Once more: ');
  io.close();
  if (pw !== again) { console.log('  Those did not match.'); process.exit(1); }
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(path.join(dataDir, '.auth.json'),
    JSON.stringify({ password: await hashPassword(pw), set: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 });
  console.log('\n  Password saved. Restart Marginalia for it to take effect; existing sessions are signed out.\n');
}

module.exports = { createAuth, setPasswordCli, isLoopback };
