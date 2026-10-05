/* HMCscan viewer: read-only pages. Needs common.js. */
'use strict';

const APP = {
  subtitle: 'LPAR inventory', loginSubtitle: 'Инвентаризация IBM Power',
  nav: [{title: 'Инфраструктура', items: [['#/overview', 'overview', 'hmc', 'HMC и серверы'], ['#/lpars', 'lpars', 'list', 'Все LPAR']]}],
};

/* ---------- router ---------- */
async function route() {
  if (!ME) return;
  const parts = (location.hash.replace(/^#\/?/, '') || 'overview').split('/');
  const nav = parts[0] === 'hmc' || parts[0] === 'server' ? 'overview' : parts[0];
  $$('.nav').forEach(a => a.setAttribute('aria-current', a.dataset.nav === nav));
  $('#overlay').innerHTML = '';
  loading();
  try {
    switch (parts[0]) {
      case 'hmc': return await vServers(+parts[1]);
      case 'server': return await vServer(decodeURIComponent(parts[1]));
      case 'lpars': return await vAll();
      default: return await vOverview();
    }
  } catch (e) { fail(e); }
}

/* ---------- 1. overview ---------- */
async function vOverview() {
  crumbs([['HMC и серверы']]);
  const d = await api('/overview');
  const t = d.totals;
  const last = d.hmcs.map(h => h.polled_at).filter(Boolean).sort().pop();
  $('#syncinfo').textContent = last ? 'Последний опрос ' + fmtTime(last) : '';
  if (!d.hmcs.length) {
    return view(`<h1>HMC и серверы</h1><div class="empty"><b>Пока не подключено ни одной HMC</b>
      HMC подключаются в интерфейсе администрирования (по умолчанию порт 8844).</div>`);
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


startApp();
