'use strict';
/* Marginalia front end — vanilla JS, hash routing:
 *   #/                    the library
 *   #/p/:work             a work's dashboard
 *   #/p/:work/f/:page     the editor
 */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const app = $('#app');

const CATS = {
  manuscript: { label: 'Manuscript', one: 'Chapter' },
  characters: { label: 'Characters', one: 'Character' },
  places: { label: 'Places', one: 'Place' },
  lore: { label: 'Lore', one: 'Lore entry' },
  notes: { label: 'Notes', one: 'Note' },
};
const STATUSES = { idea: 'An idea', drafting: 'Drafting', revising: 'Revising', complete: 'Complete' };
const WORD_RE = /[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu;
const WIKI_RE = /\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/g;

/* ---------------------------------------------------------------- utilities */

async function api(url, { method = 'GET', body } = {}) {
  const init = { method, headers: {} };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const r = await fetch(url, init);
  if (r.status === 401 && !url.startsWith('/api/auth/')) {
    location.href = '/login' + location.hash;
    throw new Error('Your session has ended. Please sign in again.');
  }
  if (r.status === 204) return null;
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}
const P = (id) => `/api/projects/${encodeURIComponent(id)}`;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const num = (x) => Number(x || 0).toLocaleString();
const plural = (n, one, many = one + 's') => `${num(n)} ${n === 1 ? one : many}`;
const countWords = (t) => (String(t || '').replace(WIKI_RE, (m, a, b) => b || a).match(WORD_RE) || []).length;

function ago(iso) {
  if (!iso) return '—';
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} hr ago`;
  if (s < 172800) return 'yesterday';
  if (s < 30 * 86400) return `${Math.floor(s / 86400)} days ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
}

function roman(n) {
  const map = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let out = '';
  for (const [v, s] of map) while (n >= v) { out += s; n -= v; }
  return out;
}

function hue(str) {
  let h = 7;
  for (const c of str) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

function toast(msg) {
  let t = $('#toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    t.setAttribute('role', 'status');
    document.body.append(t);
  }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), 3400);
}
window.addEventListener('unhandledrejection', (e) => toast(e.reason?.message || 'Something went wrong.'));

const crumbs = (items) =>
  `<nav class="crumbs" aria-label="Breadcrumb">${items
    .map(([href, label]) => (href ? `<a href="${href}">${esc(label)}</a>` : `<span>${esc(label)}</span>`))
    .join('<span class="sep" aria-hidden="true">›</span>')}</nav>`;

/* ---------------------------------------------------------------- dialogs */

function field(f) {
  const id = `f-${f.name}`;
  const v = f.value ?? '';
  let input;
  if (f.type === 'textarea') {
    input = `<textarea id="${id}" name="${f.name}" rows="${f.rows || 4}" placeholder="${esc(f.placeholder || '')}">${esc(v)}</textarea>`;
  } else if (f.type === 'select') {
    input = `<select id="${id}" name="${f.name}">${Object.entries(f.options)
      .map(([k, label]) => `<option value="${esc(k)}"${k === v ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select>`;
  } else {
    const extra = f.type === 'number' ? ' min="0" step="1000" inputmode="numeric"' : '';
    input = `<input id="${id}" name="${f.name}" type="${f.type || 'text'}" value="${esc(v)}" placeholder="${esc(f.placeholder || '')}"${f.required ? ' required' : ''}${extra} autocomplete="off">`;
  }
  return `<label class="field" for="${id}"><span>${esc(f.label)}</span>${input}</label>`;
}

/** Resolves to { action: 'ok' | 'cancel' | <extra button value>, values } */
function dialog({ title, intro = '', fields = [], submit = 'Save', danger = false, extraButtons = '' }) {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.className = 'dlg';
    d.innerHTML = `<form method="dialog">
      <h2>${esc(title)}</h2>
      ${intro ? `<p class="dlg-intro">${intro}</p>` : ''}
      ${fields.map(field).join('')}
      <div class="dlg-actions">${extraButtons}<span class="spacer"></span>
        <button class="btn ghost" type="button" data-close="cancel">Cancel</button>
        <button class="btn${danger ? ' danger' : ''}" value="ok">${esc(submit)}</button>
      </div></form>`;
    // Only the primary button is a submit button, so pressing Enter always means "OK".
    // Everything else closes the dialog explicitly.
    d.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-close]');
      if (b) d.close(b.dataset.close);
    });
    document.body.append(d);
    d.addEventListener('close', () => {
      const values = Object.fromEntries(new FormData(d.querySelector('form')));
      const action = d.returnValue || 'cancel';
      d.remove();
      resolve({ action, values });
    });
    d.showModal();
    (d.querySelector('input, textarea') || d.querySelector('button[value=ok]')).focus();
  });
}

const confirmDialog = (title, intro, submit) =>
  dialog({ title, intro, submit, danger: true }).then((r) => r.action === 'ok');

/* ---------------------------------------------------------------- session */

let authEnabled = false;
const colophon = () => authEnabled
  ? `<footer class="colophon"><span aria-hidden="true">❦</span><br><button class="link" type="button" data-signout>Sign out</button></footer>`
  : '';

document.addEventListener('click', async (ev) => {
  if (!ev.target.closest('[data-signout]')) return;
  if (cleanup) { const c = cleanup; cleanup = null; await c(); }
  await api('/api/auth/logout', { method: 'POST' });
  location.href = '/login';
});

/* ---------------------------------------------------------------- router */

let cleanup = null;

async function route() {
  if (cleanup) { const c = cleanup; cleanup = null; await c(); }
  const parts = (location.hash.slice(1) || '/').split('?')[0].split('/').filter(Boolean).map(decodeURIComponent);
  window.scrollTo(0, 0);
  try {
    if (parts.length === 0) return await viewLibrary();
    if (parts[0] === 'p' && parts.length === 2) return await viewWork(parts[1]);
    if (parts[0] === 'p' && parts[2] === 'f' && parts.length === 4) return await viewEditor(parts[1], parts[3]);
    throw new Error('There is nothing at this address.');
  } catch (e) {
    document.title = 'Marginalia';
    app.innerHTML = `<div class="page"><header class="masthead"><div class="ornament">❦</div>
      <p class="lede">${esc(e.message)}</p><p><a class="btn ghost" href="#/">Return to the library</a></p></header></div>`;
  }
}
window.addEventListener('hashchange', route);

/* ---------------------------------------------------------------- the library */

async function viewLibrary() {
  document.title = 'Marginalia';
  const { projects } = await api('/api/projects');
  const words = projects.reduce((s, p) => s + p.stats.manuscriptWords, 0);
  app.innerHTML = `
  <div class="page">
    <header class="masthead">
      <p class="eyebrow">A private library of works in progress</p>
      <h1 class="wordmark">Marginalia</h1>
      <div class="ornament" aria-hidden="true">❦</div>
      <p class="lede">${projects.length
        ? `${plural(projects.length, 'work')} on the shelf · ${num(words)} words of manuscript`
        : 'Every library begins with a single volume.'}</p>
    </header>
    <section class="shelf" aria-label="Works">
      ${projects.map(volume).join('')}
      <button class="volume volume-new" id="new-work" type="button">
        <span class="plus" aria-hidden="true">+</span><span class="sc">Begin a new work</span>
      </button>
    </section>
    ${colophon()}
  </div>`;
  $('#new-work').onclick = newWork;
}

function volume(p) {
  const s = p.stats;
  const pct = p.goal ? Math.min(100, Math.round((s.manuscriptWords / p.goal) * 100)) : null;
  return `<a class="volume" href="#/p/${p.id}" style="--h:${hue(p.id)}">
    <span class="spine" aria-hidden="true"></span>
    <span class="sc status">${esc(STATUSES[p.status] || p.status)}</span>
    <h2>${esc(p.title)}</h2>
    ${p.subtitle ? `<p class="sub">${esc(p.subtitle)}</p>` : ''}
    <div class="vol-foot">
      ${pct !== null ? `<div class="bar" title="${pct}% of ${num(p.goal)} words"><i style="width:${pct}%"></i></div>` : ''}
      <div class="vol-meta"><span>${num(s.manuscriptWords)} words · ${plural(s.chapters, 'chapter')}</span><span>${ago(s.lastTouched)}</span></div>
    </div>
  </a>`;
}

async function newWork() {
  const { action, values } = await dialog({
    title: 'Begin a new work',
    submit: 'Place it on the shelf',
    fields: [
      { name: 'title', label: 'Title', required: true, placeholder: 'A working title will do' },
      { name: 'subtitle', label: 'Subtitle or form', placeholder: 'A novel, a cycle of poems, a play in three acts…' },
      { name: 'description', label: 'What it is about', type: 'textarea', rows: 3 },
      { name: 'goal', label: 'Word goal (optional)', type: 'number', placeholder: '80000' },
    ],
  });
  if (action !== 'ok') return;
  const { project } = await api('/api/projects', { method: 'POST', body: values });
  location.hash = `#/p/${project.id}`;
}

/* ---------------------------------------------------------------- a work's dashboard */

const CODEX = ['characters', 'places', 'lore', 'notes'];
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

async function viewWork(pid) {
  const { project: p, entries, stats: s, activity: a } = await api(P(pid));
  document.title = `${p.title} — Marginalia`;
  const pct = p.goal ? Math.min(100, Math.round((s.manuscriptWords / p.goal) * 100)) : null;
  const chapters = entries.filter((e) => e.category === 'manuscript');
  const recent = [...entries].sort((x, y) => y.updated.localeCompare(x.updated)).slice(0, 4);
  const todayWords = a.days.at(-1).words;
  const monthWords = a.days.reduce((t, d) => t + Math.max(0, d.words), 0);
  const counts = Object.fromEntries(CODEX.map((c) => [c, entries.filter((e) => e.category === c).length]));
  const tabKey = `marginalia:tab:${pid}`;
  let tab = store.get(tabKey);
  if (!CODEX.includes(tab)) tab = CODEX.find((c) => counts[c]) || 'characters';
  const shortDate = (d) => new Date(`${d}T12:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

  app.innerHTML = `
  <div class="page">
    ${crumbs([['#/', 'Library'], [null, p.title]])}
    <header class="title-page">
      <p class="eyebrow">${esc(STATUSES[p.status] || p.status)}</p>
      <h1>${esc(p.title)}</h1>
      ${p.subtitle ? `<p class="sub">${esc(p.subtitle)}</p>` : ''}
      ${p.description ? `<p class="desc">${esc(p.description)}</p>` : ''}
      <div class="actions">
        <button class="btn" type="button" data-new="manuscript">New chapter</button>
        <button class="btn ghost" type="button" data-new="">New entry</button>
        <a class="btn ghost" href="${P(pid)}/export" download>Export manuscript</a>
        <button class="btn ghost" type="button" id="settings">Settings</button>
      </div>
    </header>

    <section class="stats" aria-label="Progress">
      ${stat(num(s.manuscriptWords), 'words of manuscript')}
      ${stat(pct !== null ? `${pct}%` : '—', p.goal ? `of ${num(p.goal)}` : 'no goal set')}
      ${stat(`${todayWords > 0 ? '+' : ''}${num(todayWords)}`, 'net words today')}
      ${stat(num(a.streak), a.streak === 1 ? 'day in a row' : 'days in a row')}
    </section>
    ${pct !== null ? `<div class="goal-bar" aria-hidden="true"><i style="width:${pct}%"></i></div>` : ''}

    <div class="dash-grid">
      <section class="panel">
        <header><h2>Thirty days</h2><span class="sc muted">${num(monthWords)} words added</span></header>
        ${chart(a.days)}
        <div class="chart-axis muted"><span>${shortDate(a.days[0].date)}</span><span>today</span></div>
      </section>
      ${recent.length ? `<section class="panel">
        <header><h2>Lately</h2></header>
        <ul class="recent">${recent.map((e) => `<li>
          <a href="#/p/${pid}/f/${e.id}">${esc(e.title)}</a>
          <span class="muted when">${ago(e.updated)}</span></li>`).join('')}</ul>
      </section>` : ''}
    </div>

    <section class="panel manuscript">
      <header><h2>Manuscript</h2><span class="sc muted">${plural(chapters.length, 'chapter')} · ${num(s.manuscriptWords)} words</span></header>
      ${chapters.length ? `<ol class="chapters">${chapters.map((c, i) => `
        <li data-id="${c.id}">
          <a href="#/p/${pid}/f/${c.id}"><span class="num">${roman(i + 1)}.</span><span class="t">${esc(c.title)}</span></a>
          <span class="wc">${num(c.words)}</span>
          <span class="reorder">
            <button type="button" aria-label="Move up" data-move="-1"${i === 0 ? ' disabled' : ''}>↑</button>
            <button type="button" aria-label="Move down" data-move="1"${i === chapters.length - 1 ? ' disabled' : ''}>↓</button>
          </span>
        </li>`).join('')}</ol>`
      : `<p class="empty">No chapters yet. <button class="link" type="button" data-new="manuscript">Write the first.</button></p>`}
    </section>

    <section class="panel codex">
      <header>
        <h2>Codex</h2>
        <input type="search" id="search" placeholder="Search everything in this work…" aria-label="Search this work">
      </header>
      <div class="tabs" role="tablist" aria-label="Codex sections">
        ${CODEX.map((c) => `<button type="button" role="tab" class="tab" id="tab-${c}" data-tab="${c}" aria-controls="codex-body">
          ${CATS[c].label}<span class="count">${counts[c]}</span></button>`).join('')}
      </div>
      <div id="codex-body" class="cards" role="tabpanel"></div>
    </section>
    ${colophon()}
  </div>`;

  const page = $('.page');
  const box = $('#codex-body');
  const search = $('#search');
  const tabs = $$('.tab');

  page.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-new]');
    if (b) newEntry(pid, b.dataset.new);
  });
  $('#settings').onclick = () => workSettings(p);

  /* codex: tabs + card grid, swapped for results while searching */
  const card = (e, text, q = '') => `<a class="card" href="#/p/${pid}/f/${e.id}">
      ${q ? `<span class="sc kind">${CATS[e.category].one}</span>` : ''}
      <strong>${q ? highlight(e.title, q) : esc(e.title)}</strong>
      ${text ? `<p>${q ? highlight(text, q) : esc(text)}</p>` : ''}</a>`;

  const showTab = (c, focus = false) => {
    tab = c;
    store.set(tabKey, c);
    tabs.forEach((t) => {
      const on = t.dataset.tab === c;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      if (on && focus) t.focus();
    });
    box.setAttribute('aria-labelledby', `tab-${c}`);
    const list = entries.filter((e) => e.category === c);
    box.innerHTML = list.map((e) => card(e, e.excerpt)).join('')
      + `<button type="button" class="card card-new" data-new="${c}">+ New ${CATS[c].one.toLowerCase()}</button>`;
  };

  tabs.forEach((t) => {
    t.onclick = () => { if (search.value) search.value = ''; showTab(t.dataset.tab); };
    t.onkeydown = (ev) => {
      const step = { ArrowRight: 1, ArrowLeft: -1 }[ev.key];
      if (!step) return;
      ev.preventDefault();
      showTab(CODEX[(CODEX.indexOf(tab) + step + CODEX.length) % CODEX.length], true);
    };
  });
  showTab(tab);

  let t;
  search.addEventListener('input', () => {
    clearTimeout(t);
    const q = search.value.trim();
    t = setTimeout(async () => {
      if (!q) { $('.tabs').classList.remove('dim'); showTab(tab); return; }
      const { results } = await api(`${P(pid)}/search?q=${encodeURIComponent(q)}`);
      if (search.value.trim() !== q) return;
      $('.tabs').classList.add('dim');
      box.innerHTML = results.length
        ? results.map((r) => card(r, r.snippet, q)).join('')
        : `<p class="empty">Nothing found for “${esc(q)}”.</p>`;
    }, 200);
  });
  search.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') $('#codex-body a.card')?.click();
  });

  /* manuscript reordering */
  $$('.chapters [data-move]').forEach((b) => {
    b.onclick = async () => {
      const ids = chapters.map((c) => c.id);
      const i = ids.indexOf(b.closest('li').dataset.id);
      const j = i + Number(b.dataset.move);
      [ids[i], ids[j]] = [ids[j], ids[i]];
      await api(`${P(pid)}/reorder`, { method: 'POST', body: { ids } });
      const y = window.scrollY;
      await viewWork(pid);
      window.scrollTo(0, y);
      $(`.chapters li[data-id="${ids[j]}"] [data-move="${b.dataset.move}"]`)?.focus();
    };
  });
}

const stat = (value, label) => `<div class="stat"><b>${value}</b><span class="sc">${esc(label)}</span></div>`;

function highlight(text, q) {
  return esc(text).replace(new RegExp(escRe(esc(q)), 'gi'), (m) => `<mark>${m}</mark>`);
}

function chart(days) {
  const W = 600, H = 84, gap = 4;
  const bw = (W - gap * (days.length - 1)) / days.length;
  const max = Math.max(300, ...days.map((d) => d.words));
  const bars = days.map((d, i) => {
    const v = d.words;
    const h = v > 0 ? Math.max(3, (v / max) * H) : v < 0 ? 3 : 1.5;
    const cls = v > 0 ? 'on' : v < 0 ? 'neg' : 'off';
    const label = new Date(`${d.date}T12:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    return `<rect x="${(i * (bw + gap)).toFixed(1)}" y="${(H - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="1.5" class="${cls}"><title>${label}: ${v > 0 ? '+' : ''}${num(v)} words</title></rect>`;
  }).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Words added per day over the last thirty days">${bars}</svg>`;
}

async function newEntry(pid, category = '', title = '') {
  const { action, values } = await dialog({
    title: category ? `New ${CATS[category].one.toLowerCase()}` : 'New entry',
    submit: 'Create',
    fields: [
      { name: 'title', label: 'Title', required: true, value: title },
      { name: 'category', label: 'Kind', type: 'select', value: category || 'notes',
        options: Object.fromEntries(Object.entries(CATS).map(([k, v]) => [k, v.one])) },
    ],
  });
  if (action !== 'ok') return;
  const { entry } = await api(`${P(pid)}/entries`, { method: 'POST', body: values });
  location.hash = `#/p/${pid}/f/${entry.id}`;
}

async function workSettings(p) {
  const { action, values } = await dialog({
    title: 'About this work',
    submit: 'Save',
    extraButtons: '<button class="btn ghost sm danger-text" type="button" data-close="trash">Move to trash</button>',
    fields: [
      { name: 'title', label: 'Title', required: true, value: p.title },
      { name: 'subtitle', label: 'Subtitle or form', value: p.subtitle },
      { name: 'description', label: 'What it is about', type: 'textarea', rows: 3, value: p.description },
      { name: 'status', label: 'Stage', type: 'select', value: p.status, options: STATUSES },
      { name: 'goal', label: 'Word goal', type: 'number', value: p.goal || '' },
    ],
  });
  if (action === 'ok') {
    await api(P(p.id), { method: 'PUT', body: values });
    await viewWork(p.id);
  } else if (action === 'trash') {
    const ok = await confirmDialog(
      `Move “${p.title}” to the trash?`,
      'Nothing is erased: the whole work is moved to <code>data/trash</code>, and you can restore it by moving the folder back.',
      'Move to trash');
    if (!ok) return;
    await api(P(p.id), { method: 'DELETE' });
    toast(`“${p.title}” was moved to the trash.`);
    location.hash = '#/';
  }
}

/* ---------------------------------------------------------------- the editor */

async function viewEditor(pid, fid) {
  const [{ project: p, entries }, { entry: e, backlinks }] = await Promise.all([
    api(P(pid)), api(`${P(pid)}/entries/${encodeURIComponent(fid)}`),
  ]);
  const state = { title: e.title, category: e.category, body: e.body };
  const startWords = e.words;
  let mode = e.category !== 'manuscript' && e.body.trim() ? 'read' : 'write';
  document.title = `${e.title} — ${p.title}`;

  const contents = Object.keys(CATS).map((c) => {
    const list = entries.filter((x) => x.category === c);
    if (!list.length) return '';
    return `<details class="side-group"${c === e.category ? ' open' : ''}>
      <summary><span class="sc">${CATS[c].label}</span><span class="muted">${list.length}</span></summary>
      <ul>${list.map((x) =>
      `<li><a href="#/p/${pid}/f/${x.id}"${x.id === fid ? ' class="current" aria-current="page"' : ''}>${esc(x.title)}</a></li>`).join('')}</ul>
    </details>`;
  }).join('');

  app.innerHTML = `
  <div class="editor" data-mode="${mode}" data-cat="${e.category}">
    <header class="ed-bar">
      ${crumbs([['#/', 'Library'], [`#/p/${pid}`, p.title], [null, CATS[e.category].label]])}
      <div class="ed-tools">
        <span class="sc muted" id="wc"></span>
        <span class="sc muted" id="status" aria-live="polite">Saved</span>
        <button class="btn ghost sm" type="button" id="toggle-mode"></button>
        <button class="btn ghost sm" type="button" id="focus" title="Focus mode — Esc to leave">Focus</button>
        <button class="btn ghost sm danger-text" type="button" id="trash">Trash</button>
      </div>
    </header>
    <div class="ed-body">
      <article class="ed-page">
        <div class="ed-kind"><select id="cat" aria-label="Kind of page">${Object.entries(CATS).map(([k, v]) =>
          `<option value="${k}"${k === e.category ? ' selected' : ''}>${v.one}</option>`).join('')}</select></div>
        <input id="title" class="ed-title" value="${esc(e.title)}" aria-label="Title" autocomplete="off">
        <textarea id="text" class="ed-text" spellcheck="true" aria-label="Text" placeholder="Begin anywhere…">${esc(e.body)}</textarea>
        <div id="preview" class="prose" title="Double-click to write"></div>
      </article>
      <aside class="ed-side">
        <section>
          <h3 class="sc">Linked from</h3>
          ${backlinks.length
            ? `<ul>${backlinks.map((b) => `<li><a href="#/p/${pid}/f/${b.id}">${esc(b.title)}</a></li>`).join('')}</ul>`
            : `<p class="muted small">Nothing links here yet. Write <code>[[${esc(e.title)}]]</code> on any page in this work.</p>`}
        </section>
        <section><h3 class="sc">In this work</h3>${contents}</section>
        <section>
          <h3 class="sc">Notation</h3>
          <p class="muted small"><code>*italic*</code> <code>**bold**</code> <code># heading</code> <code>&gt; quote</code>
          <code>***</code> for a section break. Link pages with <code>[[Name]]</code> or <code>[[Name|other words]]</code>.
          Ctrl/⌘ S saves, Ctrl/⌘ E switches between reading and writing.</p>
        </section>
      </aside>
    </div>
  </div>`;

  const editor = $('.editor');
  const ta = $('#text'), ti = $('#title'), pv = $('#preview'), st = $('#status'), wc = $('#wc');
  const titles = new Map(entries.map((x) => [x.title.toLowerCase(), x]));

  const render = (md) => {
    const src = md.replace(WIKI_RE, (m, t, label) => {
      const key = t.trim();
      const hit = titles.get(key.toLowerCase());
      const text = esc((label || t).trim());
      return hit
        ? `<a class="wl" href="#/p/${pid}/f/${hit.id}">${text}</a>`
        : `<a class="wl missing" href="#" data-create="${esc(key)}" title="Not written yet — click to create">${text}</a>`;
    });
    return src.trim() ? marked.parse(src) : '<p class="empty">This page is still blank. Double-click to begin.</p>';
  };

  const grow = () => {
    const y = window.scrollY;
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight}px`;
    window.scrollTo(0, y);
  };

  const updateWc = () => {
    const w = countWords(state.body);
    const d = w - startWords;
    wc.textContent = `${plural(w, 'word')}${d ? ` · ${d > 0 ? '+' : ''}${num(d)} this sitting` : ''}`;
  };

  const setMode = (m) => {
    mode = m;
    editor.dataset.mode = m;
    $('#toggle-mode').textContent = m === 'read' ? 'Write' : 'Read';
    if (m === 'read') pv.innerHTML = render(state.body);
    else { grow(); ta.focus({ preventScroll: true }); }
  };

  /* saving: debounced, serialised, never lost on navigation */
  let dirty = false, timer = null, chain = Promise.resolve();
  const setStatus = (s) => { st.textContent = s; };
  const save = () => {
    clearTimeout(timer);
    if (!dirty) return chain;
    dirty = false;
    const payload = { ...state };
    setStatus('Saving…');
    chain = chain
      .then(() => api(`${P(pid)}/entries/${encodeURIComponent(fid)}`, { method: 'PUT', body: payload }))
      .then((r) => {
        if (!dirty) setStatus('Saved');
        if (r?.renamedIn) toast(`Links updated on ${plural(r.renamedIn, 'other page')}.`);
      })
      .catch((err) => { dirty = true; setStatus('Not saved'); toast(err.message); });
    return chain;
  };
  const touch = () => {
    dirty = true;
    setStatus('Editing…');
    clearTimeout(timer);
    timer = setTimeout(save, 900);
  };

  ta.addEventListener('input', () => { state.body = ta.value; grow(); updateWc(); touch(); });

  // Titles save on blur/enter, so renaming rewrites links once, not per keystroke.
  ti.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); ta.focus(); } });
  ti.addEventListener('change', () => {
    const v = ti.value.trim();
    if (!v) { ti.value = state.title; return; }
    if (v === state.title) return;
    state.title = v;
    document.title = `${v} — ${p.title}`;
    dirty = true;
    save();
  });

  $('#cat').addEventListener('change', (ev) => {
    state.category = ev.target.value;
    editor.dataset.cat = state.category;
    $('.ed-bar .crumbs span:last-child').textContent = CATS[state.category].label;
    dirty = true;
    save();
  });

  $('#toggle-mode').onclick = () => setMode(mode === 'read' ? 'write' : 'read');
  pv.addEventListener('dblclick', () => setMode('write'));
  pv.addEventListener('click', async (ev) => {
    const a = ev.target.closest('a.missing');
    if (!a) return;
    ev.preventDefault();
    await save();
    newEntry(pid, '', a.dataset.create);
  });

  $('#focus').onclick = () => {
    const on = document.body.classList.toggle('focus');
    if (on) { setMode('write'); toast('Focus mode. Press Esc to return.'); }
  };

  $('#trash').onclick = async () => {
    const ok = await confirmDialog(
      `Move “${state.title}” to the trash?`,
      'The page is moved to <code>data/trash</code>, not erased. Links to it will show as unwritten.',
      'Move to trash');
    if (!ok) return;
    clearTimeout(timer);
    dirty = false;
    await chain;
    await api(`${P(pid)}/entries/${encodeURIComponent(fid)}`, { method: 'DELETE' });
    toast(`“${state.title}” was moved to the trash.`);
    location.hash = `#/p/${pid}`;
  };

  const onKey = (ev) => {
    const mod = ev.metaKey || ev.ctrlKey;
    const k = ev.key.toLowerCase();
    if (mod && k === 's') { ev.preventDefault(); save(); }
    else if (mod && k === 'e') { ev.preventDefault(); setMode(mode === 'read' ? 'write' : 'read'); }
    else if (ev.key === 'Escape' && document.body.classList.contains('focus') && !$('dialog[open]')) {
      document.body.classList.remove('focus');
    }
  };
  const onUnload = (ev) => {
    if (!dirty) return;
    save();
    ev.preventDefault();
    ev.returnValue = '';
  };
  document.addEventListener('keydown', onKey);
  window.addEventListener('beforeunload', onUnload);
  window.addEventListener('resize', grow);

  cleanup = async () => {
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('beforeunload', onUnload);
    window.removeEventListener('resize', grow);
    document.body.classList.remove('focus');
    await save();
  };

  updateWc();
  setMode(mode);
  if (mode === 'write') requestAnimationFrame(grow);
}

api('/api/auth/status')
  .then((s) => { authEnabled = s.enabled; })
  .catch(() => {})
  .finally(route);
