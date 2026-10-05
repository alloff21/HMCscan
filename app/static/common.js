/* HMCscan shared UI code: helpers, API client, shell and sign-in. Loaded before app.js or admin.js. */
'use strict';

/* ---------- helpers ---------- */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => s == null ? '' : String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const nf = (v, d = 0) => v == null || isNaN(v) ? '—' : Number(v).toLocaleString('ru-RU', {minimumFractionDigits: d, maximumFractionDigits: d});
const DASH = '<span class="dash">—</span>';
const ec = v => v == null ? DASH : nf(v, 2);
const gb = v => v == null ? DASH : nf(v, v % 1 && v < 10 ? 1 : 0);
const int = v => v == null ? DASH : nf(v);
const pill = (cls, t) => `<span class="pill ${cls}">${esc(t)}</span>`;

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso), now = new Date();
  const hm = d.toLocaleTimeString('ru-RU', {hour: '2-digit', minute: '2-digit'});
  return d.toDateString() === now.toDateString() ? hm : d.toLocaleDateString('ru-RU', {day: '2-digit', month: '2-digit'}) + ' ' + hm;
}
function toast(t) {
  const el = document.createElement('div'); el.className = 'toast'; el.textContent = t;
  document.body.appendChild(el); setTimeout(() => el.remove(), 3200);
}

class ApiError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
async function api(path, opts = {}) {
  const init = {method: opts.method || 'GET', headers: {}, credentials: 'same-origin'};
  if (opts.body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(opts.body); }
  const r = await fetch('/api' + path, init);
  let data = null;
  try { data = await r.json(); } catch (e) { /* empty body */ }
  if (r.status === 401 && path !== '/auth/login') { showLogin(); throw new ApiError(401, 'Требуется вход'); }
  if (!r.ok) {
    let msg = data && data.detail;
    if (Array.isArray(msg)) msg = msg.map(x => x.msg).join('; ');
    throw new ApiError(r.status, msg || ('Ошибка ' + r.status));
  }
  return data;
}

const STATE = {
  'Running': ['ok', 'Работает'], 'Not Activated': ['off', 'Не активирован'], 'Error': ['err', 'Ошибка'],
  'Open Firmware': ['warn', 'Open Firmware'], 'Starting': ['warn', 'Запускается'], 'Shutting Down': ['warn', 'Останавливается'],
  'Migrating': ['warn', 'Миграция'], 'Suspended': ['off', 'Приостановлен'], 'Not Available': ['err', 'Недоступен'],
};
const statePill = s => { const x = STATE[s] || ['off', s || '—']; return pill(x[0], x[1]); };
const MODE = {'shared-uncapped': 'Shared · uncapped', 'shared-capped': 'Shared · capped', 'ded': 'Dedicated', 'ded-donate': 'Dedicated · donating'};
const HSTAT = {ok: ['ok', 'Опрос успешен'], warn: ['warn', 'Есть предупреждения'], err: ['err', 'Ошибка опроса'],
               pending: ['off', 'Ожидает первого опроса'], running: ['off', 'Идёт первый опрос']};
const hstat = (h) => h.polling ? pill('off', 'Идёт опрос') : pill(...(HSTAT[h.status] || HSTAT.pending));
const typeTag = t => t === 'VIOS' ? '<span class="tag acc">VIOS</span>' : `<span class="tag">${esc(t)}</span>`;
const yes = (v, a = 'да', b = 'нет') => v == null ? DASH : v ? `<span class="yes">${a}</span>` : `<span class="no">${b}</span>`;

function meter(kind, used, total) {
  if (total == null) return '';
  const free = total - used, pct = total ? Math.max(0, Math.min(100, used / total * 100)) : 0, low = total && free / total < .12;
  return `<div class="meter ${kind}${low ? ' low' : ''}"><div class="lbl"><span>${kind === 'cpu' ? 'CPU, ядра' : 'RAM, ГБ'}</span>
    <span>свободно <b>${kind === 'cpu' ? nf(free, 2) : gb(free)}</b> из ${kind === 'cpu' ? nf(total, 2) : gb(total)}</span></div>
    <div class="track"><div class="fill" style="width:${pct}%"></div></div></div>`;
}
function mini(kind, free, total) {
  if (total == null || free == null) return DASH;
  const used = total - free, pct = total ? Math.max(0, Math.min(100, used / total * 100)) : 0, low = total && free / total < .12;
  return `<div class="mini${low ? ' low' : ''}"><div class="t"><b>${kind === 'cpu' ? nf(free, 2) : gb(free)}</b><span>из ${kind === 'cpu' ? nf(total, 2) : gb(total)}</span></div>
    <div class="track"><div class="fill" style="width:${pct}%;background:var(${kind === 'cpu' ? '--bar-cpu' : '--bar-mem'})"></div></div></div>`;
}

/* ---------- shell ---------- */
let ME = null, AUTHCFG = {};
const ICON = {
  hmc: '<svg class="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="2.5" width="12" height="4" rx="1"/><rect x="2" y="9.5" width="12" height="4" rx="1"/></svg>',
  list: '<svg class="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 3h12M2 6.5h12M2 10h12M2 13.5h12"/></svg>',
  link: '<svg class="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6 4H3.5A1.5 1.5 0 0 0 2 5.5v5A1.5 1.5 0 0 0 3.5 12H6M10 4h2.5A1.5 1.5 0 0 1 14 5.5v5a1.5 1.5 0 0 1-1.5 1.5H10M5 8h6"/></svg>',
  dc: '<svg class="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 14V5l6-3 6 3v9M5 14V8h6v6"/></svg>',
  user: '<svg class="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="5.5" r="2.8"/><path d="M2.5 14c.6-2.8 2.8-4.3 5.5-4.3s4.9 1.5 5.5 4.3"/></svg>',
  lock: '<svg class="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="7" width="10" height="7" rx="1"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/></svg>',
};
const LOGO = '<svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true"><rect x="1" y="1" width="24" height="24" rx="5" fill="#1d5fa6"/><rect x="6" y="6" width="14" height="3" rx="1" fill="#fff"/><rect x="6" y="11.5" width="14" height="3" rx="1" fill="#fff" opacity=".75"/><rect x="6" y="17" width="9" height="3" rx="1" fill="#fff" opacity=".5"/></svg>';

function renderShell() {
  $('#root').innerHTML = `<div class="app">
  <nav class="rail" aria-label="Разделы">
    <div class="brand">${LOGO}<div><b>HMCscan</b><small>${esc(APP.subtitle)} · v${esc(AUTHCFG.version || '')}</small></div></div>
    ${APP.nav.map(g => `<div class="navgroup"><h6>${esc(g.title)}</h6>${g.items.map(([href, key, icon, label]) =>
      `<a class="nav" href="${href}" data-nav="${key}">${ICON[icon]}${esc(label)}</a>`).join('')}</div>`).join('')}
    <div class="me"><b>${esc(ME.login)}</b>${ME.source === 'ad' ? esc(AUTHCFG.domain || 'AD') : 'Локальный'} · ${ME.role === 'admin' ? 'Администратор' : 'Просмотр'}<br><button id="logout">Выйти</button></div>
  </nav>
  <main>
    <div class="topbar"><div class="crumbs" id="crumbs"></div>
      <div class="sync">${AUTHCFG.demo ? '<span class="mockflag">ДЕМО-РЕЖИМ</span>' : ''}<span id="syncinfo"></span>${APP.topRight ? APP.topRight() : ''}</div></div>
    <div id="view"></div>
  </main></div>`;
  $('#logout').addEventListener('click', async () => { await api('/auth/logout', {method: 'POST'}).catch(() => {}); ME = null; showLogin(); });
  if (APP.afterShell) APP.afterShell();
}

function crumbs(list) {
  $('#crumbs').innerHTML = list.map((c, i) => i < list.length - 1 && c[1] ? `<a href="${c[1]}">${esc(c[0])}</a><span class="sep">›</span>` : `<span>${esc(c[0])}</span>${i < list.length - 1 ? '<span class="sep">›</span>' : ''}`).join('');
}
function view(html) { $('#view').innerHTML = html; }
function loading() { view('<div class="loading"><span class="spin"></span> Загрузка…</div>'); }
function fail(e) { if (e.status !== 401) view(`<div class="banner err">${esc(e.message)}</div>`); }

/* ---------- login ---------- */
function showLogin(msg) {
  $('#overlay').innerHTML = '';
  let mode = AUTHCFG.ad_enabled ? 'ad' : 'local';
  $('#root').innerHTML = `<div class="loginpage"><form class="login" id="lf" novalidate>
    <div class="brand" style="padding:0">${LOGO}<div><b style="color:var(--fg)">HMCscan</b><small style="color:var(--muted)">${esc(APP.loginSubtitle)}</small></div></div>
    ${AUTHCFG.ad_enabled ? `<div class="seg" role="group" aria-label="Тип учётной записи">
      <button type="button" data-m="ad">Домен ${esc(AUTHCFG.domain || 'AD')}</button><button type="button" data-m="local">Локальная</button></div>` : ''}
    ${msg ? `<div class="errline">${esc(msg)}</div>` : '<div class="errline" hidden></div>'}
    <div class="field"><label for="l-u">Логин</label><input id="l-u" autocomplete="username" autofocus></div>
    <div class="field"><label for="l-p">Пароль</label><input id="l-p" type="password" autocomplete="current-password"></div>
    <button class="btn primary" type="submit" style="justify-content:center;padding:9px" id="lbtn">Войти</button>
    <div class="muted" style="font-size:11.5px;text-align:center">HMCscan v${esc(AUTHCFG.version || '')}</div>
  </form></div>`;
  const setMode = m => { mode = m; $$('.seg button').forEach(b => b.setAttribute('aria-pressed', b.dataset.m === m)); };
  $$('.seg button').forEach(b => b.addEventListener('click', () => setMode(b.dataset.m)));
  setMode(mode);
  $('#lf').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = $('#lbtn'); btn.disabled = true;
    try {
      await api('/auth/login', {method: 'POST', body: {login: $('#l-u').value.trim(), password: $('#l-p').value, source: mode}});
      ME = await api('/auth/me'); renderShell(); route();
    } catch (err) {
      const el = $('.errline'); el.hidden = false; el.textContent = err.message; btn.disabled = false;
    }
  });
}


/* ---------- form helpers ---------- */
function markBad(form, id, msg) {
  const f = $('#' + id, form).closest('.field'); f.classList.add('bad');
  const et = $('.errt', f); if (et && msg) et.textContent = msg;
}
function clearBad(form) { $$('.field.bad', form).forEach(f => f.classList.remove('bad')); }
const val = id => { const el = $('#' + id); return el.type === 'checkbox' ? el.checked : el.value.trim(); };

/* inline confirm: the button turns into "Точно?" for a few seconds */
function confirmInline(btn, title, action) {
  if (btn.dataset.armed) { action().catch(e => toast(e.message)); return; }
  btn.dataset.armed = '1'; const old = btn.textContent; btn.textContent = 'Подтвердить'; btn.title = title;
  setTimeout(() => { if (btn.isConnected) { delete btn.dataset.armed; btn.textContent = old; } }, 4000);
}


/* ---------- start: each page script defines APP and route(), then calls startApp() ---------- */
async function startApp() {
  try { AUTHCFG = await (await fetch('/api/auth/config')).json(); } catch (e) { AUTHCFG = {}; }
  try {
    const r = await fetch('/api/auth/me', {credentials: 'same-origin'});
    if (r.ok) { ME = await r.json(); renderShell(); route(); } else showLogin();
  } catch (e) { showLogin('Сервер недоступен'); }
}
window.addEventListener('hashchange', () => route());
