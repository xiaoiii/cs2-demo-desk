const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const statusNames = { ready:'可下载', catalog:'待解析', resolving:'查找 Demo 中', unavailable:'暂不可下载', queued:'排队中', connecting:'连接中', downloading:'下载中', paused:'已暂停', interrupted:'已中断', completed:'已完成', failed:'下载失败', cancelled:'已取消' };
const retryable = ['ready','catalog','failed','cancelled','interrupted'];
const running = ['resolving','queued','connecting','downloading','paused'];
const canQueue = record => retryable.includes(record.status) || (record.status === 'unavailable' && record.source === 'hltv');
const rangeOptions = [1,7,14,30,90];
let state = { items:[], settings:{historyDays:7,perfectDays:7,tournamentDays:7,autoSync:true}, sync:{}, notice:'' }, page = 'personal', query = '', statusFilter = 'all', eventFilter = 'all', selected = new Set(), lastNotice = '', toastTimer;
function size(bytes) { if (!bytes) return '0 B'; const i = Math.min(3,Math.floor(Math.log(bytes)/Math.log(1024))); return `${(bytes / 1024 ** i).toFixed(i ? 1 : 0)} ${['B','KB','MB','GB'][i]}`; }
function toast(message) { $('#toast').textContent = message; $('#toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').hidden = true, 6500); }
async function call(action, data) { const result = await window.desk.call(action, data); if (!result.ok) { toast(result.error); throw new Error(result.error); } return result.value; }
function source(source, category) { return call('source', { source, category }); }
function isSourcePage() { return ['personal','perfect','tournament'].includes(page); }
function historyDays() { return Math.max(1,Math.min(365,Number(state.settings[page === 'tournament' ? 'tournamentDays' : page === 'perfect' ? 'perfectDays' : 'historyDays']) || 7)); }
function matchTime(r) { const value = typeof r.matchAt === 'number' ? r.matchAt : r.matchAt ? Date.parse(r.matchAt) : NaN; return Number.isFinite(value) && value > 0 ? value : null; }
function dateText(value, includeTime = false) { return new Date(value).toLocaleString('zh-CN', { year:'numeric', month:'2-digit', day:'2-digit', ...(includeTime ? { hour:'2-digit', minute:'2-digit', hour12:false } : {}) }); }
function withinRange(r) { const time = matchTime(r), now = Date.now(); return time === null || (time >= now - historyDays() * 86400000 && time <= now); }
function eventName(r) { return r.event || '赛事待分类'; }
function eventKey(r) { return String(r.eventId || r.event || 'unclassified'); }
function currentItems() {
  return state.items.filter(x => {
    if (['personal','perfect','tournament'].includes(page)) return x.category === page;
    if (page === 'library') return x.status === 'completed';
    if (page === 'downloads') return !['ready','catalog','unavailable'].includes(x.status);
    return true;
  });
}
function rangedItems() { return currentItems().filter(x => !isSourcePage() || withinRange(x)); }
function visibleItems() { return rangedItems().filter(x => (statusFilter === 'all' || x.status === statusFilter) && (page !== 'tournament' || eventFilter === 'all' || eventKey(x) === eventFilter) && `${x.title || ''} ${x.url || ''} ${x.path || ''} ${x.event || ''} ${x.team1 || ''} ${x.team2 || ''} ${x.map || ''} ${x.mode || ''}`.toLowerCase().includes(query.toLowerCase())).sort((a,b) => (matchTime(b) || 0) - (matchTime(a) || 0) || (b.created || 0) - (a.created || 0)); }
function row(r) {
  const progress = r.total > 0 ? Math.min(100, r.received / r.total * 100) : 0;
  let host; try { host = new URL(r.url || r.sourceUrl).hostname; } catch { host = r.source === 'steam' ? 'Steam 官方' : r.source === 'pwa' ? '完美平台' : r.source === 'hltv' ? 'HLTV' : '未知来源'; }
  const button = (action, text, extra = '') => `<button class="button small ${extra}" data-action="${action}" data-id="${r.id}">${text}</button>`;
  let actions = '';
  if (canQueue(r)) actions += button('download-one', r.status === 'unavailable' ? '↻ 重新查找' : ['ready','catalog'].includes(r.status) ? '↓ 下载' : '↻ 重试');
  if (r.source !== 'pwa' && ['failed','interrupted','unavailable'].includes(r.status)) actions += button('record-source', '打开来源', 'subtle');
  if (r.status === 'downloading') actions += button('pause', '暂停');
  if (r.status === 'paused' || (r.status === 'interrupted' && r.speed)) actions += button('resume', '继续');
  if (['downloading','paused','queued'].includes(r.status)) actions += button('cancel', '取消', 'subtle');
  if (r.status === 'completed') {
    actions += button('play-demo', r.files?.length ? '▶ 一键播放' : '▶ 解压并播放');
    if (r.kind !== 'dem' && !r.files?.length) actions += button('extract', r.extracting ? '解压中…' : '解压', r.extracting ? 'loading' : '');
    actions += button('reveal', '定位', 'subtle');
  }
  if (!running.includes(r.status) && !r.extracting) actions += `<button class="icon-button" title="移除记录（保留文件）" aria-label="移除 ${escape(r.title)} 的记录" data-action="remove" data-id="${r.id}">×</button>`;
  const files = page === 'library' && r.files?.length > 1 ? `<div class="file-list">${r.files.map((f, index) => `<div class="file-entry"><span>${escape(f.split(/[\\/]/).pop())}</span><button class="button small" data-action="play-demo" data-id="${r.id}" data-index="${index}">▶ 播放此录像</button></div>`).join('')}</div>` : '';
  const time = matchTime(r), details = [r.category === 'tournament' ? eventName(r) : r.mode, r.map, r.team1 && r.team2 ? `${r.team1} vs ${r.team2}` : ''].filter(Boolean);
  const availability = r.status === 'catalog' ? '下载时自动查找该场比赛的 Demo' : r.status === 'unavailable' ? (r.availabilityReason || (r.category === 'personal' ? '官方尚未提供下载链接，或录像已过期' : '来源暂未提供 Demo，可稍后刷新比赛')) : '';
  return `<div class="demo-row" data-row="${r.id}"><input type="checkbox" data-select="${r.id}" aria-label="选择 ${escape(r.title)}" ${selected.has(r.id) ? 'checked' : ''} ${canQueue(r) ? '' : 'disabled'}><div class="file-icon ${r.category === 'tournament' ? 'tournament-icon' : ''}">${r.kind ? escape(r.kind.toUpperCase()) : 'DEMO'}</div><div class="row-info"><div class="row-title" title="${escape(r.title)}">${escape(r.title)}</div>${details.length ? `<div class="row-detail">${details.map(escape).join('<b>·</b>')}</div>` : ''}<div class="row-meta"><span class="${time === null ? 'unknown-date' : ''}">${time === null ? '比赛日期未知 · 不计入当前时间范围' : dateText(time, true)}</span><b>·</b>${escape(host)}</div>${availability ? `<div class="availability">${escape(availability)}</div>` : ''}${r.error ? `<div class="error">${escape(r.error)}</div>` : ''}</div><div class="row-status"><span class="badge ${r.status}">${r.extracting ? '正在解压' : statusNames[r.status] || escape(r.status)}</span>${['queued','connecting','downloading','paused','completed'].includes(r.status) ? `<small>${size(r.received)}${r.total ? ` / ${size(r.total)}` : ''}${r.speed ? ` · ${size(r.speed)}/s` : ''}</small>` : ''}${['downloading','paused'].includes(r.status) ? `<div class="progress"><i style="width:${progress}%"></i></div>` : ''}</div><div class="row-actions">${actions}</div></div>${files}`;
}
function emptyHTML() {
  if (query || statusFilter !== 'all' || eventFilter !== 'all') return '<div class="empty"><div class="empty-icon">⌕</div><h3>没有符合条件的比赛</h3><p>试试其他关键词、赛事或状态筛选。</p></div>';
  if (isSourcePage()) {
    const sync = state.sync?.[page] || {}, login = sync.phase === 'login_required', verification = sync.phase === 'verification_required';
    const title = sync.phase === 'syncing' ? '正在获取比赛记录' : login ? (page === 'perfect' ? '登录一次，自动获取完美平台 Demo' : '登录一次，自动获取官匹记录') : verification ? '完成来源验证后继续获取' : `近 ${historyDays()} 天暂无已获取的比赛`;
    const description = sync.phase === 'syncing' ? '比赛记录会陆续显示，你可以留在这里查看进度。' : login ? (page === 'perfect' ? '点击上方登录按钮，完成官方授权后自动获取并加密保存凭证。' : '在 Steam 官方页面完成登录后，软件会保存本机登录凭证并自动获取比赛。') : verification ? '在来源窗口完成网站验证，然后刷新比赛。' : '可以扩大时间范围或刷新。已保存的历史记录和本地文件会继续保留。';
    return `<div class="empty"><div class="empty-icon">${page === 'tournament' ? '◇' : page === 'perfect' ? 'P' : '↙'}</div><h3>${title}</h3><p>${description}</p>${sync.phase !== 'syncing' && page !== 'perfect' ? `<button class="button subtle" data-action="${login || verification ? 'verify-source' : 'sync'}">${login ? '登录 Steam 并自动获取' : verification ? '打开验证窗口' : '刷新比赛'} →</button>` : ''}</div>`;
  }
  const texts = {
    downloads:['下载队列空空如也','在个人比赛或赛事中心勾选 Demo 后，点击“下载所选”即可开始。','导入下载链接','import-dialog'],
    library:['你的复盘档案，从这里开始','下载完成的 Demo 会保存在这里。点击一键播放，由 Steam 启动 CS2 自动回放。','查看个人比赛','personal'],
  };
  const [title, description, label, action] = texts[page];
  return `<div class="empty"><div class="empty-icon">${page === 'tournament' ? '◇' : '↙'}</div><h3>${title}</h3><p>${description}</p><button class="button subtle" data-action="${action}">${label} →</button></div>`;
}
function groupedRows(items) {
  if (!isSourcePage()) return items.map(row).join('');
  const known = items.filter(x => matchTime(x) !== null), unknown = items.filter(x => matchTime(x) === null);
  let html = '';
  if (page === 'tournament') {
    const groups = new Map();
    for (const item of known) { const key = eventKey(item); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(item); }
    for (const group of groups.values()) html += `<div class="match-group"><span>◇ ${escape(eventName(group[0]))}</span><small>${group.length} 场比赛</small></div>${group.map(row).join('')}`;
  } else {
    let previous = '';
    for (const item of known) { const day = dateText(matchTime(item)); if (day !== previous) { html += `<div class="match-group"><span>${day}</span></div>`; previous = day; } html += row(item); }
  }
  if (unknown.length) html += `<div class="match-group unknown-group"><span>日期待确认</span><small>${unknown.length} 条记录 · 不计入近 ${historyDays()} 天的比赛</small></div>${unknown.map(row).join('')}`;
  return html;
}
function renderEvents() {
  const el = $('#eventFilter'); if (!el) return;
  const groups = new Map();
  for (const item of rangedItems()) { const key = eventKey(item); if (!groups.has(key)) groups.set(key, { name:eventName(item), count:0 }); groups.get(key).count++; }
  if (eventFilter !== 'all' && !groups.has(eventFilter)) eventFilter = 'all';
  el.innerHTML = `<option value="all">全部赛事 (${groups.size})</option>${[...groups].sort((a,b) => a[1].name.localeCompare(b[1].name,'zh-CN')).map(([key,group]) => `<option value="${escape(key)}" ${key === eventFilter ? 'selected' : ''}>${escape(group.name)} (${group.count})</option>`).join('')}`;
}
function renderRows() {
  renderEvents();
  const items = visibleItems();
  if (!$('#rows')) return;
  $('#rows').innerHTML = items.length ? groupedRows(items) : emptyHTML();
  const eligible = items.filter(canQueue);
  $('#selectAll').checked = eligible.length > 0 && eligible.every(x => selected.has(x.id));
  $('#selectAll').indeterminate = eligible.some(x => selected.has(x.id)) && !$('#selectAll').checked;
  const count = items.filter(x => selected.has(x.id) && canQueue(x)).length;
  $('#downloadSelected').disabled = count === 0; $('#downloadSelected').textContent = `↓ 下载所选${count ? ` (${count})` : ''}`;
  const unknown = isSourcePage() ? items.filter(x => matchTime(x) === null).length : 0;
  $('#listCount').textContent = isSourcePage() ? `近 ${historyDays()} 天 ${items.length - unknown} 场${unknown ? ` · 日期待确认 ${unknown} 条` : ''}` : `${items.length} 条记录`; $('#selectionCount').textContent = `已选择 ${count} 项`;
}
function stats() {
  const items = rangedItems().filter(x => !isSourcePage() || matchTime(x) !== null), completed = items.filter(x => x.status === 'completed');
  return `<div class="stats"><div class="stat"><div><label>${isSourcePage() ? `近 ${historyDays()} 天比赛` : page === 'downloads' ? '下载任务' : '已保存 Demo'}</label><strong>${items.length.toString().padStart(2,'0')}</strong></div><small>▤</small></div><div class="stat"><div><label>已完成</label><strong>${completed.length.toString().padStart(2,'0')}</strong></div><small>✓</small></div><div class="stat"><div><label>已下载大小</label><strong>${size(completed.reduce((a,x) => a + (x.received || 0), 0))}</strong></div><small>↓</small></div></div>`;
}
function syncHTML() {
  const sync = state.sync?.[page] || {}, phase = sync.phase || 'idle';
  const saved = page === 'personal' ? state.auth?.steamSaved : page === 'perfect' ? state.auth?.pwaSaved : false;
  const names = { idle:sync.lastSync ? '已同步' : '准备获取', syncing:'正在自动获取', login_required:page === 'perfect' ? '需要完美平台凭证' : '需要登录 Steam', verification_required:'需要网站验证', error:'获取未完成', partial:'已获取部分记录' };
  const primaryAction = ['login_required','verification_required'].includes(phase) ? 'verify-source' : 'sync';
  const primaryText = phase === 'login_required' ? (page === 'perfect' ? '填写凭证' : '登录 Steam 并自动获取') : phase === 'verification_required' ? '打开验证窗口' : phase === 'syncing' ? '正在获取…' : '↻ 刷新比赛';
  const defaultMessage = page === 'personal' ? '默认获取近一周的官匹记录，包含优先、竞技与搭档模式。' : page === 'perfect' ? '获取完美平台个人比赛，并在下载时生成一次性 Demo 地址。' : '自动获取近期已结束的比赛，并按赛事归类。选择比赛下载时会查找 Demo。';
  return `<div class="sync-state ${phase}"><div class="sync-copy"><div class="sync-title"><span class="sync-indicator ${phase}"></span><strong>${names[phase] || '获取比赛'}</strong>${saved ? '<span class="credential-badge">本机已加密保存凭证</span>' : ''}</div><p id="syncMessage">${escape(sync.message || defaultMessage)}</p><div class="sync-meta">${sync.lastSync ? `上次同步 ${dateText(sync.lastSync, true)}` : '尚无成功同步记录'}${Number.isFinite(sync.found) && sync.lastSync ? `<b>·</b>最近获取 ${sync.found} 场` : ''}${saved && phase === 'login_required' ? '<b>·</b>凭证可能已失效，请更新' : ''}</div></div><div class="sync-actions">${page === 'perfect' && phase === 'login_required' ? '' : `<button class="button primary small" id="syncButton" data-action="${primaryAction}" ${phase === 'syncing' ? 'disabled' : ''}>${primaryText}</button>`}</div></div>`;
}
function rangeHTML() { const days = historyDays(), custom = !rangeOptions.includes(days); return `<div class="range-panel"><div class="range-label"><strong>比赛时间范围</strong><small>调整后自动重新获取，保留历史下载记录</small></div><form id="rangeForm" class="range-controls"><select id="rangeSelect" aria-label="比赛时间范围">${rangeOptions.map(n => `<option value="${n}" ${n === days ? 'selected' : ''}>近 ${n} 天${n === 7 ? '（默认）' : ''}</option>`).join('')}<option value="custom" ${custom ? 'selected' : ''}>自定义天数</option></select><span id="customRange" class="custom-range" ${custom ? '' : 'hidden'}><input type="number" id="customDays" aria-label="自定义比赛天数" min="1" max="365" step="1" value="${days}"><span>天</span><button class="button subtle small" type="submit">应用</button></span></form></div>`; }
function listHTML() { return `<div id="stats">${stats()}</div><div class="section-title"><h2>${page === 'library' ? '已保存的录像' : page === 'downloads' ? '全部下载任务' : '比赛录像'}<small>选择 · 下载 · 复盘</small></h2><button class="button primary small" id="downloadSelected" disabled>↓ 下载所选</button></div><div class="toolbar"><div class="search"><input id="searchInput" aria-label="搜索 Demo" placeholder="搜索比赛、队伍、地图或文件名…" value="${escape(query)}"></div>${page === 'tournament' ? '<select id="eventFilter" aria-label="赛事分类筛选"></select>' : ''}<select id="statusFilter" aria-label="状态筛选"><option value="all">全部状态</option>${Object.entries(statusNames).map(([key,label]) => `<option value="${key}" ${statusFilter === key ? 'selected' : ''}>${label}</option>`).join('')}</select></div><div class="list-panel"><div class="list-header"><input type="checkbox" id="selectAll" aria-label="选择当前列表全部可下载 Demo"><span class="col-title">比赛 / 文件</span><span class="col-status">状态</span><span class="col-action">操作</span></div><div id="rows"></div><div class="list-bottom"><span id="listCount"></span><span id="selectionCount"></span></div></div><div class="info-strip"><span>ⓘ</span><span>${page === 'library' ? '这里展示所有已下载 Demo，不受比赛时间范围限制。解压保留原压缩包，移除记录不会删除文件。' : page === 'tournament' ? '“待解析”比赛可直接勾选下载，软件会自动查找 Demo。赛事可能未发布录像；来源验证、分页上限和部分结果会在同步状态中说明。' : '比赛时间以来源记录为准；日期未知的记录单独列出。官方 Demo 可能过期或尚未提供，扩大时间范围不保证仍可下载。'}</span></div>`; }
function pwaLoginHTML() {
  const saved = state.auth?.pwaSaved, status = state.auth?.pwaLogin;
  return `<p>${escape(status?.message || (saved ? '已加密保存登录凭证，刷新即可获取近期比赛。' : '使用 Steam 登录完美平台，软件会自动获取并加密保存密钥，无需复制粘贴。'))}</p><button class="button primary" data-action="pwa-login">${saved ? '重新登录 / 切换账号' : '使用 Steam 登录完美平台'}</button>${saved ? ' <button class="button subtle small" data-action="pwa-clear">清除完美平台凭证</button>' : ''}`;
}
function renderPage() {
  const titleMap = { personal:['个人比赛','YOUR MATCHES. YOUR NEXT LEVEL.','每一场，都值得复盘','登录 Steam，自动获取近期官方比赛，选择你想复盘的每一场。'], perfect:['完美平台','PERFECT WORLD ARENA.','国服对局，一键保存','获取完美平台个人比赛，选择并下载仍可用的 Demo。'], tournament:['赛事中心','LEARN FROM THE BEST.','把顶级对局，收入囊中','自动获取已结束的比赛，按赛事、队伍与日期找到值得收藏的对局。'], downloads:['下载队列','YOUR REPLAYS, ON THE WAY.','精彩对局，正在抵达','管理下载进度、暂停和重试，所有文件保存在你的电脑上。'], library:['本地 Demo 库','A LIBRARY OF BETTER PLAYS.','你的私人复盘档案','整理已下载录像，解压文件，回到赛场的每一个关键瞬间。'], settings:['偏好设置','MAKE IT YOURS.','按你的习惯，开始','设置下载位置、自动获取与本机登录凭证。'], help:['使用指南','FROM DOWNLOAD TO REPLAY.','三步，回到比赛现场','自动获取比赛，保存 Demo，然后开始复盘。'] };
  titleMap.replay = ['回放按键','YOUR REPLAY. YOUR CONTROLS.','按你的习惯，控制回放','选择常用播放指令，绑定按键，保存后自动生成回放配置。'];
  const [label, eyebrow, heading, subtitle] = titleMap[page];
  $('#breadcrumb').textContent = label; $('#eyebrow').textContent = eyebrow; $('#heading').innerHTML = `${heading}<span>.</span>`; $('#subtitle').textContent = subtitle;
  $('#importButton').hidden = ['settings','help','replay'].includes(page);
  document.querySelectorAll('[data-page]').forEach(b => b.classList.toggle('active', b.dataset.page === page));
  let html = '';
  if (page === 'replay') html += replayEditorHTML();
  if (page === 'personal') html += `<div class="hero"><div><div class="eyebrow">STEAM · AUTO MATCH HISTORY</div><h2>登录一次，近期比赛自动到齐</h2><p>自动获取优先、竞技与搭档模式记录，默认近 7 天。登录凭证保存在本机，失效时再登录即可。</p></div><div class="hero-art">CS2<small>WATCH YOUR GAME</small></div></div><div id="syncPanel" aria-live="polite">${syncHTML()}</div>${rangeHTML()}`;
  if (page === 'perfect') html += `<div class="hero"><div><div class="eyebrow">PERFECT WORLD ARENA · DEMO</div><h2>登录一次，完美比赛自动获取</h2><p>默认获取最近一周的比赛，支持刷新和调整范围。登录密钥由 Windows 本机加密保存。</p></div><div class="hero-art">PWA<small>CHINA MATCHES</small></div></div><div class="settings-card"><h2>连接完美平台</h2><div id="pwaLoginPanel" aria-live="polite">${pwaLoginHTML()}</div><p>在官方页面完成 Steam 登录与授权后，此窗口会自动关闭并获取比赛。登录过期时重新登录即可。</p><details><summary>手动填写（备用）</summary><form id="pwaForm" class="share-row"><input id="pwaSteamId" aria-label="SteamID64" placeholder="SteamID64" inputmode="numeric" required><input id="pwaToken" type="password" aria-label="完美平台 access token" placeholder="access_token" autocomplete="off" required><button class="button primary" type="submit">加密保存并获取</button></form></details></div><div id="syncPanel" aria-live="polite">${syncHTML()}</div>${rangeHTML()}`;
  if (page === 'tournament') html += `<div class="hero tournament"><div><div class="eyebrow">HLTV · AUTO TOURNAMENT CATALOG</div><h2>世界赛场，按赛事自动整理</h2><p>近期已结束的比赛自动汇入列表。筛选赛事或搜索队伍，勾选比赛后自动查找并下载已发布的 Demo。</p></div><div class="hero-art">PRO<small>STUDY THE GREATS</small></div></div><div id="syncPanel" aria-live="polite">${syncHTML()}</div>${rangeHTML()}`;
  if (['personal','perfect','tournament','downloads','library'].includes(page)) html += listHTML();
  if (['personal','tournament'].includes(page)) html += `<details class="manual-options"><summary>补充导入与来源浏览器</summary><p>需要查看原网页或补充单场录像时，可以手动打开来源。自动获取不要求逐页导入。</p><div class="source-shortcuts">${page === 'personal' ? '<button class="button subtle small" data-action="premier">Steam 优先模式 ↗</button><button class="button subtle small" data-action="competitive">竞技模式 ↗</button><button class="button subtle small" data-action="wingman">搭档模式 ↗</button><button class="button subtle small" data-action="share-focus">使用分享码</button>' : '<button class="button subtle small" data-action="hltv">HLTV 已结束比赛 ↗</button><button class="button subtle small" data-action="events">查看赛事网页 ↗</button>'}<button class="button subtle small" data-action="import-dialog">导入下载链接</button></div></details>`;
  if (page === 'personal') html += `<div class="settings-card" id="shareCard" style="margin-top:24px"><h2>已有比赛分享码？</h2><p>将分享码交给已安装的 Steam / CS2 官方客户端解析并下载。此方式的录像和下载进度由游戏管理。</p><form id="shareForm" class="share-row"><input id="shareInput" aria-label="比赛分享码" placeholder="CSGO-xxxxx-xxxxx-xxxxx-xxxxx-xxxxx" required><button class="button subtle" type="submit">在 CS2 中下载 ↗</button></form></div>`;
  if (page === 'settings') html += `<div class="settings-card"><h2>下载位置</h2><p>新任务保存到以下目录，已有文件保留在原位置。</p><div class="path-box">${escape(state.settings.directory)}</div><button class="button primary small" data-action="folder">更改目录</button> <button class="button subtle small" data-action="open-folder">打开目录</button></div><div class="settings-card"><div class="settings-line"><div><h2>启动时自动获取比赛</h2><p>打开软件后自动刷新个人比赛和赛事目录。当前范围：官匹 ${Number(state.settings.historyDays) || 7} 天，赛事 ${Number(state.settings.tournamentDays) || 7} 天；可在各页面调整。</p></div><label class="toggle-label"><input type="checkbox" id="autoSync" aria-label="启动时自动获取比赛" ${state.settings.autoSync !== false ? 'checked' : ''}><span>自动获取</span></label></div></div><div class="settings-card"><div class="settings-line"><div><h2>同时下载任务数</h2><p>暂停的任务占用下载名额。服务器不支持续传时，继续可能从头开始。</p></div><select id="concurrency" aria-label="同时下载任务数">${[1,2,3,4].map(n => `<option value="${n}" ${n === state.settings.concurrency ? 'selected' : ''}>${n} 个任务</option>`).join('')}</select></div></div><div class="settings-card"><h2>Steam 登录凭证</h2><p>在 Steam 官方页面完成登录，软件不保存账号密码。登录凭证由 Windows 在本机加密保存，用于下次自动获取；凭证可能过期或被 Steam 撤销，失效后需要重新登录。</p><p class="credential-status">${state.auth?.steamSaved ? '✓ 已加密保存本机登录凭证' : '当前没有已保存的 Steam 登录凭证'}${state.auth?.encryptionAvailable === false ? ' · 本机加密不可用，无法持久保存登录凭证' : ''}${state.auth?.error ? `<br>${escape(state.auth.error)}` : ''}</p><button class="button subtle small" data-action="logout">清除登录凭证与缓存</button></div><div class="settings-card"><h2>关于 Demo Desk</h2><p>Windows x64 · v1.2.7 · 独立开发的下载工具，与 Valve、Steam 或 HLTV 无隶属关系。个人比赛来自 Steam / Valve，赛事目录与录像来自 HLTV 及对应比赛页提供的来源。</p></div>`;
  if (page === 'help') html += `<div class="guide-grid"><div class="guide-card"><div class="eyebrow">01 / YOUR MATCHES</div><h2>自动获取个人官匹记录</h2><ol><li>首次打开后，点击<strong>“登录 Steam 并自动获取”</strong>。</li><li>在 Steam 官方页面登录自己的账号。</li><li>登录完成后自动获取近期优先 / 竞技 / 搭档比赛。</li><li>默认展示近 7 天，可选择其他范围或自定义 1–365 天。</li><li>勾选可用的比赛，点击“下载所选”。</li></ol><p>登录凭证在本机加密保存，下次打开自动尝试使用；凭证失效后需要重新登录。日期未知的记录单独展示，不计入近期比赛。</p></div><div class="guide-card"><div class="eyebrow">02 / PRO MATCHES</div><h2>自动获取与分类赛事</h2><ol><li>打开“赛事中心”，查看自动获取的近期比赛。</li><li>通过赛事筛选、队伍关键词或时间范围找到对局。</li><li>勾选“待解析”比赛下载，软件会自动查找 Demo。</li><li>若提示网站验证，打开来源窗口完成验证后刷新。</li><li>下载完成后解压，获取各张地图的 .dem。</li></ol><p>“待解析”只代表已找到真实比赛记录，尚未确认有 Demo。来源未发布录像时会显示“暂不可下载”；分页上限、部分加载和网络问题会显示在同步状态中。</p></div><div class="guide-card"><div class="eyebrow">03 / REPLAY</div><h2>通过 Steam 一键播放</h2><ol><li>在“本地 Demo 库”点击“一键播放”或“解压并播放”。</li><li>软件会自动解压，并通过 Steam 启动 CS2。</li><li>如 Steam 提示确认启动选项，确认后继续。</li><li>游戏启动后自动载入所选录像并请求显示 DemoUI，无需输入控制台命令。</li></ol><p>播放前请退出正在运行的 CS2，以便 Steam 应用本次播放参数。多份录像可分别点击“播放此录像”。</p></div><div class="guide-card"><div class="eyebrow">GOOD TO KNOW</div><h2>常见问题</h2><p><strong>记录不完整：</strong>查看顶部同步状态，扩大范围或刷新。来源访问受限时，已经获取的记录会保留。</p><p><strong>没有下载地址：</strong>官方录像可能过期，赛事录像可能尚未发布。历史范围支持 1–365 天，不代表对应时间内的录像都可下载。</p><p><strong>补充导入：</strong>可以使用“补充导入与来源浏览器”查看原网页或导入直接下载链接；分享码交给 CS2 客户端解析。</p><p><strong>重启与压缩文件：</strong>未完成任务在重新启动后可重试。支持 BZ2、ZIP、RAR、7z 提取 Demo，原压缩包会保留。</p></div></div>`;
  $('#pageContent').innerHTML = html;
  if (page === 'replay') bindReplayEditor();
  renderRows();
  $('#searchInput')?.addEventListener('input', e => { query = e.target.value; renderRows(); });
  $('#statusFilter')?.addEventListener('change', e => { statusFilter = e.target.value; renderRows(); });
  $('#eventFilter')?.addEventListener('change', e => { eventFilter = e.target.value; selected.clear(); renderRows(); });
  $('#selectAll')?.addEventListener('change', e => { visibleItems().filter(canQueue).forEach(x => e.target.checked ? selected.add(x.id) : selected.delete(x.id)); renderRows(); });
  $('#downloadSelected')?.addEventListener('click', () => { const ids = visibleItems().filter(x => selected.has(x.id) && canQueue(x)).map(x => x.id); ids.forEach(id => selected.delete(id)); call('queue', { ids }).catch(() => {}); renderRows(); });
  $('#concurrency')?.addEventListener('change', e => call('concurrency', { value:e.target.value }).catch(() => {}));
  $('#autoSync')?.addEventListener('change', e => call('sync-settings', { autoSync:e.target.checked }).catch(() => renderPage()));
  $('#rangeSelect')?.addEventListener('change', e => {
    const custom = e.target.value === 'custom'; $('#customRange').hidden = !custom;
    if (custom) { $('#customDays').focus(); $('#customDays').select(); }
    else applyRange(Number(e.target.value));
  });
  $('#rangeForm')?.addEventListener('submit', e => {
    e.preventDefault();
    const days = Number($('#customDays').value);
    if (!Number.isInteger(days) || days < 1 || days > 365) { toast('请输入 1–365 之间的整数天数。'); return; }
    applyRange(days);
  });
  $('#shareForm')?.addEventListener('submit', e => { e.preventDefault(); call('share-code', { code:$('#shareInput').value }).catch(() => {}); });
  $('#pwaForm')?.addEventListener('submit', async e => { e.preventDefault(); const tokenInput = $('#pwaToken'); try { await call('pwa-save', { steamId:$('#pwaSteamId').value, token:tokenInput.value }); tokenInput.value = ''; } catch {} });
}
async function applyRange(days) {
  const category = page, key = category === 'tournament' ? 'tournamentDays' : category === 'perfect' ? 'perfectDays' : 'historyDays';
  selected.clear();
  try { await call('sync-settings', { [key]:days }); if (page === category) renderPage(); }
  catch { if (page === category) renderPage(); }
}
function update(next) {
  const pwaChanged = state.auth?.pwaSaved !== next.auth?.pwaSaved;
  state = next;
  selected = new Set([...selected].filter(id => state.items.some(x => x.id === id && canQueue(x))));
  $('#personalCount').textContent = state.items.filter(x => x.category === 'personal').length;
  $('#perfectCount').textContent = state.items.filter(x => x.category === 'perfect').length;
  $('#tournamentCount').textContent = state.items.filter(x => x.category === 'tournament').length;
  const count = state.items.filter(x => running.includes(x.status)).length;
  $('#activeCount').textContent = count;
  const fetching = ['personal','perfect','tournament'].filter(category => state.sync?.[category]?.phase === 'syncing').length;
  $('#footerStatus').textContent = [count ? `${count} 个下载任务进行中` : '', fetching ? `正在获取 ${fetching} 个来源的比赛记录` : ''].filter(Boolean).join(' · ') || '就绪 · 所有记录保存在本机';
  if (state.notice && state.notice !== lastNotice) { lastNotice = state.notice; toast(state.notice); }
  if ($('#stats')) $('#stats').innerHTML = stats();
  if ($('#syncPanel')) $('#syncPanel').innerHTML = syncHTML();
  if ($('#pwaLoginPanel')) $('#pwaLoginPanel').innerHTML = pwaLoginHTML();
  if (page === 'settings' || (page === 'perfect' && pwaChanged)) renderPage(); else renderRows();
}
function navigate(next) { page = next; query = ''; statusFilter = 'all'; eventFilter = 'all'; selected.clear(); renderPage(); window.scrollTo(0,0); }
function openImport() { $('#importCategory').value = page === 'tournament' ? 'tournament' : 'personal'; $('#importError').textContent = ''; $('#importDialog').showModal(); $('#links').focus(); }
document.addEventListener('change', e => { if (e.target.dataset.select) { e.target.checked ? selected.add(e.target.dataset.select) : selected.delete(e.target.dataset.select); renderRows(); } });
document.addEventListener('click', async e => {
  const nav = e.target.closest('[data-page]'); if (nav) { navigate(nav.dataset.page); return; }
  const b = e.target.closest('[data-action]'); if (!b) return;
  const action = b.dataset.action, id = b.dataset.id;
  try {
    if (['premier','competitive','wingman','hltv','events'].includes(action)) await source(action, ['hltv','events'].includes(action) ? 'tournament' : 'personal');
    else if (action === 'personal') navigate('personal');
    else if (action === 'import-dialog') openImport();
    else if (action === 'share-focus') { $('#shareCard').scrollIntoView({ behavior:'smooth', block:'center' }); $('#shareInput').focus(); }
    else if (action === 'download-one') await call('queue', { ids:[id] });
    else if (action === 'sync' || action === 'verify-source') await call(action, { category:['personal','perfect','tournament'].includes(page) ? page : 'personal' });
    else await call(action, { id, index:b.dataset.index });
  } catch {}
});
$('#importButton').addEventListener('click', openImport);
for (const id of ['closeDialog','cancelDialog']) $(`#${id}`).addEventListener('click', () => $('#importDialog').close());
$('#importForm').addEventListener('submit', async e => { e.preventDefault(); try { await call('import', { text:$('#links').value, category:$('#importCategory').value }); const next = $('#importCategory').value; $('#links').value = ''; $('#importDialog').close(); navigate(next); } catch (error) { $('#importError').textContent = error.message; } });
window.desk.subscribe(update);
call('state').then(initial => { state = initial; renderPage(); update(initial); }).catch(() => {});
