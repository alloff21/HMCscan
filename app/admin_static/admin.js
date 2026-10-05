/* HMCscan administration: HMC connections, datacenters, users, Active Directory. Needs common.js. */
'use strict';

const APP = {
  subtitle: 'Администрирование', loginSubtitle: 'Администрирование · только для роли «Администратор»',
  nav: [{title: 'Администрирование', items: [
    ['#/hmc', 'hmc', 'link', 'Подключения HMC'], ['#/dc', 'dc', 'dc', 'ЦОД'],
    ['#/users', 'users', 'user', 'Пользователи'], ['#/ad', 'ad', 'lock', 'Active Directory']]}],
  topRight: () => '<button class="btn sm" id="refresh">Опросить все HMC</button>',
  afterShell: () => $('#refresh').addEventListener('click', async () => {
    try {
      const r = await api('/poll', {method: 'POST'});
      toast(r.started ? `Запущен опрос HMC: ${r.started}.` : 'Опрос уже идёт.');
      setTimeout(() => { if ((location.hash || '#/hmc') === '#/hmc') route(); }, 5000);
    } catch (e) { toast(e.message); }
  }),
};

async function route() {
  if (!ME) return;
  const page = location.hash.replace(/^#\/?/, '').split('/')[0] || 'hmc';
  $$('.nav').forEach(a => a.setAttribute('aria-current', a.dataset.nav === page));
  loading();
  try { await ({hmc: vAdmHmc, dc: vAdmDc, users: vUsers, ad: vAD}[page] || vAdmHmc)(); }
  catch (e) { fail(e); }
}

/* ---------- 5. admin: HMC ---------- */
async function vAdmHmc() {
  crumbs([['Подключения HMC']]);
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
      <span class="errt">Выберите ЦОД: без него HMC не попадёт в сводные отчёты</span><span class="hint">${dcs.length ? 'Нет нужного?' : 'Справочник пуст.'} <a href="#/dc" style="color:var(--accent)">Добавить ЦОД</a></span></div>
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
    if (r) { toast(r.started ? 'Опрос запущен.' : 'Опрос уже идёт.'); setTimeout(() => { if ((location.hash || '#/hmc') === '#/hmc') vAdmHmc(); }, 4000); }
  }));
  $$('[data-del]').forEach(b => b.addEventListener('click', () => confirmInline(b, 'Удалить HMC и её данные?', async () => {
    await api('/admin/hmcs/' + b.dataset.del, {method: 'DELETE'}); toast('HMC удалена.'); vAdmHmc();
  })));
}

/* ---------- 6. admin: datacenters ---------- */
async function vAdmDc() {
  crumbs([['ЦОД']]);
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
  crumbs([['Пользователи']]);
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
  crumbs([['Active Directory']]);
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


startApp();
