'use strict';
/*
 * Marginalia — a private literary wiki for works in progress.
 * Zero dependencies: run with `node server.js` (Node 18+).
 *
 * Everything you write is stored as plain Markdown files under ./data,
 * so your work stays readable, greppable and easy to back up or put in git.
 *
 *   node server.js                 start the server
 *   node server.js set-password    set or change the sign-in password
 */

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { URL } = require('node:url');
const { createAuth, setPasswordCli, isLoopback } = require('./auth');

const PORT = Number(process.env.PORT) || 4321;
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.resolve(process.env.MARGINALIA_DATA || path.join(__dirname, 'data'));
const PROJECTS_DIR = path.join(DATA_DIR, 'projects');
const TRASH_DIR = path.join(DATA_DIR, 'trash');

const CATEGORIES = ['manuscript', 'characters', 'places', 'lore', 'notes'];
const STATUSES = ['idea', 'drafting', 'revising', 'complete'];
const ID_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;

/* ------------------------------------------------------------------ helpers */

const today = () => new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD, local time
const oneLine = (s, max = 200) => String(s ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, max);
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function slugify(s) {
  return String(s || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 60).replace(/-+$/, '') || 'untitled';
}

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function uniqueName(dir, base, ext = '') {
  let name = base, n = 2;
  while (await exists(path.join(dir, name + ext))) name = `${base}-${n++}`;
  return name;
}

async function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, data, 'utf8');
  await fs.rename(tmp, file);
}

function countWords(text) {
  const plain = String(text || '').replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2');
  const m = plain.match(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu);
  return m ? m.length : 0;
}

function plainText(body) {
  return String(body || '')
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/[#>*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const linkPattern = (title, flags) =>
  new RegExp(`\\[\\[\\s*${escRe(title)}\\s*(\\|[^\\]]*)?\\]\\]`, flags);

// Tiny front-matter: `key: value` lines between --- fences.
function parseDoc(raw) {
  raw = raw.replace(/\r\n/g, '\n');
  const meta = {};
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { meta, body: raw };
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { meta, body: raw.slice(m[0].length).replace(/^\n+/, '') };
}

function serializeDoc(meta, body) {
  const lines = Object.entries(meta)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}: ${oneLine(v, 500)}`);
  return `---\n${lines.join('\n')}\n---\n\n${String(body || '').replace(/^\n+/, '')}`;
}

// Serialise writes per project so read-modify-write never interleaves.
const locks = new Map();
function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => {});
  locks.set(key, tail);
  tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
  return run;
}

/* ------------------------------------------------------------------ storage */

const projDir = (id) => path.join(PROJECTS_DIR, id);
const filesDir = (id) => path.join(projDir(id), 'files');
const metaPath = (id) => path.join(projDir(id), 'project.json');
const entryPath = (pid, fid) => path.join(filesDir(pid), `${fid}.md`);

async function readProject(id) {
  if (!ID_RE.test(id)) return null;
  try {
    const p = JSON.parse(await fs.readFile(metaPath(id), 'utf8'));
    return {
      title: 'Untitled', subtitle: '', description: '', status: 'drafting',
      goal: 0, history: {}, ...p, id,
    };
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

async function saveProject(p) {
  const { id, ...rest } = p;
  rest.updated = new Date().toISOString();
  await writeAtomic(metaPath(id), JSON.stringify(rest, null, 2) + '\n');
}

async function readEntry(pid, fid) {
  if (!ID_RE.test(fid)) return null;
  const fp = entryPath(pid, fid);
  let raw, st;
  try {
    [raw, st] = await Promise.all([fs.readFile(fp, 'utf8'), fs.stat(fp)]);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  const { meta, body } = parseDoc(raw);
  return {
    id: fid,
    title: meta.title || fid,
    category: CATEGORIES.includes(meta.category) ? meta.category : 'notes',
    order: Number(meta.order) || 0,
    created: meta.created || st.birthtime.toISOString(),
    updated: st.mtime.toISOString(),
    words: countWords(body),
    body,
  };
}

async function writeEntry(pid, e, { keepTime = false } = {}) {
  const fp = entryPath(pid, e.id);
  const meta = {
    title: oneLine(e.title),
    category: e.category,
    order: e.category === 'manuscript' ? e.order : undefined,
    created: e.created,
  };
  await writeAtomic(fp, serializeDoc(meta, e.body));
  if (keepTime && e.updated) {
    const d = new Date(e.updated);
    await fs.utimes(fp, d, d);
  }
}

const sortEntries = (a, b) =>
  a.category !== b.category
    ? CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category)
    : a.category === 'manuscript'
      ? (a.order - b.order) || a.title.localeCompare(b.title)
      : a.title.localeCompare(b.title);

async function listEntries(pid, withBody = false) {
  let names = [];
  try { names = await fs.readdir(filesDir(pid)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const ids = names.filter((n) => n.endsWith('.md')).map((n) => n.slice(0, -3)).filter((id) => ID_RE.test(id));
  const entries = (await Promise.all(ids.map((id) => readEntry(pid, id)))).filter(Boolean);
  return entries
    .map((e) => {
      if (withBody) return e;
      const { body, ...rest } = e;
      rest.excerpt = plainText(body).slice(0, 160);
      return rest;
    })
    .sort(sortEntries);
}

async function nextOrder(pid) {
  const ms = (await listEntries(pid)).filter((e) => e.category === 'manuscript');
  return ms.reduce((m, e) => Math.max(m, e.order), 0) + 1;
}

async function recordWords(pid, delta) {
  if (!delta) return;
  const p = await readProject(pid);
  if (!p) return;
  p.history = p.history || {};
  const k = today();
  p.history[k] = (p.history[k] || 0) + delta;
  await saveProject(p);
}

function summarize(p, entries) {
  const ms = entries.filter((e) => e.category === 'manuscript');
  const lastTouched = [p.updated, ...entries.map((e) => e.updated)].filter(Boolean).sort().pop() || null;
  return {
    manuscriptWords: ms.reduce((s, e) => s + e.words, 0),
    totalWords: entries.reduce((s, e) => s + e.words, 0),
    chapters: ms.length,
    entries: entries.length,
    byCategory: Object.fromEntries(CATEGORIES.map((c) => [c, entries.filter((e) => e.category === c).length])),
    lastTouched,
  };
}

function activity(history = {}, days = 30) {
  const out = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(now.getDate() - i);
    const key = d.toLocaleDateString('sv-SE');
    out.push({ date: key, words: history[key] || 0 });
  }
  // Streak counts back from today; an empty "today" doesn't break it yet.
  let streak = 0;
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i].words > 0) streak++;
    else if (i === out.length - 1) continue;
    else break;
  }
  return { days: out, streak };
}

async function moveToTrash(src, name, ext = '') {
  await fs.mkdir(TRASH_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await fs.rename(src, path.join(TRASH_DIR, `${name}--${stamp}${ext}`));
}

/* ------------------------------------------------------------------ http */

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function send(res, status, data, headers = {}) {
  if (status === 204) { res.writeHead(204, headers); return res.end(); }
  const body = typeof data === 'string' ? data : JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': typeof data === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 10 * 1024 * 1024) throw new HttpError(413, 'That is longer than ten megabytes.');
    chunks.push(c);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'Could not read the request.'); }
}

async function needProject(pid) {
  const p = await readProject(pid);
  if (!p) throw new HttpError(404, 'No such work in the library.');
  return p;
}

async function needEntry(pid, fid) {
  const e = await readEntry(pid, fid);
  if (!e) throw new HttpError(404, 'No such page in this work.');
  return e;
}

/* ------------------------------------------------------------------ routes */

const routes = [];
const route = (method, pattern, handler) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
  routes.push({ method, re, keys, handler });
};

route('GET', '/api/projects', async () => {
  await fs.mkdir(PROJECTS_DIR, { recursive: true });
  const dirs = (await fs.readdir(PROJECTS_DIR, { withFileTypes: true }))
    .filter((d) => d.isDirectory() && ID_RE.test(d.name));
  const projects = (await Promise.all(dirs.map(async (d) => {
    const p = await readProject(d.name);
    if (!p) return null;
    const { history, ...rest } = p;
    return { ...rest, stats: summarize(p, await listEntries(p.id)) };
  }))).filter(Boolean)
    .sort((a, b) => (b.stats.lastTouched || '').localeCompare(a.stats.lastTouched || ''));
  return { projects };
});

route('POST', '/api/projects', async ({ body }) => {
  const title = oneLine(body.title);
  if (!title) throw new HttpError(400, 'A work needs a title, even a provisional one.');
  await fs.mkdir(PROJECTS_DIR, { recursive: true });
  const id = await uniqueName(PROJECTS_DIR, slugify(title));
  await fs.mkdir(filesDir(id), { recursive: true });
  const p = {
    id, title,
    subtitle: oneLine(body.subtitle),
    description: String(body.description || '').slice(0, 4000),
    status: STATUSES.includes(body.status) ? body.status : 'drafting',
    goal: Math.max(0, parseInt(body.goal, 10) || 0),
    created: new Date().toISOString(),
    history: {},
  };
  await saveProject(p);
  const { history, ...rest } = p;
  return [201, { project: rest }];
});

route('GET', '/api/projects/:pid', async ({ pid }) => {
  const p = await needProject(pid);
  const entries = await listEntries(pid);
  const { history, ...rest } = p;
  return { project: rest, entries, stats: summarize(p, entries), activity: activity(history) };
});

route('PUT', '/api/projects/:pid', ({ pid, body }) => withLock(pid, async () => {
  const p = await needProject(pid);
  if (typeof body.title === 'string' && body.title.trim()) p.title = oneLine(body.title);
  if (typeof body.subtitle === 'string') p.subtitle = oneLine(body.subtitle);
  if (typeof body.description === 'string') p.description = body.description.slice(0, 4000);
  if (STATUSES.includes(body.status)) p.status = body.status;
  if (body.goal !== undefined) p.goal = Math.max(0, parseInt(body.goal, 10) || 0);
  await saveProject(p);
  const { history, ...rest } = p;
  return { project: rest };
}));

route('DELETE', '/api/projects/:pid', ({ pid }) => withLock(pid, async () => {
  await needProject(pid);
  await moveToTrash(projDir(pid), pid);
  return [204];
}));

route('POST', '/api/projects/:pid/entries', ({ pid, body }) => withLock(pid, async () => {
  await needProject(pid);
  const title = oneLine(body.title);
  if (!title) throw new HttpError(400, 'Every page needs a title.');
  const category = CATEGORIES.includes(body.category) ? body.category : 'notes';
  await fs.mkdir(filesDir(pid), { recursive: true });
  const id = await uniqueName(filesDir(pid), slugify(title), '.md');
  const entry = {
    id, title, category,
    order: category === 'manuscript' ? await nextOrder(pid) : 0,
    created: new Date().toISOString(),
    body: String(body.body || ''),
  };
  await writeEntry(pid, entry);
  await recordWords(pid, countWords(entry.body));
  return [201, { entry: await readEntry(pid, id) }];
}));

route('GET', '/api/projects/:pid/entries/:fid', async ({ pid, fid }) => {
  await needProject(pid);
  const entry = await needEntry(pid, fid);
  const re = linkPattern(entry.title, 'i');
  const backlinks = (await listEntries(pid, true))
    .filter((x) => x.id !== fid && re.test(x.body))
    .map(({ id, title, category }) => ({ id, title, category }));
  return { entry, backlinks };
});

route('PUT', '/api/projects/:pid/entries/:fid', ({ pid, fid, body }) => withLock(pid, async () => {
  await needProject(pid);
  const old = await needEntry(pid, fid);
  const next = { ...old };
  if (typeof body.title === 'string' && body.title.trim()) next.title = oneLine(body.title);
  if (CATEGORIES.includes(body.category)) next.category = body.category;
  if (typeof body.body === 'string') next.body = body.body;
  if (next.category === 'manuscript' && old.category !== 'manuscript') next.order = await nextOrder(pid);

  await writeEntry(pid, next);
  await recordWords(pid, countWords(next.body) - old.words);

  // Renaming a page rewrites [[Old title]] links everywhere else in the work.
  let renamedIn = 0;
  if (next.title !== old.title) {
    const re = linkPattern(old.title, 'gi');
    for (const other of await listEntries(pid, true)) {
      if (other.id === fid) continue;
      const updated = other.body.replace(re, (_, label) => `[[${next.title}${label || ''}]]`);
      if (updated !== other.body) {
        await writeEntry(pid, { ...other, body: updated }, { keepTime: true });
        renamedIn++;
      }
    }
  }
  return { entry: await readEntry(pid, fid), renamedIn };
}));

route('DELETE', '/api/projects/:pid/entries/:fid', ({ pid, fid }) => withLock(pid, async () => {
  await needProject(pid);
  await needEntry(pid, fid);
  await moveToTrash(entryPath(pid, fid), `${pid}--${fid}`, '.md');
  return [204];
}));

route('POST', '/api/projects/:pid/reorder', ({ pid, body }) => withLock(pid, async () => {
  await needProject(pid);
  const ids = Array.isArray(body.ids) ? body.ids.filter((x) => typeof x === 'string' && ID_RE.test(x)) : [];
  let order = 0;
  for (const id of ids) {
    const e = await readEntry(pid, id);
    if (e && e.category === 'manuscript') {
      e.order = ++order;
      await writeEntry(pid, e, { keepTime: true });
    }
  }
  return [204];
}));

route('GET', '/api/projects/:pid/search', async ({ pid, query }) => {
  await needProject(pid);
  const q = String(query.get('q') || '').trim().toLowerCase();
  if (!q) return { results: [] };
  const results = [];
  for (const e of await listEntries(pid, true)) {
    const inTitle = e.title.toLowerCase().includes(q);
    const plain = plainText(e.body);
    const i = plain.toLowerCase().indexOf(q);
    if (!inTitle && i < 0) continue;
    let snippet = '';
    if (i >= 0) {
      const s = Math.max(0, i - 60), end = i + q.length + 90;
      snippet = (s > 0 ? '…' : '') + plain.slice(s, end) + (end < plain.length ? '…' : '');
    }
    results.push({ id: e.id, title: e.title, category: e.category, snippet, score: inTitle ? 2 : 1 });
  }
  results.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
  return { results: results.slice(0, 50) };
});

route('GET', '/api/projects/:pid/export', async ({ pid }) => {
  const p = await needProject(pid);
  const chapters = (await listEntries(pid, true)).filter((e) => e.category === 'manuscript');
  const unlink = (s) => s.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2').replace(/\[\[([^\]]+)\]\]/g, '$1');
  let out = `# ${p.title}\n\n`;
  if (p.subtitle) out += `*${p.subtitle}*\n\n`;
  for (const c of chapters) out += `\n## ${c.title}\n\n${unlink(c.body).trim()}\n\n`;
  return [200, out, {
    'Content-Type': 'text/markdown; charset=utf-8',
    'Content-Disposition': `attachment; filename="${pid}.md"`,
  }];
});

/* ------------------------------------------------------------------ static */

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

async function serveFile(rel, res) {
  const fp = path.join(PUBLIC_DIR, rel);
  if (!fp.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Forbidden');
  try {
    const data = await fs.readFile(fp);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  } catch {
    send(res, 404, 'Not found');
  }
}

const serveStatic = (pathname, res) =>
  serveFile(pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, ''), res);

// What a signed-out visitor may load: the login page's own stylesheet and nothing else.
const PUBLIC_PATHS = new Set(['/style.css']);

let auth = { enabled: false, isAuthed: () => true, route: async () => false };

// Refuse state-changing requests that come from another site.
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const o = new URL(origin).host;
    const hosts = [req.headers.host, req.headers['x-forwarded-host']].filter(Boolean).map((h) => String(h).split(',')[0].trim());
    return hosts.includes(o);
  } catch {
    return false;
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  try {
    if (url.pathname === '/healthz') return send(res, 200, 'ok');

    if (!['GET', 'HEAD'].includes(req.method) && !sameOrigin(req)) {
      throw new HttpError(403, 'Requests from other sites are not allowed.');
    }

    if (await auth.route(req, res, url, { send, readJson, serveFile })) return;

    if (!auth.isAuthed(req)) {
      if (url.pathname.startsWith('/api/')) throw new HttpError(401, 'Please sign in.');
      if (PUBLIC_PATHS.has(url.pathname)) return await serveStatic(url.pathname, res);
      res.writeHead(302, { Location: '/login', 'Cache-Control': 'no-store' });
      return res.end();
    }

    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
      if (url.pathname === '/login.html') return serveStatic('/', res);
      return await serveStatic(url.pathname, res);
    }
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = url.pathname.match(r.re);
      if (!m) continue;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      for (const [k, v] of Object.entries(params)) {
        if (!ID_RE.test(v)) throw new HttpError(400, `That is not a valid ${k === 'pid' ? 'work' : 'page'} id.`);
      }
      const body = ['POST', 'PUT'].includes(req.method) ? await readJson(req) : {};
      const result = await r.handler({ ...params, body, query: url.searchParams });
      if (Array.isArray(result)) return send(res, result[0], result[1], result[2]);
      return send(res, 200, result);
    }
    throw new HttpError(404, 'Not found.');
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    if (!res.headersSent) send(res, status, { error: status >= 500 ? `Something went wrong: ${err.message}` : err.message });
  }
});

/* ------------------------------------------------------------------ seed */

async function seedIfEmpty() {
  await fs.mkdir(PROJECTS_DIR, { recursive: true });
  const existing = (await fs.readdir(PROJECTS_DIR)).filter((n) => !n.startsWith('.'));
  if (existing.length) return;

  const id = 'the-lighthouse-keepers-almanac';
  await fs.mkdir(filesDir(id), { recursive: true });
  const created = new Date().toISOString();
  await saveProject({
    id, created, history: {},
    title: 'The Lighthouse Keeper’s Almanac',
    subtitle: 'A novel',
    description: 'A keeper on a granite rock, a ledger with pages missing, and a letter that says the light is to be automated. A sample work — rename it, rewrite it, or move it to the trash.',
    status: 'drafting',
    goal: 70000,
  });

  const pages = [
    ['The Lamp Room', 'manuscript', 1,
      'The lamp was lit at four, as it had been every evening for sixty-one years, and [[Ines Calloway]] climbed the hundred and twelve steps of [[Gannet Rock]] with the oil can knocking against her knee.\n\nShe kept [[The Almanac|the almanac]] open on the brass rail while she worked. Her father had begun it; she had never once thought of it as hers.\n\nBelow, the sea was doing what it always did at that hour, which was to pretend to be calm.'],
    ['Fog Signals', 'manuscript', 2,
      'The letter from [[The Inspector]] arrived on a Tuesday, folded twice and smelling of the mainland.\n\n> The Board regrets to inform you…\n\nInes read it standing up, then sitting down, then not at all.'],
    ['Ines Calloway', 'characters', 0,
      '- **Age:** thirty-four\n- **Keeper since:** her father’s death, nine winters ago\n\nPrecise, private, and funnier than she lets on. Talks to the lamp. Has never left [[Gannet Rock]] for longer than a week.\n\n## Wants\n\nTo be left alone with the light.\n\n## Needs\n\nTo find out what her father wrote on the pages he cut from [[The Almanac]].'],
    ['The Inspector', 'characters', 0,
      'Unnamed on purpose, for now. Arrives in [[Fog Signals]]. Represents the Board, automation, the end of things — but should not be a villain. Give him a reason to love lighthouses.'],
    ['Gannet Rock', 'places', 0,
      'A granite stack four miles off the coast. One tower, one cottage, one rain barrel, and a landing that can only be used at slack tide.\n\nHome to [[Ines Calloway]]. Visited, unwillingly, by [[The Inspector]].'],
    ['The Almanac', 'lore', 0,
      'A ledger of weather, ships and lamp hours kept by two generations of Calloways. Several pages near the back have been cut out with a razor.\n\nSee also [[Ines Calloway]] and [[The Missing Pages]].'],
    ['Open Questions', 'notes', 0,
      '- What was on the missing pages?\n- Is the light automated in the end, or does Ines refuse?\n- The title is a placeholder. Perhaps *Slack Tide*?'],
  ];
  for (const [title, category, order, body] of pages) {
    await writeEntry(id, { id: slugify(title), title, category, order, created, body });
  }
  console.log('  A sample work has been placed on the shelf.');
}

/* ------------------------------------------------------------------ start */

async function start() {
  auth = await createAuth({ dataDir: DATA_DIR });
  if (!auth.enabled && !isLoopback(HOST) && !/^(1|true|yes)$/i.test(process.env.MARGINALIA_NO_AUTH || '')) {
    console.error(`
  Marginalia is set to listen on ${HOST}, which other machines can reach,
  but no password is set. Either:

    - set MARGINALIA_PASSWORD (e.g. in .env for Docker), or
    - run \`node server.js set-password\`, or
    - set MARGINALIA_NO_AUTH=1 if something else in front of it handles sign-in.
`);
    process.exit(1);
  }
  await seedIfEmpty();
  server.listen(PORT, HOST, () => {
    console.log(`\n  Marginalia is open at http://${HOST === '0.0.0.0' || HOST === '::' ? 'localhost' : HOST}:${PORT}`);
    console.log(`  Your writing lives in ${DATA_DIR}`);
    console.log(`  Sign-in: ${{ env: 'password from MARGINALIA_PASSWORD', file: 'password from set-password', off: 'off (localhost only)' }[auth.mode]}\n`);
  });
}

const shutdown = () => server.close(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

if (process.argv[2] === 'set-password') {
  setPasswordCli(DATA_DIR).catch((err) => { console.error(err); process.exit(1); });
} else {
  start().catch((err) => {
    if (err.code === 'EACCES' || err.code === 'EPERM') {
      const uid = typeof process.getuid === 'function' ? process.getuid() : '?';
      const gid = typeof process.getgid === 'function' ? process.getgid() : '?';
      console.error(`
  Marginalia cannot write to ${DATA_DIR} (${err.code} on ${err.path || 'it'}).
  It is running as user ${uid}:${gid}. Make that folder belong to this user, e.g. on the host:

    sudo chown -R ${uid}:${gid} ./data

  (With Docker, this usually means ./data was created by Docker as root
  before the first start. Create it yourself with \`mkdir data\` first.)
`);
    } else {
      console.error(err);
    }
    process.exit(1);
  });
}
