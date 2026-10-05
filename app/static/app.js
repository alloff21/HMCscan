/* HMCscan UI: plain JavaScript, no build step. Routes live in location.hash. */
(function () {
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
  const isAdmin = ME.role === 'admin';
  $('#root').innerHTML = `<div class="app">
  <nav class="rail" aria-label="Разделы">
    <div class="brand">${LOGO}<div><b>HMCscan</b><small>LPAR inventory · v${esc(AUTHCFG.version || '')}</small></div></div>
    <div class="navgroup"><h6>Инфраструктура</h6>
      <a class="nav" href="#/overview" data-nav="overview">${ICON.hmc}HMC и серверы</a>
      <a class="nav" href="#/lpars" data-nav="lpars">${ICON.list}Все LPAR</a>
    </div>
    ${isAdmin ? `<div class="navgroup"><h6>Администрирование</h6>
      <a class="nav" href="#/admin/hmc" data-nav="admin/hmc">${ICON.link}Подключения HMC</a>
      <a class="nav" href="#/admin/dc" data-nav="admin/dc">${ICON.dc}ЦОД</a>
      <a class="nav" href="#/admin/users" data-nav="admin/users">${ICON.user}Пользователи</a>
      <a class="nav" href="#/admin/ad" data-nav="admin/ad">${ICON.lock}Active Directory</a>
    </div>` : ''}
    <div class="me"><b>${esc(ME.login)}</b>${ME.source === 'ad' ? esc(AUTHCFG.domain || 'AD') : 'Локальный'} · ${ME.role === 'admin' ? 'Администратор' : 'Просмотр'}<br><button id="logout">Выйти</button></div>
  </nav>
  <main>
    <div class="topbar"><div class="crumbs" id="crumbs"></div>
      <div class="sync">${AUTHCFG.demo ? '<span class="mockflag">ДЕМО-РЕЖИМ</span>' : ''}<span id="syncinfo"></span>
      ${isAdmin ? '<button class="btn sm" id="refresh">Опросить все HMC</button>' : ''}</div></div>
    <div id="view"></div>
  </main></div>`;
  $('#logout').addEventListener('click', async () => { await api('/auth/logout', {method: 'POST'}).catch(() => {}); ME = null; showLogin(); });
  const rb = $('#refresh');
  if (rb) rb.addEventListener('click', async () => {
    try { const r = await api('/poll', {method: 'POST'}); toast(r.started ? `Запущен опрос HMC: ${r.started}. Страница обновится через несколько секунд.` : 'Опрос уже идёт.'); setTimeout(route, 6000); }
    catch (e) { toast(e.message); }
  });
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
    <div class="brand" style="padding:0">${LOGO}<div><b style="color:var(--fg)">HMCscan</b><small style="color:var(--muted)">Инвентаризация IBM Power</small></div></div>
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

/* ---------- router ---------- */
async function route() {
  if (!ME) return;
  const h = location.hash.replace(/^#\/?/, '') || 'overview';
  const parts = h.split('/');
  const nav = parts[0] === 'hmc' || parts[0] === 'server' ? 'overview' : parts[0] === 'admin' ? 'admin/' + parts[1] : parts[0];
  $$('.nav').forEach(a => a.setAttribute('aria-current', a.dataset.nav === nav));
  $('#overlay').innerHTML = '';
  if (parts[0] === 'admin' && ME.role !== 'admin') { location.hash = '#/overview'; return; }
  loading();
  try {
    switch (parts[0]) {
      case 'hmc': return await vServers(+parts[1]);
      case 'server': return await vServer(decodeURIComponent(parts[1]));
      case 'lpars': return await vAll();
      case 'admin':
        return await ({hmc: vAdmHmc, dc: vAdmDc, users: vUsers, ad: vAD}[parts[1]] || vOverview)();
      default: return await vOverview();
    }
  } catch (e) { fail(e); }
}
window.addEventListener('hashchange', route);

/* ---------- 1. overview ---------- */
async function vOverview() {
  crumbs([['HMC и серверы']]);
  const d = await api('/overview');
  const t = d.totals;
  const last = d.hmcs.map(h => h.polled_at).filter(Boolean).sort().pop();
  $('#syncinfo').textContent = last ? 'Последний опрос ' + fmtTime(last) : '';
  if (!d.hmcs.length) {
    return view(`<h1>HMC и серверы</h1><div class="empty"><b>Пока не подключено ни одной HMC</b>
      ${ME.role === 'admin' ? 'Добавьте первую в разделе <a href="#/admin/hmc" style="color:var(--accent)">Подключения HMC</a>. Сначала создайте ЦОД, к которому она относится.' : 'Попросите администратора добавить HMC.'}</div>`);
  }
  let h = `<h1>HMC и серверы</h1><p class="sub">Все подключённые HMC, сгруппированные по ЦОД. Нажмите на карточку HMC, чтобы открыть её серверы.</p>
  <div class="kpis">
    <div class="kpi"><span>ЦОД</span><b>${t.dcs}</b></div>
    <div class="kpi"><span>HMC</span><b>${t.hmcs}</b> <i>${d.hmcs.filter(x => x.status === 'err' || x.status === 'warn').length} с проблемами</i></div>
    <div class="kpi"><span>Серверы</span><b>${t.servers}</b></div>
    <div class="kpi"><span>LPAR</span><b>${t.lpars}</b> <i>${t.running} работают</i></div>
    <div class="kpi"><span>Свободно CPU</span><b>${nf(t.cpu_free, 1)}</b> <i>из ${nf(t.cpu_conf, 0)} ядер</i></div>
    <div class="kpi"><span>Свободно RAM</span><b>${nf(t.mem_free / 1024, 1)} ТБ</b> <i>из ${nf(t.mem_conf / 1024, 1)} ТБ</i></div>
  </div>`;
  d.dcs.forEach(dc => {
    const hs = d.hmcs.filter(x => x.dc_id === dc.id); if (!hs.length) return;
    h += `<div class="dchead"><h2>${esc(dc.name)}</h2><span class="tag">${esc(dc.code)}</span><span class="muted" style="font-size:12.5px">${esc(dc.address)}</span></div><div class="cards">`;
    hs.forEach(x => {
      const tt = x.totals;
      h += `<a class="card" href="#/hmc/${x.id}" style="color:inherit;text-decoration:none">
        <div class="hd"><div><div class="name">${esc(x.name)}</div><div class="host">${esc(x.host)}</div></div>${hstat(x)}</div>
        <dl><dt>Модель / версия</dt><dd>${esc(x.model || '—')} · ${esc(x.version || '—')}</dd>
          <dt>Серверы / LPAR</dt><dd>${tt.servers} / ${tt.lpars} <span class="muted">(${tt.running} работают)</span></dd>
          <dt>Последний опрос</dt><dd>${fmtTime(x.polled_at)}${x.duration_s ? ` <span class="muted">· ${nf(x.duration_s, 1)} с</span>` : ''}</dd></dl>
        ${tt.servers ? meter('cpu', tt.cpu_conf - tt.cpu_free, tt.cpu_conf) + meter('mem', tt.mem_conf - tt.mem_free, tt.mem_conf)
                     : '<div class="muted" style="font-size:12.5px">Серверы появятся после первого успешного опроса.</div>'}
        ${x.error ? `<div class="note ${x.status === 'err' ? 'err' : 'warn'}">${esc(x.error)}${x.status === 'err' && x.polled_at ? '. Показаны данные последнего успешного опроса.' : ''}</div>` : ''}
      </a>`;
    });
    h += '</div>';
  });
  view(h);
}

/* ---------- 2. servers of an HMC ---------- */
async function vServers(id) {
  const d = await api(`/hmcs/${id}/servers`), hm = d.hmc;
  crumbs([['HMC и серверы', '#/overview'], [hm.name]]);
  let h = `<h1>${esc(hm.name)}</h1><p class="sub">${esc(hm.dc ? hm.dc.name : '')} · ${esc(hm.host)} · ${esc(hm.model || '—')} · ${esc(hm.version || '—')} &nbsp; ${hstat(hm)}</p>
  ${hm.error ? `<div class="banner ${hm.status === 'err' ? 'err' : 'warn'}">${esc(hm.error)}</div>` : ''}`;
  if (!d.servers.length) { view(h + '<div class="empty"><b>Нет данных о серверах</b>Дождитесь успешного опроса этой HMC.</div>'); return; }
  h += `<div class="tw"><table><thead>
   <tr class="grp"><th class="blank" colspan="5"></th><th class="gs" colspan="3">Процессоры, ядра</th><th class="gs" colspan="3">Память, ГБ</th><th class="gs blank" colspan="2"></th></tr>
   <tr><th class="sticky1">Сервер</th><th>Модель</th><th>MTM / серийный</th><th>Состояние</th><th>Firmware</th>
   <th class="r gs">Установлено</th><th class="r">Назначено LPAR</th><th>Свободно</th>
   <th class="r gs">Всего</th><th class="r">LPAR + гипервизор</th><th>Свободно</th>
   <th class="r gs">LPAR</th><th></th></tr></thead><tbody>`;
  d.servers.forEach(s => {
    const c = s.cpu, m = s.mem;
    const st = /operating/i.test(s.state || '') ? pill('ok', s.state) : pill(s.stale ? 'off' : 'warn', s.state || '—');
    h += `<tr class="click" data-href="#/server/${encodeURIComponent(s.key)}"><td class="sticky1 lname">${esc(s.name)}</td>
      <td>${esc(s.model)}<br><span class="muted" style="font-size:12px">${esc(s.gen || '')}</span></td><td class="mono">${esc(s.mtm)}<br>${esc(s.serial)}</td><td>${st}</td><td class="mono">${esc(s.firmware || '—')}</td>
      <td class="r gs">${int(c.installed)}${c.configurable != null && c.installed != null && c.configurable < c.installed ? `<br><span class="muted" style="font-size:11.5px">активно ${nf(c.configurable)}</span>` : ''}</td>
      <td class="r">${ec(c.assigned)}</td><td>${mini('cpu', c.available, c.configurable)}</td>
      <td class="r gs">${gb(m.configurable)}</td><td class="r">${gb(m.assigned)} <span class="muted">+ ${gb(m.hypervisor)}</span></td><td>${mini('mem', m.available, m.configurable)}</td>
      <td class="r gs">${s.lpar_running} / ${s.lpar_count}</td><td><a class="btn sm ghost" href="#/server/${encodeURIComponent(s.key)}">LPAR ›</a></td></tr>`;
  });
  h += `</tbody></table></div><p class="muted" style="font-size:12px;margin-top:8px">Свободные ресурсы берутся из HMC как есть (CurrentAvailableSystemProcessorUnits и CurrentAvailableSystemMemory).</p>`;
  view(h);
  $$('tr[data-href]').forEach(r => r.addEventListener('click', e => { if (!e.target.closest('a')) location.hash = r.dataset.href; }));
}

/* ---------- 3. one server ---------- */
let LPAR_CACHE = [];
async function vServer(key) {
  const d = await api(`/servers/${encodeURIComponent(key)}`), s = d.server, c = s.cpu, m = s.mem;
  const hm = s.hmcs[0] || {};
  crumbs([['HMC и серверы', '#/overview'], [hm.name || 'HMC', '#/hmc/' + hm.id], [s.name]]);
  LPAR_CACHE = d.lpars.map(l => ({...l, server: s.name, hmc: s.hmcs.map(x => x.name).join(', '), dcname: s.dc ? s.dc.name : ''}));
  const pools = [...new Set(d.lpars.map(l => l.pool).filter(Boolean))];
  const ded = d.lpars.filter(l => l.mode.startsWith('ded')).reduce((a, l) => a + (l.ec.cur || 0), 0);
  let h = `<h1>${esc(s.name)}</h1><p class="sub">${esc(s.model)} · ${esc(s.mtm)} · S/N ${esc(s.serial)} · ${esc(s.dc ? s.dc.name : '')} · через ${s.hmcs.map(x => esc(x.name)).join(', ')}</p>
  ${s.error ? `<div class="banner warn">LPAR этого сервера прочитаны не полностью: ${esc(s.error)}</div>` : ''}
  ${s.stale ? `<div class="banner warn">HMC сейчас недоступна. Данные на ${fmtTime(s.polled_at)}.</div>` : ''}
  <div class="srvhead">
    <div class="panel"><div class="panel-bd"><dl class="facts">
      <dt>Состояние</dt><dd>${/operating/i.test(s.state || '') ? pill('ok', s.state) : pill('warn', s.state || '—')}</dd>
      <dt>Процессор</dt><dd>${esc(s.gen || '—')}</dd><dt>Firmware</dt><dd class="mono">${esc(s.firmware || '—')}</dd>
      <dt>Пулы процессоров</dt><dd>${pools.map(p => `<span class="tag">${esc(p)}</span>`).join(' ') || '—'}</dd>
      <dt>LPAR</dt><dd>${s.lpar_count} (${s.vios_count} VIOS)</dd><dt>Данные на</dt><dd>${fmtTime(s.polled_at)}</dd></dl></div></div>
    <div class="panel"><div class="panel-bd">${meter('cpu', c.assigned || 0, c.configurable)}
      <div class="split"><div><span>Установлено</span><b>${int(c.installed)}</b></div><div><span>Активно</span><b>${ec(c.configurable)}</b></div>
      <div><span>Shared</span><b>${ec((c.assigned || 0) - ded)}</b></div><div><span>Dedicated</span><b>${ec(ded)}</b></div>
      <div><span>Назначено</span><b>${ec(c.assigned)}</b></div><div><span>Свободно</span><b>${ec(c.available)}</b></div></div></div></div>
    <div class="panel"><div class="panel-bd">${meter('mem', (m.configurable || 0) - (m.available || 0), m.configurable)}
      <div class="split"><div><span>Установлено</span><b>${gb(m.installed)}</b></div><div><span>Гипервизор</span><b>${gb(m.hypervisor)}</b></div>
      <div><span>Назначено LPAR</span><b>${gb(m.assigned)}</b></div><div><span>Свободно</span><b>${gb(m.available)}</b></div></div></div></div>
  </div>
  <h2>Разделы (LPAR)</h2>`;
  if (!d.lpars.length) { view(h + '<div class="empty"><b>На сервере нет разделов</b></div>'); return; }
  h += `<div class="tw"><table><thead>
    <tr class="grp"><th class="blank sticky1"></th><th class="blank" colspan="5"></th><th class="gs" colspan="4">CPU / Entitled (ядра)</th><th class="gs" colspan="4">Виртуальные CPU</th><th class="gs" colspan="4">Память, ГБ</th><th class="gs blank" colspan="5"></th></tr>
    <tr><th class="sticky1">Раздел</th><th class="r">ID</th><th>Тип / ОС</th><th>Состояние</th><th>Режим CPU</th><th>Пул · вес</th>
    <th class="r gs">мин</th><th class="r">жел</th><th class="r">макс</th><th class="r">тек</th>
    <th class="r gs">мин</th><th class="r">жел</th><th class="r">макс</th><th class="r">тек</th>
    <th class="r gs">мин</th><th class="r">жел</th><th class="r">макс</th><th class="r">тек</th>
    <th class="gs">AME</th><th>Совместимость</th><th>Физ. слоты</th><th>SRR</th><th>RMC</th></tr></thead><tbody>`;
  LPAR_CACHE.forEach((l, i) => {
    const vp = l.vp || {};
    h += `<tr class="click${l.type === 'VIOS' ? ' vios' : ''}" data-i="${i}"><td class="sticky1 lname">${esc(l.name)}</td><td class="r">${int(l.id)}</td>
      <td>${typeTag(l.type)} <span class="muted">${esc(l.os || '')}</span></td><td>${statePill(l.state)}</td><td>${MODE[l.mode] || esc(l.mode)}</td>
      <td>${l.pool ? esc(l.pool) : DASH}${l.weight != null ? ` <span class="muted">· ${l.weight}</span>` : ''}</td>
      <td class="r gs">${ec(l.ec.min)}</td><td class="r des">${ec(l.ec.des)}</td><td class="r">${ec(l.ec.max)}</td><td class="r cur">${ec(l.ec.cur)}</td>
      <td class="r gs">${int(vp.min)}</td><td class="r des">${int(vp.des)}</td><td class="r">${int(vp.max)}</td><td class="r cur">${int(vp.cur)}</td>
      <td class="r gs">${gb(l.mem.min)}</td><td class="r des">${gb(l.mem.des)}</td><td class="r">${gb(l.mem.max)}</td><td class="r cur">${gb(l.mem.cur)}</td>
      <td class="gs">${l.ame ? '×' + nf(l.ame, 1) : DASH}</td><td class="mono">${esc(l.compat || '—')}</td>
      <td class="r">${int(l.phys_slots)}</td><td>${yes(l.srr, 'вкл', 'выкл')}</td>
      <td>${l.rmc === 'active' ? '<span class="yes">active</span>' : `<span class="no">${esc(l.rmc || '—')}</span>`}</td></tr>`;
  });
  h += `</tbody></table></div><p class="muted" style="font-size:12px;margin-top:8px">Мин / жел / макс — границы из конфигурации раздела, «тек» — выделено сейчас. Нажмите на строку, чтобы открыть карточку раздела.</p>`;
  view(h);
  $$('tr[data-i]').forEach(r => r.addEventListener('click', () => drawer(LPAR_CACHE[+r.dataset.i])));
}

/* ---------- LPAR drawer ---------- */
function drawer(l) {
  const vp = l.vp || {};
  const row = (k, a, b, c, d) => `<div class="k">${k}</div><div>${a}</div><div><b>${b}</b></div><div>${c}</div><div style="color:var(--accent)">${d}</div>`;
  $('#overlay').innerHTML = `<div class="scrim"></div><aside class="drawer" role="dialog" aria-label="Раздел ${esc(l.name)}">
    <div class="hd"><div><h2>${esc(l.name)}</h2><div class="muted" style="font-size:12.5px">LPAR ID ${esc(l.id)} · ${esc(l.server)} · ${esc(l.hmc)}${l.dcname ? ' · ' + esc(l.dcname) : ''}</div></div><button class="btn sm" id="dclose">Закрыть</button></div>
    <div style="display:flex;gap:6px;flex-wrap:wrap">${statePill(l.state)}${typeTag(l.type)}${l.os ? `<span class="tag">${esc(l.os)}</span>` : ''}<span class="tag acc">${MODE[l.mode] || esc(l.mode)}</span></div>
    <h3>Ресурсы</h3>
    <div class="mmd"><div class="h k"></div><div class="h">мин</div><div class="h">жел</div><div class="h">макс</div><div class="h">тек</div>
      ${row(l.mode.startsWith('ded') ? 'CPU (выделенные)' : 'Entitled CPU', ec(l.ec.min), ec(l.ec.des), ec(l.ec.max), ec(l.ec.cur))}
      ${row('Вирт. CPU', int(vp.min), int(vp.des), int(vp.max), int(vp.cur))}
      ${row('Память, ГБ', gb(l.mem.min), gb(l.mem.des), gb(l.mem.max), gb(l.mem.cur))}
    </div>
    <h3>Процессор</h3><dl class="facts">
      <dt>Режим</dt><dd>${MODE[l.mode] || esc(l.mode)} <span class="muted mono">(${esc(l.sharing_mode || '—')})</span></dd>
      <dt>Пул общих процессоров</dt><dd>${esc(l.pool || '—')}</dd>
      <dt>Uncapped weight</dt><dd>${l.weight ?? '—'}</dd>
      <dt>Режим совместимости</dt><dd class="mono">${esc(l.compat || '—')}${l.compat_pending && l.compat_pending !== l.compat ? ` → ${esc(l.compat_pending)} после перезапуска` : ''}</dd></dl>
    <h3>Память</h3><dl class="facts">
      <dt>Active Memory Expansion</dt><dd>${l.ame ? 'включено, коэффициент ' + nf(l.ame, 2) + (l.mem.cur ? ` (эффективно ${gb(l.mem.cur * l.ame)} ГБ)` : '') : 'выключено'}</dd>
      <dt>Active Memory Sharing</dt><dd>${l.ams ? 'включено' : 'выключено'}</dd></dl>
    <h3>Ввод-вывод</h3><dl class="facts">
      <dt>Физические слоты</dt><dd>${int(l.phys_slots)}</dd><dt>Вирт. Ethernet</dt><dd>${int(l.veth)}</dd>
      <dt>Вирт. FC (NPIV)</dt><dd>${int(l.vfc)}</dd><dt>Вирт. SCSI</dt><dd>${int(l.vscsi)}</dd>
      <dt>Simplified Remote Restart</dt><dd>${l.srr == null ? '—' : l.srr ? 'включён' : 'выключен'}</dd></dl>
    <h3>Управление</h3><dl class="facts">
      <dt>RMC</dt><dd>${esc(l.rmc || '—')}${l.rmc_ip ? ` · <span class="mono">${esc(l.rmc_ip)}</span>` : ''}</dd>
      ${l.ref_code ? `<dt>Reference code</dt><dd class="mono">${esc(l.ref_code)}</dd>` : ''}
      <dt>UUID</dt><dd class="mono" style="font-size:11.5px">${esc(l.uuid)}</dd></dl>
  </aside>`;
  const close = () => { $('#overlay').innerHTML = ''; document.removeEventListener('keydown', onKey); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  $('.scrim').addEventListener('click', close); $('#dclose').addEventListener('click', close);
  document.addEventListener('keydown', onKey);
}

/* ---------- 4. all LPARs ---------- */
let F = {q: '', dc: '', hmc: '', type: '', mode: '', state: ''}, SORT = {k: 'name', dir: 'asc'}, ALL = null;
async function vAll() {
  crumbs([['Все LPAR']]);
  ALL = await api('/lpars');
  const opt = (arr, sel, lab) => `<option value="">${lab}</option>` + arr.map(([v, t]) => `<option value="${esc(v)}"${String(v) === sel ? ' selected' : ''}>${esc(t)}</option>`).join('');
  const types = [...new Set(ALL.lpars.map(l => l.type))].sort();
  const states = [...new Set(ALL.lpars.map(l => l.state))].sort();
  view(`<h1>Все LPAR</h1><p class="sub">Сводная таблица разделов со всех HMC. Колонки сортируются, фильтры комбинируются. Сервер, который видят две HMC, учитывается один раз.</p>
  <div class="filters">
    <input id="fq" type="search" placeholder="Поиск: раздел, сервер, ОС, IP" value="${esc(F.q)}" aria-label="Поиск">
    <select id="fdc" aria-label="ЦОД">${opt(ALL.dcs.map(d => [d.id, d.name]), F.dc, 'Все ЦОД')}</select>
    <select id="fhmc" aria-label="HMC">${opt(ALL.hmcs.map(h => [h.id, h.name]), F.hmc, 'Все HMC')}</select>
    <select id="ftype" aria-label="Тип">${opt(types.map(t => [t, t]), F.type, 'Все типы')}</select>
    <select id="fmode" aria-label="Режим CPU">${opt(Object.entries(MODE), F.mode, 'Любой режим CPU')}</select>
    <select id="fstate" aria-label="Состояние">${opt(states.map(s => [s, (STATE[s] || [0, s])[1]]), F.state, 'Любое состояние')}</select>
    <a class="btn" id="csv" href="/api/export/lpars.csv" style="margin-left:auto">Выгрузить CSV для Excel</a>
  </div><div class="totals" id="tot"></div>
  <div class="tw"><table><thead><tr>
    <th class="sort sticky1" data-k="name">Раздел</th><th class="sort" data-k="dc">ЦОД</th><th class="sort" data-k="hmc">HMC</th><th class="sort" data-k="server">Сервер</th>
    <th class="sort" data-k="type">Тип / ОС</th><th class="sort" data-k="state">Состояние</th><th class="sort" data-k="mode">Режим CPU</th>
    <th class="sort r" data-k="ec">EC тек <small>(мин–макс)</small></th><th class="sort r" data-k="vp">vCPU тек <small>(мин–макс)</small></th><th class="sort r" data-k="mem">RAM, ГБ тек <small>(мин–макс)</small></th>
    <th>Пул</th><th>RMC IP</th></tr></thead><tbody id="tb"></tbody></table></div>`);
  const bind = (id, k) => $('#' + id).addEventListener('input', e => { F[k] = e.target.value; fill(); });
  bind('fq', 'q'); bind('fdc', 'dc'); bind('fhmc', 'hmc'); bind('ftype', 'type'); bind('fmode', 'mode'); bind('fstate', 'state');
  $$('th.sort').forEach(th => th.addEventListener('click', () => { const k = th.dataset.k; SORT = {k, dir: SORT.k === k && SORT.dir === 'asc' ? 'desc' : 'asc'}; fill(); }));
  fill();
}
function fill() {
  const q = F.q.trim().toLowerCase();
  const rows = ALL.lpars.filter(l => {
    if (F.dc && String(l.dc_id) !== F.dc) return false;
    if (F.hmc && String(l.hmc_id) !== F.hmc) return false;
    if (F.type && l.type !== F.type) return false;
    if (F.mode && l.mode !== F.mode) return false;
    if (F.state && l.state !== F.state) return false;
    if (q && !`${l.name} ${l.server} ${l.os || ''} ${l.rmc_ip || ''}`.toLowerCase().includes(q)) return false;
    return true;
  });
  const key = {name: l => l.name, dc: l => l.dc, hmc: l => l.hmc, server: l => l.server, type: l => l.type + (l.os || ''),
    state: l => l.state, mode: l => l.mode, ec: l => l.ec.cur ?? -1, vp: l => l.vp ? (l.vp.cur ?? -1) : -1, mem: l => l.mem.cur ?? -1}[SORT.k];
  rows.sort((a, b) => { const x = key(a), y = key(b); const c = typeof x === 'number' ? x - y : String(x ?? '').localeCompare(String(y ?? ''), 'ru'); return SORT.dir === 'asc' ? c : -c; });
  $$('th.sort').forEach(th => th.dataset.dir = th.dataset.k === SORT.k ? SORT.dir : '');
  const run = rows.filter(l => l.state === 'Running');
  $('#tot').innerHTML = `<span>Показано <b>${rows.length}</b> из ${ALL.lpars.length}</span><span>Работают <b>${run.length}</b></span>
    <span>Σ EC <b>${nf(run.reduce((a, l) => a + (l.ec.cur || 0), 0), 2)}</b></span><span>Σ vCPU <b>${nf(run.reduce((a, l) => a + ((l.vp && l.vp.cur) || 0), 0))}</b></span>
    <span>Σ RAM <b>${nf(run.reduce((a, l) => a + (l.mem.cur || 0), 0))} ГБ</b></span>`;
  LPAR_CACHE = rows.map(l => ({...l, dcname: l.dc}));
  $('#tb').innerHTML = LPAR_CACHE.map((l, i) => `<tr class="click" data-i="${i}"><td class="sticky1 lname">${esc(l.name)}</td><td><span class="tag">${esc(l.dc)}</span></td>
    <td class="mono">${esc(l.hmc)}</td><td><a href="#/server/${encodeURIComponent(l.server_key)}" style="color:inherit">${esc(l.server)}</a></td>
    <td>${typeTag(l.type)} <span class="muted">${esc(l.os || '')}</span></td><td>${statePill(l.state)}</td><td>${MODE[l.mode] || esc(l.mode)}</td>
    <td class="r rng"><b>${ec(l.ec.cur)}</b><small>${ec(l.ec.min)}–${ec(l.ec.max)}</small></td>
    <td class="r rng">${l.vp ? `<b>${int(l.vp.cur)}</b><small>${int(l.vp.min)}–${int(l.vp.max)}</small>` : DASH}</td>
    <td class="r rng"><b>${gb(l.mem.cur)}</b><small>${gb(l.mem.min)}–${gb(l.mem.max)}</small></td>
    <td>${l.pool ? esc(l.pool) : DASH}</td><td class="mono">${esc(l.rmc_ip || '')}</td></tr>`).join('')
    || `<tr><td colspan="12" class="muted" style="padding:20px">Ничего не найдено. Сбросьте один из фильтров.</td></tr>`;
  $$('#tb tr[data-i]').forEach(r => r.addEventListener('click', e => { if (!e.target.closest('a')) drawer(LPAR_CACHE[+r.dataset.i]); }));
}

/* ---------- form helpers ---------- */
function markBad(form, id, msg) {
  const f = $('#' + id, form).closest('.field'); f.classList.add('bad');
  const et = $('.errt', f); if (et && msg) et.textContent = msg;
}
function clearBad(form) { $$('.field.bad', form).forEach(f => f.classList.remove('bad')); }
const val = id => { const el = $('#' + id); return el.type === 'checkbox' ? el.checked : el.value.trim(); };

/* ---------- 5. admin: HMC ---------- */
async function vAdmHmc() {
  crumbs([['Администрирование'], ['Подключения HMC']]);
  const [hmcs, dcs] = await Promise.all([api('/admin/hmcs'), api('/admin/datacenters')]);
  const dcCode = Object.fromEntries(dcs.map(d => [d.id, d.code]));
  let h = `<h1>Подключения HMC</h1><p class="sub">HMCscan подключается к HMC через REST API (порт 12443) и только читает данные. Используйте пользователя HMC с ролью <span class="mono">hmcviewer</span>.</p>
  <div class="grid2"><div style="min-width:0">`;
  if (hmcs.length) {
    h += `<div class="tw"><table><thead><tr><th class="sticky1">HMC</th><th>ЦОД</th><th>Версия</th><th>Учётка</th><th>Опрос</th><th>Статус</th><th></th></tr></thead><tbody>`;
    hmcs.forEach(x => {
      h += `<tr><td class="sticky1 lname">${esc(x.name)}<small>${esc(x.host)}:${x.port}</small></td><td><span class="tag">${esc(dcCode[x.dc_id] || '?')}</span></td>
      <td class="mono">${esc(x.version || '—')}</td><td class="mono">${esc(x.username)}</td>
      <td class="num">${fmtTime(x.polled_at)}<br><span class="muted" style="font-size:11.5px">каждые ${x.interval_min} мин${x.enabled ? '' : ' · выключен'}</span></td>
      <td>${hstat(x)}${x.error ? `<div class="muted" style="font-size:11.5px;white-space:normal;max-width:260px;margin-top:3px">${esc(x.error)}</div>` : ''}</td>
      <td><button class="btn sm" data-poll="${x.id}">Опросить</button> <button class="btn sm ghost" data-edit="${x.id}">Изменить</button> <button class="btn sm ghost danger" data-del="${x.id}">Удалить</button></td></tr>`;
    });
    h += '</tbody></table></div>';
  } else h += '<div class="empty"><b>HMC ещё не добавлены</b>Заполните форму справа.</div>';
  h += `<p class="callout" style="margin-top:12px"><b>Как создать пользователя на HMC:</b> <span class="mono">mkhmcusr -u hmcscan_ro -a hmcviewer -d "HMCscan read-only"</span>, затем разрешите ему удалённый доступ: <span class="mono">chhmcusr -u hmcscan_ro -i "remote_webui_access=1"</span> или в GUI: Users and Security → Manage User Profiles → Allow remote access via the web.</p></div>
  <div class="panel"><div class="panel-hd"><h3 style="margin:0" id="hftitle">Новое подключение</h3><button class="btn sm ghost" id="hcancel" hidden>Отмена</button></div><div class="panel-bd">
   <form class="form" id="hf" novalidate>
    <div class="field"><label for="h-name">Отображаемое имя <span class="req">*</span></label><input id="h-name" placeholder="hmc-msk1-01"><span class="errt">Укажите имя</span></div>
    <div class="field"><label for="h-dc">ЦОД <span class="req">*</span></label><select id="h-dc"><option value="">Выберите ЦОД…</option>${dcs.map(d => `<option value="${d.id}">${esc(d.name)} (${esc(d.code)})</option>`).join('')}</select>
      <span class="errt">Выберите ЦОД: без него HMC не попадёт в сводные отчёты</span><span class="hint">${dcs.length ? 'Нет нужного?' : 'Справочник пуст.'} <a href="#/admin/dc" style="color:var(--accent)">Добавить ЦОД</a></span></div>
    <div class="field"><label for="h-host">Адрес HMC (FQDN или IP) <span class="req">*</span></label><input id="h-host" placeholder="hmc-msk1-01.corp.local"><span class="errt">Укажите адрес</span></div>
    <div class="field"><label for="h-port">Порт REST API</label><input id="h-port" value="12443" inputmode="numeric"><span class="errt">Порт от 1 до 65535</span></div>
    <div class="field"><label for="h-user">Пользователь HMC <span class="req">*</span></label><input id="h-user" value="hmcscan_ro" autocomplete="off"><span class="errt">Укажите пользователя</span></div>
    <div class="field"><label for="h-pass">Пароль <span class="req" id="h-pass-req">*</span></label><input id="h-pass" type="password" autocomplete="new-password"><span class="hint" id="h-pass-hint">Хранится зашифрованным</span><span class="errt">Укажите пароль</span></div>
    <div class="field"><label for="h-int">Интервал опроса</label><select id="h-int"><option value="5">5 мин</option><option value="15" selected>15 мин</option><option value="30">30 мин</option><option value="60">1 час</option><option value="240">4 часа</option></select></div>
    <div class="field"><label for="h-tls">Проверка TLS-сертификата HMC</label><select id="h-tls"><option value="verify">Проверять (системные CA)</option><option value="ca">Проверять по своему CA</option><option value="none">Не проверять</option></select></div>
    <div class="field full" id="h-ca-wrap" hidden><label for="h-ca">Сертификат CA (PEM)</label><textarea id="h-ca" placeholder="-----BEGIN CERTIFICATE-----"></textarea></div>
    <div class="field full"><label class="check"><input type="checkbox" id="h-en" checked> Опрашивать по расписанию</label></div>
    <div class="result" id="hres" hidden></div>
    <div class="formact"><button type="button" class="btn" id="htest">Проверить подключение</button><button type="submit" class="btn primary" id="hsave">Сохранить</button><span class="muted" style="font-size:12px">* обязательные поля</span></div>
   </form></div></div></div>`;
  view(h);
  let editing = null;
  const form = $('#hf');
  const tlsToggle = () => { $('#h-ca-wrap').hidden = $('#h-tls').value !== 'ca'; };
  $('#h-tls').addEventListener('change', tlsToggle);
  const fillForm = x => {
    editing = x ? x.id : null; clearBad(form); $('#hres').hidden = true;
    $('#hftitle').textContent = x ? 'Изменить: ' + x.name : 'Новое подключение';
    $('#hcancel').hidden = !x;
    $('#h-name').value = x ? x.name : ''; $('#h-dc').value = x ? x.dc_id : ''; $('#h-host').value = x ? x.host : '';
    $('#h-port').value = x ? x.port : 12443; $('#h-user').value = x ? x.username : 'hmcscan_ro'; $('#h-pass').value = '';
    $('#h-int').value = x ? String(x.interval_min) : '15';
    if (x && !$(`#h-int option[value="${x.interval_min}"]`)) $('#h-int').insertAdjacentHTML('beforeend', `<option value="${x.interval_min}">${x.interval_min} мин</option>`), $('#h-int').value = String(x.interval_min);
    $('#h-tls').value = x ? x.tls_mode : 'verify'; $('#h-ca').value = x ? x.ca_pem : ''; $('#h-en').checked = x ? !!x.enabled : true;
    $('#h-pass-req').hidden = !!x; $('#h-pass-hint').textContent = x ? 'Оставьте пустым, чтобы не менять' : 'Хранится зашифрованным';
    tlsToggle();
  };
  const payload = () => ({name: val('h-name'), dc_id: val('h-dc') ? +val('h-dc') : null, host: val('h-host'), port: +val('h-port') || 0,
    username: val('h-user'), password: $('#h-pass').value, interval_min: +val('h-int'), tls_mode: val('h-tls'), ca_pem: $('#h-ca').value, enabled: val('h-en')});
  const validate = (forTest) => {
    clearBad(form); let ok = true; const p = payload();
    const need = forTest ? [['h-host', p.host], ['h-user', p.username]] : [['h-name', p.name], ['h-dc', p.dc_id], ['h-host', p.host], ['h-user', p.username]];
    if (!editing) need.push(['h-pass', p.password]);
    need.forEach(([id, v]) => { if (!v) { markBad(form, id); ok = false; } });
    if (!(p.port >= 1 && p.port <= 65535)) { markBad(form, 'h-port'); ok = false; }
    return ok;
  };
  $('#hcancel').addEventListener('click', () => fillForm(null));
  $('#htest').addEventListener('click', async () => {
    const r = $('#hres'); r.hidden = false;
    if (!validate(true)) { r.className = 'result err'; r.textContent = 'Для проверки заполните адрес, пользователя и пароль.'; return; }
    r.className = 'result wait'; r.innerHTML = `<span class="spin"></span> Подключаюсь к ${esc(val('h-host'))}:${esc(val('h-port'))} и читаю конфигурацию…`;
    $('#htest').disabled = true;
    try {
      const t = await api('/admin/hmcs/test', {method: 'POST', body: {...payload(), id: editing}});
      if (t.ok) { r.className = 'result ok'; r.innerHTML = `Подключение успешно за ${nf(t.duration_s, 1)} с. HMC ${esc(t.console.name || '')} ${esc(t.console.version || '')}: серверов ${t.servers}, LPAR ${t.lpars}.${t.warnings.length ? '<br>Предупреждения: ' + esc(t.warnings.join('; ')) : ''}`; }
      else { r.className = 'result err'; r.textContent = t.error; }
    } catch (e) { r.className = 'result err'; r.textContent = e.message; }
    $('#htest').disabled = false;
  });
  form.addEventListener('submit', async e => {
    e.preventDefault();
    if (!validate(false)) { toast('Заполните обязательные поля, отмеченные красным.'); return; }
    try {
      if (editing) await api('/admin/hmcs/' + editing, {method: 'PUT', body: payload()});
      else await api('/admin/hmcs', {method: 'POST', body: payload()});
      toast(editing ? 'Изменения сохранены. Запущен опрос.' : 'HMC добавлена. Первый опрос запущен.');
      vAdmHmc();
    } catch (err) { toast(err.message); }
  });
  $$('[data-edit]').forEach(b => b.addEventListener('click', () => { fillForm(hmcs.find(x => x.id === +b.dataset.edit)); form.scrollIntoView({behavior: 'smooth', block: 'start'}); }));
  $$('[data-poll]').forEach(b => b.addEventListener('click', async () => {
    const r = await api(`/admin/hmcs/${b.dataset.poll}/poll`, {method: 'POST'}).catch(e => toast(e.message));
    if (r) { toast(r.started ? 'Опрос запущен.' : 'Опрос уже идёт.'); setTimeout(() => { if (location.hash === '#/admin/hmc') vAdmHmc(); }, 4000); }
  }));
  $$('[data-del]').forEach(b => b.addEventListener('click', () => confirmInline(b, 'Удалить HMC и её данные?', async () => {
    await api('/admin/hmcs/' + b.dataset.del, {method: 'DELETE'}); toast('HMC удалена.'); vAdmHmc();
  })));
}

/* inline confirm: the button turns into "Точно?" for a few seconds */
function confirmInline(btn, title, action) {
  if (btn.dataset.armed) { action().catch(e => toast(e.message)); return; }
  btn.dataset.armed = '1'; const old = btn.textContent; btn.textContent = 'Подтвердить'; btn.title = title;
  setTimeout(() => { if (btn.isConnected) { delete btn.dataset.armed; btn.textContent = old; } }, 4000);
}

/* ---------- 6. admin: datacenters ---------- */
async function vAdmDc() {
  crumbs([['Администрирование'], ['ЦОД']]);
  const dcs = await api('/admin/datacenters');
  let h = `<h1>ЦОД</h1><p class="sub">Справочник площадок. ЦОД обязательно выбирается при добавлении HMC; все её серверы и LPAR наследуют его в отчётах.</p><div class="grid2"><div style="min-width:0">`;
  if (dcs.length) {
    h += `<div class="tw"><table><thead><tr><th>Код</th><th>Название</th><th>Адрес</th><th class="r">HMC</th><th></th></tr></thead><tbody>`;
    dcs.forEach(d => { h += `<tr><td><span class="tag">${esc(d.code)}</span></td><td class="lname">${esc(d.name)}</td><td class="muted">${esc(d.address)}</td><td class="r">${d.hmc_count}</td>
      <td><button class="btn sm ghost" data-edit="${d.id}">Изменить</button> <button class="btn sm ghost danger" data-del="${d.id}">Удалить</button></td></tr>`; });
    h += '</tbody></table></div>';
  } else h += '<div class="empty"><b>Справочник пуст</b>Добавьте первый ЦОД, затем подключайте HMC.</div>';
  h += `</div><div class="panel"><div class="panel-hd"><h3 style="margin:0" id="dftitle">Новый ЦОД</h3><button class="btn sm ghost" id="dcancel" hidden>Отмена</button></div><div class="panel-bd"><form class="form" id="df" novalidate>
    <div class="field"><label for="d-code">Код <span class="req">*</span></label><input id="d-code" placeholder="МСК-1"><span class="errt">Укажите код</span></div>
    <div class="field"><label for="d-name">Название <span class="req">*</span></label><input id="d-name" placeholder="ЦОД Москва-1"><span class="errt">Укажите название</span></div>
    <div class="field full"><label for="d-addr">Адрес</label><input id="d-addr"></div>
    <div class="formact"><button class="btn primary" type="submit">Сохранить</button></div></form></div></div></div>`;
  view(h);
  let editing = null; const form = $('#df');
  const fillForm = d => { editing = d ? d.id : null; clearBad(form); $('#dftitle').textContent = d ? 'Изменить: ' + d.code : 'Новый ЦОД'; $('#dcancel').hidden = !d;
    $('#d-code').value = d ? d.code : ''; $('#d-name').value = d ? d.name : ''; $('#d-addr').value = d ? d.address : ''; };
  $('#dcancel').addEventListener('click', () => fillForm(null));
  form.addEventListener('submit', async e => {
    e.preventDefault(); clearBad(form);
    const body = {code: val('d-code'), name: val('d-name'), address: val('d-addr')};
    let ok = true; if (!body.code) { markBad(form, 'd-code'); ok = false; } if (!body.name) { markBad(form, 'd-name'); ok = false; }
    if (!ok) return;
    try { await api('/admin/datacenters' + (editing ? '/' + editing : ''), {method: editing ? 'PUT' : 'POST', body}); toast('ЦОД сохранён.'); vAdmDc(); }
    catch (err) { toast(err.message); }
  });
  $$('[data-edit]').forEach(b => b.addEventListener('click', () => fillForm(dcs.find(d => d.id === +b.dataset.edit))));
  $$('[data-del]').forEach(b => b.addEventListener('click', () => confirmInline(b, 'Удалить ЦОД?', async () => {
    await api('/admin/datacenters/' + b.dataset.del, {method: 'DELETE'}); toast('ЦОД удалён.'); vAdmDc();
  })));
}

/* ---------- 7. admin: users ---------- */
async function vUsers() {
  crumbs([['Администрирование'], ['Пользователи']]);
  const users = await api('/admin/users');
  let h = `<h1>Пользователи</h1><p class="sub"><b>Администратор</b> видит всё и управляет подключениями, ЦОД и пользователями. <b>Просмотр</b> видит только инфраструктуру. Пользователи AD появляются здесь сами при первом входе, роль берётся из группы AD.</p>
  <div class="grid2"><div class="tw"><table><thead><tr><th class="sticky1">Логин</th><th>Имя</th><th>Источник</th><th>Роль</th><th>Через группу</th><th>Последний вход</th><th>Статус</th><th></th></tr></thead><tbody>`;
  users.forEach(u => {
    h += `<tr><td class="sticky1 mono">${esc(u.login)}</td><td>${esc(u.name)}</td><td>${u.source === 'ad' ? '<span class="tag acc">AD</span>' : '<span class="tag">Локальный</span>'}</td>
    <td>${u.role === 'admin' ? 'Администратор' : 'Просмотр'}${u.role_locked ? ' <span class="muted" title="Роль закреплена вручную">🔒</span>' : ''}</td><td class="mono muted">${esc(u.via_group || '—')}</td>
    <td class="num">${fmtTime(u.last_login)}</td><td>${u.enabled ? pill('ok', 'Активен') : pill('off', 'Заблокирован')}</td>
    <td><button class="btn sm ghost" data-edit="${u.id}">Изменить</button>${u.login !== ME.login ? ` <button class="btn sm ghost danger" data-del="${u.id}">Удалить</button>` : ''}</td></tr>`;
  });
  h += `</tbody></table></div><div class="panel"><div class="panel-hd"><h3 style="margin:0" id="uftitle">Новый локальный пользователь</h3><button class="btn sm ghost" id="ucancel" hidden>Отмена</button></div><div class="panel-bd"><form class="form" id="uf" novalidate>
    <div class="field"><label for="u-login">Логин <span class="req">*</span></label><input id="u-login" autocomplete="off"><span class="errt">Укажите логин</span></div>
    <div class="field"><label for="u-name">Имя</label><input id="u-name"></div>
    <div class="field"><label for="u-role">Роль</label><select id="u-role"><option value="viewer">Просмотр</option><option value="admin">Администратор</option></select></div>
    <div class="field" id="u-pass-wrap"><label for="u-pass">Пароль <span class="req" id="u-pass-req">*</span></label><input id="u-pass" type="password" autocomplete="new-password"><span class="hint" id="u-pass-hint">Не короче 8 символов</span><span class="errt">Не короче 8 символов</span></div>
    <div class="field full"><label class="check"><input type="checkbox" id="u-en" checked> Вход разрешён</label></div>
    <div class="field full" id="u-lock-wrap" hidden><label class="check"><input type="checkbox" id="u-lock"> Закрепить роль (не брать её из групп AD)</label></div>
    <div class="formact"><button class="btn primary" type="submit">Сохранить</button></div></form>
    <p class="callout" style="margin-top:12px">Пользователей AD создавать не нужно: доступ даётся группами в разделе Active Directory. Здесь их можно заблокировать или закрепить им роль.</p></div></div></div>`;
  view(h);
  let editing = null; const form = $('#uf');
  const fillForm = u => {
    editing = u || null; clearBad(form);
    $('#uftitle').textContent = u ? 'Изменить: ' + u.login : 'Новый локальный пользователь'; $('#ucancel').hidden = !u;
    $('#u-login').value = u ? u.login : ''; $('#u-login').disabled = !!u; $('#u-name').value = u ? u.name : '';
    $('#u-role').value = u ? u.role : 'viewer'; $('#u-en').checked = u ? !!u.enabled : true; $('#u-pass').value = '';
    $('#u-pass-wrap').hidden = !!(u && u.source === 'ad'); $('#u-pass-req').hidden = !!u;
    $('#u-pass-hint').textContent = u ? 'Оставьте пустым, чтобы не менять' : 'Не короче 8 символов';
    $('#u-lock-wrap').hidden = !(u && u.source === 'ad'); $('#u-lock').checked = !!(u && u.role_locked);
  };
  $('#ucancel').addEventListener('click', () => fillForm(null));
  form.addEventListener('submit', async e => {
    e.preventDefault(); clearBad(form);
    const body = {login: editing ? editing.login : val('u-login'), name: val('u-name'), role: val('u-role'), password: $('#u-pass').value, enabled: val('u-en'), role_locked: val('u-lock')};
    let ok = true;
    if (!body.login) { markBad(form, 'u-login'); ok = false; }
    if ((!editing && body.password.length < 8) || (editing && body.password && body.password.length < 8)) { markBad(form, 'u-pass'); ok = false; }
    if (!ok) return;
    try { await api('/admin/users' + (editing ? '/' + editing.id : ''), {method: editing ? 'PUT' : 'POST', body}); toast('Пользователь сохранён.'); vUsers(); }
    catch (err) { toast(err.message); }
  });
  $$('[data-edit]').forEach(b => b.addEventListener('click', () => fillForm(users.find(u => u.id === +b.dataset.edit))));
  $$('[data-del]').forEach(b => b.addEventListener('click', () => confirmInline(b, 'Удалить пользователя?', async () => {
    await api('/admin/users/' + b.dataset.del, {method: 'DELETE'}); toast('Пользователь удалён.'); vUsers();
  })));
}

/* ---------- 8. admin: Active Directory ---------- */
async function vAD() {
  crumbs([['Администрирование'], ['Active Directory']]);
  const ad = await api('/admin/ad');
  view(`<h1>Active Directory</h1><p class="sub">Вход доменной учётной записью через LDAPS. Доступ получают только члены групп из таблицы сопоставления; вложенные группы учитываются.</p>
  <form id="af" novalidate><div class="grid2"><div class="panel"><div class="panel-hd"><h3 style="margin:0">Подключение к домену</h3>${ad.enabled ? pill('ok', 'Вход через AD включён') : pill('off', 'Выключено')}</div><div class="panel-bd"><div class="form">
    <div class="field full"><label class="check"><input type="checkbox" id="a-on"${ad.enabled ? ' checked' : ''}> Разрешить вход через Active Directory</label></div>
    <div class="field"><label for="a-dom">Домен (как показывать на странице входа)</label><input id="a-dom" value="${esc(ad.domain)}" placeholder="CORP"></div>
    <div class="field"><label for="a-srv">Контроллеры домена <span class="req">*</span></label><input id="a-srv" value="${esc(ad.servers)}" placeholder="ldaps://dc01.corp.local:636, ldaps://dc02.corp.local:636"><span class="errt">Укажите хотя бы один</span></div>
    <div class="field full"><label for="a-base">Base DN <span class="req">*</span></label><input id="a-base" value="${esc(ad.base_dn)}" placeholder="DC=corp,DC=local"><span class="errt">Укажите Base DN</span></div>
    <div class="field"><label for="a-bind">Сервисная учётка (bind DN) <span class="req">*</span></label><input id="a-bind" value="${esc(ad.bind_dn)}" placeholder="CN=svc_hmcscan,OU=Service,DC=corp,DC=local"><span class="errt">Укажите учётку</span></div>
    <div class="field"><label for="a-bpass">Пароль сервисной учётки</label><input id="a-bpass" type="password" autocomplete="new-password" placeholder="${ad.has_bind_password ? 'сохранён, оставьте пустым' : ''}"></div>
    <div class="field"><label for="a-filter">Фильтр пользователя</label><input id="a-filter" class="mono" value="${esc(ad.user_filter)}"><span class="errt">Фильтр должен содержать {login}</span></div>
    <div class="field"><label for="a-tls">Проверка сертификата DC</label><select id="a-tls"><option value="verify">Проверять (системные CA)</option><option value="ca">Проверять по своему CA</option><option value="none">Не проверять</option></select></div>
    <div class="field full" id="a-ca-wrap" hidden><label for="a-ca">Сертификат CA домена (PEM)</label><textarea id="a-ca" placeholder="-----BEGIN CERTIFICATE-----">${esc(ad.ca_pem)}</textarea></div>
  </div></div></div>
  <div style="display:flex;flex-direction:column;gap:16px;min-width:0">
  <div class="panel"><div class="panel-hd"><h3 style="margin:0">Группы AD → роли</h3><button type="button" class="btn sm" id="addg">Добавить группу</button></div>
    <div class="panel-bd" style="display:flex;flex-direction:column;gap:8px" id="groups"></div>
    <div class="panel-bd" style="padding-top:0"><p class="callout" style="margin:0">Если пользователь входит в несколько групп, действует старшая роль. Локальная учётка <span class="mono">admin</span> работает всегда, даже если домен недоступен.</p></div></div>
  <div class="panel"><div class="panel-hd"><h3 style="margin:0">Проверка</h3></div><div class="panel-bd"><div class="form">
    <div class="field"><label for="a-tu">Логин</label><input id="a-tu" placeholder="i.ivanov"></div>
    <div class="field"><label for="a-tp">Пароль (необязательно)</label><input id="a-tp" type="password" autocomplete="off"><span class="hint">Без пароля проверяется только поиск и группы</span></div>
    <div class="result" id="ares" hidden></div>
    <div class="formact"><button type="button" class="btn" id="atest">Проверить сохранённые настройки</button></div></div></div></div>
  </div></div>
  <div class="formact" style="margin-top:16px"><button class="btn primary" type="submit">Сохранить настройки</button></div></form>`);
  $('#a-tls').value = ad.tls_mode || 'verify';
  const tlsToggle = () => { $('#a-ca-wrap').hidden = $('#a-tls').value !== 'ca'; };
  $('#a-tls').addEventListener('change', tlsToggle); tlsToggle();
  const addGroup = (g = {dn: '', role: 'viewer', users: null}) => {
    const row = document.createElement('div'); row.className = 'grouprow';
    row.innerHTML = `<input class="mono g-dn" value="${esc(g.dn)}" placeholder="CN=HMCscan-${g.role === 'admin' ? 'Admins' : 'Viewers'},OU=Groups,DC=corp,DC=local" aria-label="DN группы">
      <select class="g-role" aria-label="Роль"><option value="viewer">Просмотр</option><option value="admin">Администратор</option></select>
      <button type="button" class="btn sm ghost danger">Убрать</button>`;
    $('.g-role', row).value = g.role; $('button', row).addEventListener('click', () => row.remove());
    $('#groups').appendChild(row);
  };
  (ad.groups.length ? ad.groups : [{dn: '', role: 'admin'}, {dn: '', role: 'viewer'}]).forEach(addGroup);
  $('#addg').addEventListener('click', () => addGroup());
  const form = $('#af');
  form.addEventListener('submit', async e => {
    e.preventDefault(); clearBad(form);
    const body = {enabled: val('a-on'), domain: val('a-dom'), servers: val('a-srv'), base_dn: val('a-base'), bind_dn: val('a-bind'),
      bind_password: $('#a-bpass').value, user_filter: val('a-filter'), tls_mode: val('a-tls'), ca_pem: $('#a-ca').value,
      groups: $$('.grouprow').map(r => ({dn: $('.g-dn', r).value.trim(), role: $('.g-role', r).value})).filter(g => g.dn)};
    let ok = true;
    if (body.enabled) [['a-srv', body.servers], ['a-base', body.base_dn], ['a-bind', body.bind_dn]].forEach(([id, v]) => { if (!v) { markBad(form, id); ok = false; } });
    if (!body.user_filter.includes('{login}')) { markBad(form, 'a-filter'); ok = false; }
    if (!ok) { toast('Заполните поля, отмеченные красным.'); return; }
    try { await api('/admin/ad', {method: 'PUT', body}); toast('Настройки Active Directory сохранены.'); AUTHCFG = await api('/auth/config'); vAD(); }
    catch (err) { toast(err.message); }
  });
  $('#atest').addEventListener('click', async () => {
    const r = $('#ares'); r.hidden = false;
    if (!val('a-tu')) { r.className = 'result err'; r.textContent = 'Укажите логин для проверки.'; return; }
    r.className = 'result wait'; r.innerHTML = '<span class="spin"></span> Обращаюсь к контроллеру домена…';
    try {
      const t = await api('/admin/ad/test', {method: 'POST', body: {login: val('a-tu'), password: $('#a-tp').value}});
      if (!t.ok) { r.className = 'result err'; r.textContent = t.error; return; }
      r.className = t.role ? 'result ok' : 'result err';
      r.innerHTML = `Найден <b>${esc(t.name)}</b>${t.password_checked ? ', пароль верный' : ''}. Групп: ${t.groups.length}. ` +
        (t.role ? `Роль: <b>${t.role === 'admin' ? 'Администратор' : 'Просмотр'}</b> через ${esc(t.via_group)}.` : 'Ни одна группа не сопоставлена с ролью, вход будет запрещён.');
    } catch (e) { r.className = 'result err'; r.textContent = e.message; }
  });
}

/* ---------- start ---------- */
(async function start() {
  try { AUTHCFG = await (await fetch('/api/auth/config')).json(); } catch (e) { AUTHCFG = {}; }
  try {
    const r = await fetch('/api/auth/me', {credentials: 'same-origin'});
    if (r.ok) { ME = await r.json(); renderShell(); route(); } else showLogin();
  } catch (e) { showLogin('Сервер недоступен'); }
})();
})();
