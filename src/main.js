const { app, BrowserWindow, WebContentsView, ipcMain, session, dialog, shell, clipboard, Menu, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { SOURCES, httpURL, sourceOf, uniquePath, inspectFile, parseLinks, shareCode, extractPage, atomicSave } = require('./core');
const { createSyncEngine, clampDays } = require('./sync-engine');
const { createSourceLoader } = require('./source-loader');
const { createSessionVault } = require('./session-vault');
const { createSecretStore } = require('./secret-store');
const { createPwaLogin } = require('./pwa-login');
const { detectSteam, findInLibraries, isCs2Running, preparePlayback, cleanupPlayback, launchPlayback } = require('./playback');
const { validateSteamId, validateToken, fetchRecentMatches, createDemoDownload } = require('./pwa-client');
const { extractSourcePage } = require('./source-parsers');

const testing = process.env.DEMODESK_TEST === '1';
if (testing && process.env.DEMODESK_DATA) app.setPath('userData', process.env.DEMODESK_DATA);
let win, sourceWin, sourceView, browserCategory = 'personal', sourceSession, stateFile, saveTimer, quitting = false, syncEngine, loader, vault, pwaStore, recoveryTimer, pwaSyncing = false;
let recoveryRevision = 0;
let pwaLogin, pwaRevision = 0;
let playbackBusy = false;
let state = { items: [], settings: { directory: '', concurrency: 2, historyDays: 7, tournamentDays: 7, perfectDays: 7, autoSync: true }, sync: { personal: { phase:'idle', message:'登录 Steam 后自动获取最近一周官匹记录。', lastSync:0, found:0 }, perfect: { phase:'login_required', message:'登录完美平台后自动获取 Demo。', lastSync:0, found:0 }, tournament: { phase:'idle', message:'将自动获取最近一周赛事并分类。', lastSync:0, found:0 } }, auth: { steamSaved: false, pwaSaved:false, encryptionAvailable: false, error: '' }, notice: '', version: app.getVersion() };
const active = new Map(), pending = new Map(), extracting = new Map(), resolvingDownloads = new Set();
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
const localURL = name => pathToFileURL(path.join(__dirname, name)).href;
function persist() { try { atomicSave(stateFile, { items: state.items, settings: state.settings, sync: state.sync }); } catch (e) { state.notice = `保存记录失败：${e.message}`; } }
function broadcast(save = true) {
  if (save) { clearTimeout(saveTimer); saveTimer = setTimeout(persist, 200); }
  if (win && !win.isDestroyed()) win.webContents.send('desk:state', state);
  if (sourceWin && !sourceWin.isDestroyed()) sourceWin.webContents.send('desk:state', state);
}
function notice(message) { state.notice = message; broadcast(); }
async function syncPerfect() {
  if (pwaSyncing) return;
  const credentials = pwaStore?.get();
  const revision = pwaRevision;
  if (!credentials) { Object.assign(state.sync.perfect, { phase:'login_required', message:'请点击使用 Steam 登录完美平台，自动获取凭证。' }); broadcast(); return; }
  pwaSyncing = true; Object.assign(state.sync.perfect, { phase:'syncing', message:`正在获取最近 ${state.settings.perfectDays} 天的完美平台比赛…` }); broadcast();
  try {
    const rows = await fetchRecentMatches(credentials);
    if (quitting || revision !== pwaRevision) return;
    const cutoff = Date.now() - state.settings.perfectDays * 86400000;
    const recent = rows.filter(row => !row.matchAt || row.matchAt >= cutoff);
    for (const row of recent) {
      let record = state.items.find(item => item.source === 'pwa' && item.matchId === row.matchId);
      if (!record) { record = { id:randomUUID(), url:'', source:'pwa', category:'perfect', status:'ready', received:0, total:0, speed:0, created:Date.now(), files:[] }; state.items.unshift(record); }
      Object.assign(record, { matchId:row.matchId, cupId:row.cupId, matchAt:row.matchAt, map:row.map, mode:row.mode, title:row.title || `完美平台比赛 ${row.matchId}` });
      if (!['completed','downloading','paused','connecting','queued'].includes(record.status)) { record.status = 'ready'; record.error = ''; }
    }
    Object.assign(state.sync.perfect, { phase:rows.length >= 20 ? 'partial' : 'idle', message:`已获取 ${recent.length} 场近期完美平台比赛。${rows.length >= 20 ? '本次接口返回最近 20 场；更早比赛可能未包含在内，已保存的历史记录会保留。' : ''}`, lastSync:Date.now(), found:recent.length });
  } catch (error) {
    if (quitting || revision !== pwaRevision) return;
    const expired = /失效|401|403/.test(error.message);
    Object.assign(state.sync.perfect, { phase:expired ? 'login_required' : 'error', message:error.message });
  } finally { pwaSyncing = false; if (!quitting) { broadcast(); if (revision !== pwaRevision && pwaStore?.get()) void syncPerfect(); } }
}
function addLinks(links, category) {
  let added = 0;
  for (const entry of links.slice(0, 300)) {
    const url = httpURL(entry.url);
    if (state.items.some(x => x.url === url)) continue;
    state.items.unshift({ id: randomUUID(), url, title: String(entry.title || 'Demo').slice(0, 240), category: category || entry.category || sourceOf(url), pageUrl: entry.pageUrl ? httpURL(entry.pageUrl) : '', status: 'ready', received: 0, total: 0, speed: 0, created: Date.now(), files: [] });
    added++;
  }
  notice(added ? `已导入 ${added} 个 Demo，可勾选后下载。` : '这些 Demo 已在列表中。');
  return added;
}
function setupSession(ses) {
  ses.setPermissionRequestHandler((wc, permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.on('will-download', (event, item) => {
    const chain = item.getURLChain();
    let record = [...pending.values()].find(x => chain.includes(x._downloadUrl || x.url));
    const mime = item.getMimeType();
    if (!record && !/\.(dem|bz2|zip|rar|7z)$/i.test(item.getFilename())) { event.preventDefault(); notice('已忽略非 Demo 文件下载。'); return; }
    if (!record) {
      const url = item.getURL();
      record = state.items.find(x => x.url === url && !active.has(x.id) && x.status !== 'completed');
      if (!record) { addLinks([{ url, title: item.getFilename(), pageUrl: sourceView?.webContents.getURL() }], browserCategory); record = state.items.find(x => x.url === url); }
      if (!record || active.has(record.id) || record.status === 'completed') { event.preventDefault(); return; }
    }
    const timeout = record._timer; clearTimeout(timeout); delete record._timer; pending.delete(record.id);
    if (/(?:text\/html|application\/json|text\/plain)/i.test(mime)) {
      event.preventDefault(); record.status = 'failed'; record.error = '来源返回了网页而非 Demo。请打开来源页面完成登录或验证，再点击下载。'; broadcast(); pump(); return;
    }
    try {
      fs.mkdirSync(state.settings.directory, { recursive: true });
      record.path = uniquePath(state.settings.directory, record.downloadName || item.getFilename(), state.items.map(x => x.path));
      item.setSavePath(record.path);
    } catch (e) { event.preventDefault(); record.status = 'failed'; record.error = `无法写入下载目录：${e.message}`; broadcast(); pump(); return; }
    record.status = 'downloading'; record.error = ''; record.total = item.getTotalBytes();
    active.set(record.id, item); broadcast();
    item.on('updated', (_, status) => {
      record.received = item.getReceivedBytes(); record.total = item.getTotalBytes(); record.speed = item.getCurrentBytesPerSecond();
      record.status = item.isPaused() || status === 'interrupted' ? 'paused' : 'downloading';
      if (status === 'interrupted') record.error = '网络连接暂时中断，可尝试继续，或取消后重试。';
      broadcast(false);
    });
    item.once('done', (_, status) => {
      active.delete(record.id); record.speed = 0; record.received = item.getReceivedBytes();
      record.status = status === 'completed' ? 'completed' : quitting ? 'interrupted' : status === 'cancelled' ? 'cancelled' : 'failed';
      if (status === 'completed') {
        try {
          record.kind = inspectFile(record.path);
          if (!record.kind) throw new Error('文件内容不是受支持的 Demo 或压缩包，可能是错误页面。');
          record.files = record.kind === 'dem' ? [record.path] : [];
          record.completedAt = Date.now();
        } catch (e) { record.status = 'failed'; record.error = e.message; }
      } else if (status !== 'cancelled') record.error = '下载中断或链接已过期，请重试；如需登录，请在来源窗口直接下载。';
      broadcast(); pump();
    });
  });
}
function pump() {
  if (quitting) return;
  while (active.size + pending.size + resolvingDownloads.size < state.settings.concurrency) {
    const record = state.items.find(x => x.status === 'queued');
    if (!record) break;
    if (!record.url) {
      if (record.source === 'pwa' && record.matchId) {
        const credentials = pwaStore?.get();
        if (!credentials) { record.status = 'failed'; record.error = '完美平台凭证不存在，请重新保存。'; broadcast(); continue; }
        resolvingDownloads.add(record.id); record.status = 'resolving'; broadcast();
        createDemoDownload({ ...credentials, matchId:record.matchId, cupId:record.cupId }).then(request => {
          record.downloadName = request.filename;
          Object.defineProperty(record, '_downloadUrl', { value:request.url, writable:true, configurable:true, enumerable:false });
          record.status = 'connecting'; pending.set(record.id, record);
          const timer = setTimeout(() => { pending.delete(record.id); if (record.status === 'connecting') { record.status = 'failed'; record.error = '连接完美平台 Demo 超时，请更新令牌后重试。'; broadcast(); pump(); } }, 45000);
          Object.defineProperty(record, '_timer', { value:timer, writable:true, configurable:true, enumerable:false });
          sourceSession.downloadURL(request.url, { headers:request.headers });
        }).catch(error => { record.status = 'failed'; record.error = error.message; }).finally(() => { resolvingDownloads.delete(record.id); broadcast(); pump(); });
        continue;
      }
      if (record.source !== 'hltv' || !record.pageUrl) { record.status = 'unavailable'; record.error = '来源尚未提供 Demo 下载地址。'; broadcast(); continue; }
      resolvingDownloads.add(record.id);
      syncEngine.resolveRecord(record).then(() => {
        if (record.url && record.status === 'ready' && !quitting) record.status = 'queued';
      }).finally(() => { resolvingDownloads.delete(record.id); broadcast(); pump(); });
      continue;
    }
    record.status = 'connecting'; record.error = ''; pending.set(record.id, record);
    const timer = setTimeout(() => { pending.delete(record.id); if (record.status === 'connecting') { record.status = 'failed'; record.error = '连接超时。请打开来源页面检查登录、链接或网络。'; broadcast(); pump(); } }, 45000);
    Object.defineProperty(record, '_timer', { value: timer, writable: true, configurable: true, enumerable: false });
    try { sourceSession.downloadURL(record.url, record.pageUrl ? { headers: { Referer: record.pageUrl } } : {}); }
    catch (e) { clearTimeout(timer); pending.delete(record.id); record.status = 'failed'; record.error = e.message; }
    broadcast();
  }
}
function browserState(error = '') {
  if (!sourceWin || sourceWin.isDestroyed() || !sourceView) return;
  const wc = sourceView.webContents;
  sourceWin.webContents.send('desk:browser', { url: wc.getURL(), title: wc.getTitle(), loading: wc.isLoading(), category: browserCategory, error });
}
async function scanSource() {
  if (!sourceView || sourceView.webContents.isDestroyed()) throw new Error('请先打开比赛来源。');
  const page = await sourceView.webContents.executeJavaScript(`(${extractPage.toString()})()`);
  if (!page.links.length) {
    const msg = '此页尚未找到 Demo。请登录并打开比赛记录 / 具体赛事比赛页面，等待加载完成后再次导入，也可直接点击页面的 Demo 下载按钮。';
    notice(msg); browserState(msg); return 0;
  }
  const count = addLinks(page.links, browserCategory); browserState(`已导入 ${count} 个新 Demo。返回主窗口可选择并下载。`); win.show(); return count;
}
async function openSource(url, category) {
  url = httpURL(url); browserCategory = category || sourceOf(url);
  if (!sourceWin || sourceWin.isDestroyed()) {
    sourceWin = new BrowserWindow({ width: 1180, height: 860, minWidth: 780, minHeight: 580, title: 'Demo 来源浏览器', backgroundColor: '#14181e', autoHideMenuBar: true, webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
    sourceWin.setMenu(null);
    sourceView = new WebContentsView({ webPreferences: { session: sourceSession, contextIsolation: true, sandbox: true, nodeIntegration: false } });
    sourceWin.contentView.addChildView(sourceView);
    const resize = () => { if (sourceWin && !sourceWin.isDestroyed()) { const [width, height] = sourceWin.getContentSize(); sourceView.setBounds({ x: 0, y: 112, width, height: Math.max(1, height - 112) }); } };
    sourceWin.on('resize', resize); resize();
    sourceWin.on('closed', () => { sourceView?.webContents.close(); sourceView = null; sourceWin = null; });
    sourceWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    sourceWin.webContents.on('will-navigate', (event) => event.preventDefault());
    const wc = sourceView.webContents;
    wc.setWindowOpenHandler(({ url }) => { try { wc.loadURL(httpURL(url)).catch(e => browserState(e.message)); } catch {} return { action: 'deny' }; });
    wc.on('will-navigate', (event, url) => { try { httpURL(url); } catch { event.preventDefault(); } });
    wc.on('will-redirect', (event, url) => { try { httpURL(url); } catch { event.preventDefault(); } });
    for (const event of ['did-start-loading', 'did-stop-loading', 'did-navigate', 'did-navigate-in-page', 'page-title-updated']) wc.on(event, () => browserState());
    wc.on('did-start-loading', () => { recoveryRevision++; clearTimeout(recoveryTimer); });
    wc.on('did-stop-loading', () => {
      clearTimeout(recoveryTimer);
      const revision = ++recoveryRevision, category = browserCategory;
      let attempts = 0;
      const checkRecovery = async () => {
        if (quitting || wc.isDestroyed() || revision !== recoveryRevision || attempts++ >= 24) return;
        if (!['login_required','verification_required'].includes(state.sync[category]?.phase)) return;
        const current = wc.getURL();
        try {
          const testSource = testing && process.env.DEMODESK_SOURCE_BASE && new URL(current).origin === new URL(process.env.DEMODESK_SOURCE_BASE).origin;
          if (category === 'personal' && !(testSource ? /\/history(?:\?|$)/.test(current) : /^https:\/\/steamcommunity\.com\/(?:id|profiles|my)\/.*gcpd\/730/i.test(current))) return;
          if (category === 'tournament' && !(testSource ? /\/(?:results|matches)/.test(current) : /^https:\/\/(?:www\.)?hltv\.org\/(?:results|matches)/i.test(current))) return;
          const kind = category === 'personal' ? 'steam' : /\/matches\//.test(current) ? 'hltv-match' : 'hltv-results';
          const result = await wc.executeJavaScript(`(${extractSourcePage.toString()})(${JSON.stringify(kind)},{})`);
          if (result.recognized && !result.loginRequired && !result.challenge) {
            await vault.save();
            if (quitting || wc.isDestroyed() || revision !== recoveryRevision) return;
            syncEngine.start(category);
            for (const r of state.items.filter(x => x.category === category && x.status === 'failed' && x.pageUrl === current)) { r.status = 'queued'; r.error = ''; }
            pump(); browserState('登录 / 验证已完成，正在自动获取比赛，可返回主窗口。'); return;
          }
        } catch {}
        recoveryTimer = setTimeout(checkRecovery, 500);
      };
      recoveryTimer = setTimeout(checkRecovery, 500);
    });
    wc.on('did-fail-load', (_, code, desc, url, main) => { if (main && code !== -3) browserState(`页面加载失败：${desc}。可刷新或复制地址到系统浏览器。`); });
    await sourceWin.loadFile(path.join(__dirname, 'browser.html'));
  }
  sourceWin.show(); sourceWin.focus();
  sourceView.webContents.loadURL(url).catch(e => browserState(`页面加载失败：${e.message}`));
  return true;
}
async function extract(record) {
  if (record.status !== 'completed' || !record.path || !fs.existsSync(record.path)) throw new Error('请先完成下载，或检查文件是否已被移动。');
  if (record.kind === 'dem') return record.files;
  if (extracting.has(record.id)) return;
  const destination = path.join(path.dirname(record.path), 'extracted', record.id);
  fs.mkdirSync(destination, { recursive: true });
  const binary = app.isPackaged ? path.join(process.resourcesPath, '7zip', '7z.exe') : path.join(__dirname, '..', 'vendor', '7zip', '7z.exe');
  record.extracting = true; record.error = ''; broadcast();
  return new Promise((resolve, reject) => {
    const args = ['e', record.path, `-o${destination}`, '-aou', '-y'];
    if (record.kind !== 'bz2') args.push('*.dem', '-r');
    const child = execFile(binary, args, { windowsHide: true, timeout: 15 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 }, (error) => {
      extracting.delete(record.id); record.extracting = false;
      const files = fs.readdirSync(destination).map(x => path.join(destination, x)).filter(x => fs.lstatSync(x).isFile() && !fs.lstatSync(x).isSymbolicLink());
      record.files = files.filter(x => { try { return inspectFile(x) === 'dem'; } catch { return false; } });
      if (error || !record.files.length) { record.error = error ? '解压失败：压缩包可能损坏、加密或不受支持。原文件已保留。' : '压缩包中没有有效的 .dem 文件。'; broadcast(); reject(new Error(record.error)); }
      else { notice(`解压完成，找到 ${record.files.length} 个 Demo。`); resolve(record.files); }
    });
    extracting.set(record.id, child);
  });
}
async function command(action, data = {}) {
  switch (action) {
    case 'replay-controls-save': {
      const controls = require('./replay-controls').normalize(data);
      const {writeConfig,installConfig} = require('./replay-config');
      const local = writeConfig(app.getPath('userData'),controls);
      state.settings.replayControls = controls;
      persist();
      let installed = false;
      const gameExe = state.settings.cs2InstallPath || findInLibraries([path.dirname(state.settings.steamPath || '')]);
      if (gameExe && fs.existsSync(gameExe)) {
        try { installConfig(gameExe,controls); installed = true; }
        catch { notice('按键已保存；游戏目录写入失败，下次播放时会重试。'); return {local,installed:false}; }
      }
      notice('回放按键和 CFG 已保存，下次一键播放时自动生效。当前游戏内的按键不会立即改变。');
      return {local,installed};
    }
    case 'state': return state;
    case 'sync': if (data.category === 'perfect') await syncPerfect(); else syncEngine.start(data.category); return true;
    case 'sync-settings': {
      const categories = [];
      if (data.historyDays !== undefined) { state.settings.historyDays = clampDays(data.historyDays); categories.push('personal'); }
      if (data.tournamentDays !== undefined) { state.settings.tournamentDays = clampDays(data.tournamentDays); categories.push('tournament'); }
      if (data.perfectDays !== undefined) { state.settings.perfectDays = clampDays(data.perfectDays); categories.push('perfect'); }
      if (typeof data.autoSync === 'boolean') state.settings.autoSync = data.autoSync;
      broadcast();
      for (const category of categories) {
        if (category === 'perfect') syncPerfect(); else { if (syncEngine.isRunning(category)) syncEngine.stop(category); syncEngine.start(category); }
      }
      return true;
    }
    case 'verify-source': { const category = data.category === 'tournament' ? 'tournament' : 'personal'; return openSource(state.sync[category].verifyUrl || (category === 'personal' ? SOURCES.premier : SOURCES.hltv), category); }
    case 'import': return addLinks(parseLinks(String(data.text || ''), ['personal','tournament'].includes(data.category) ? data.category : undefined));
    case 'source': return openSource(SOURCES[data.source] || httpURL(data.url), data.category);
    case 'record-source': { const r = state.items.find(x => x.id === data.id); if (!r) throw new Error('找不到该记录。'); return openSource(r.pageUrl || r.url, r.category); }
    case 'scan': return scanSource();
    case 'browser-back': if (sourceView?.webContents.navigationHistory.canGoBack()) sourceView.webContents.navigationHistory.goBack(); return;
    case 'browser-forward': if (sourceView?.webContents.navigationHistory.canGoForward()) sourceView.webContents.navigationHistory.goForward(); return;
    case 'browser-reload': sourceView?.webContents.reload(); return;
    case 'browser-url': return openSource(data.url, browserCategory);
    case 'browser-external': if (sourceView) return shell.openExternal(httpURL(sourceView.webContents.getURL())); return;
    case 'main': win.show(); win.focus(); return;
    case 'queue': {
      for (const id of (data.ids || []).slice(0, 300)) {
        const x = state.items.find(x => x.id === id);
        if (x && (['ready', 'catalog', 'failed', 'cancelled', 'interrupted'].includes(x.status) || (x.status === 'unavailable' && x.source === 'hltv')) && !active.has(id) && !resolvingDownloads.has(id)) { x.status = 'queued'; x.error = ''; x.received = 0; }
      }
      broadcast(); pump(); return;
    }
    case 'pause': { const item = active.get(data.id); if (item) { item.pause(); const r = state.items.find(x => x.id === data.id); r.status = 'paused'; r.speed = 0; broadcast(); } return; }
    case 'resume': { const item = active.get(data.id); if (item) { item.resume(); state.items.find(x => x.id === data.id).status = 'downloading'; broadcast(); } return; }
    case 'cancel': {
      const r = state.items.find(x => x.id === data.id); if (!r) return;
      if (active.has(r.id)) active.get(r.id).cancel();
      else if (r.status === 'queued') { r.status = 'cancelled'; broadcast(); pump(); }
      else if (r.status === 'connecting') throw new Error('正在建立下载连接，请连接成功后取消。');
      return;
    }
    case 'remove': {
      const r = state.items.find(x => x.id === data.id);
      if (active.has(data.id) || pending.has(data.id) || resolvingDownloads.has(data.id) || r?.extracting || r?.status === 'queued') throw new Error('请先取消下载再移除。');
      state.items = state.items.filter(x => x.id !== data.id); broadcast(); return;
    }
    case 'folder': {
      const result = await dialog.showOpenDialog(win, { title: '选择 Demo 保存位置', defaultPath: state.settings.directory, properties: ['openDirectory', 'createDirectory'] });
      if (!result.canceled) { state.settings.directory = result.filePaths[0]; broadcast(); } return;
    }
    case 'concurrency': state.settings.concurrency = Math.min(4, Math.max(1, Number(data.value) || 2)); broadcast(); pump(); return;
    case 'open-folder': { fs.mkdirSync(state.settings.directory, { recursive: true }); const error = await shell.openPath(state.settings.directory); if (error) throw new Error(error); return; }
    case 'reveal': { const r = state.items.find(x => x.id === data.id); const p = r?.files?.[0] || r?.path; if (!p || !fs.existsSync(p)) throw new Error('文件不存在，可能已被移动。'); shell.showItemInFolder(p); return; }
    case 'extract': { const r = state.items.find(x => x.id === data.id); if (!r) throw new Error('找不到该记录。'); return extract(r); }
    case 'play-demo': {
      if (playbackBusy) throw new Error('正在准备回放，请稍候。');
      playbackBusy = true;
      try {
      const record = state.items.find(item => item.id === data.id);
      if (!record || record.status !== 'completed') throw new Error('请先完成 Demo 下载。');
      if (await isCs2Running()) throw new Error('CS2 已在运行。请先退出游戏，再点一键播放；Steam 重新启动游戏后会自动载入录像，无需输入控制台命令。');
      if (!record.files?.length) await extract(record);
      const filename = record.files?.[Number(data.index) || 0];
      if (!filename) throw new Error('未找到可播放的 Demo。');
      let executable = state.settings.steamPath || await detectSteam();
      if (!executable || !fs.existsSync(executable)) {
        const result = await dialog.showOpenDialog(win, { title:'选择 Steam 安装目录中的 steam.exe（只需一次）', properties:['openFile'], filters:[{ name:'Steam', extensions:['exe'] }] });
        if (result.canceled) return false;
        executable = result.filePaths[0];
      }
      let gameExe = findInLibraries([path.dirname(executable)]) || state.settings.cs2InstallPath;
      if (!gameExe || !fs.existsSync(gameExe)) {
        const result = await dialog.showOpenDialog(win,{title:'定位 CS2 的 game/bin/win64/cs2.exe（仅用于查找游戏目录）',properties:['openFile'],filters:[{name:'CS2 安装位置',extensions:['exe']}]});
        if (result.canceled) return false;
        gameExe = result.filePaths[0];
      }
      if (await isCs2Running()) throw new Error('CS2 已启动，请先退出游戏后再准备下一场回放。');
      await cleanupPlayback(state.settings.playbackStage,gameExe);
      notice('正在将录像准备到游戏目录，完成后由 Steam 自动启动回放…');
      const stage = await preparePlayback(gameExe,filename,state.settings.replayControls || require('./replay-controls').defaults());
      state.settings.playbackStage = stage;
      state.settings.cs2InstallPath = gameExe;
      if (await isCs2Running()) throw new Error('准备期间 CS2 已启动，请退出游戏后再次点击播放。');
      await launchPlayback(executable, stage);
      state.settings.steamPath = executable;
      notice('录像已准备完成，已请求 Steam 执行自动回放配置；若弹出启动确认，请点启动，无需控制台操作。');
      return true;
      } finally { playbackBusy = false; }
    }
    case 'play-command': {
      const r = state.items.find(x => x.id === data.id); const p = r?.files?.[Number(data.index) || 0];
      if (!p || !fs.existsSync(p)) throw new Error('请先解压 Demo，或检查本地文件。');
      clipboard.writeText(`playdemo "${p.replace(/\\/g, '/').replace(/["\r\n]/g, '')}"`); notice('已复制播放命令。在 CS2 开发者控制台中粘贴运行。'); return;
    }
    case 'share-code': { const code = shareCode(data.code); await shell.openExternal(`steam://rungame/730/76561202255233023/+csgo_download_match%20${code}`); notice('已将分享码交给 Steam / CS2。该方式的下载进度请在游戏内查看。'); return; }
    case 'pwa-login': pwaLogin.open(); return true;
    case 'pwa-save': {
      const credentials = { steamId:validateSteamId(data.steamId), token:validateToken(data.token) };
      pwaLogin.close(); pwaStore.save(credentials); pwaRevision++; state.auth.pwaSaved = true; state.auth.error = ''; notice('完美平台凭证已由 Windows 加密保存。'); await syncPerfect(); return true;
    }
    case 'pwa-clear': pwaLogin.close(); pwaRevision++; pwaStore.clear(); state.auth.pwaSaved = false; state.auth.pwaLogin = { phase:'idle', message:'凭证已清除，点击登录即可自动获取。' }; Object.assign(state.sync.perfect, { phase:'login_required', message:'完美平台凭证已清除，请点击登录。' }); notice('已清除完美平台凭证，历史记录和 Demo 文件已保留。'); return true;
    case 'logout': {
      recoveryRevision++; clearTimeout(recoveryTimer);
      syncEngine.stop(); loader.closeAll(); if (sourceWin) sourceWin.close();
      await vault.clear(); await sourceSession.clearStorageData(); await sourceSession.clearCache(); vault.start();
      Object.assign(state.sync.personal, { phase:'login_required', message:'已清除登录凭证。再次登录 Steam 后会自动获取比赛。', verifyUrl:SOURCES.premier });
      notice('来源浏览器的登录信息、加密凭证和缓存已清除。'); return;
    }
    default: throw new Error('未知操作。');
  }
}
app.whenReady().then(async () => {
  stateFile = path.join(app.getPath('userData'), 'library.json');
  state.settings.directory = testing ? path.join(app.getPath('userData'), 'downloads') : path.join(app.getPath('downloads'), 'CS2 Demos');
  try {
    if (fs.existsSync(stateFile)) {
      const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (Array.isArray(saved.items)) state.items = saved.items.filter(x => x && typeof x.id === 'string' && typeof x.url === 'string');
      if (typeof saved.settings?.directory === 'string') state.settings.directory = saved.settings.directory;
      state.settings.concurrency = Math.min(4, Math.max(1, Number(saved.settings?.concurrency) || 2));
      state.settings.historyDays = clampDays(saved.settings?.historyDays);
      state.settings.tournamentDays = clampDays(saved.settings?.tournamentDays);
      state.settings.perfectDays = clampDays(saved.settings?.perfectDays);
      if (typeof saved.settings?.steamPath === 'string') state.settings.steamPath = saved.settings.steamPath;
      if (typeof saved.settings?.cs2InstallPath === 'string') state.settings.cs2InstallPath = saved.settings.cs2InstallPath;
      try { state.settings.replayControls = require('./replay-controls').normalize(saved.settings?.replayControls); } catch { state.settings.replayControls = require('./replay-controls').defaults(); }
      if (saved.settings?.playbackStage && typeof saved.settings.playbackStage.gameExe === 'string' && typeof saved.settings.playbackStage.id === 'string') state.settings.playbackStage = saved.settings.playbackStage;
      state.settings.autoSync = saved.settings?.autoSync !== false;
      for (const category of ['personal','perfect','tournament']) if (saved.sync?.[category]) Object.assign(state.sync[category], { lastSync: Number(saved.sync[category].lastSync) || 0, found: Number(saved.sync[category].found) || 0 });
      for (const r of state.items) { if (['queued','connecting','downloading','paused','interrupted','resolving'].includes(r.status)) { r.status = 'interrupted'; r.error = '上次退出时下载未完成。点击重试将重新下载。'; } r.extracting = false; r.speed = 0; }
    }
  } catch { state.notice = '历史记录读取失败，已启动空白列表。原记录保留在用户数据目录。'; stateFile = path.join(app.getPath('userData'), `library-recovered-${Date.now()}.json`); }
  sourceSession = session.fromPartition('persist:demo-sources'); setupSession(sourceSession);
  vault = createSessionVault({ session:sourceSession, safeStorage, filename:path.join(app.getPath('userData'),'steam-session.bin'), onStatus: status => {
    Object.assign(state.auth, { steamSaved:status.saved, encryptionAvailable:status.available, error:status.error || '' }); broadcast(false);
  } });
  await vault.restore(); vault.start();
  pwaStore = createSecretStore({ safeStorage, filename:path.join(app.getPath('userData'),'pwa-credentials.bin') });
  try { pwaStore.load(); state.auth.pwaSaved = Boolean(pwaStore.get()); } catch (error) { state.auth.error = error.message; }
  loader = createSourceLoader(sourceSession);
  const syncUrls = { ...SOURCES };
  if (testing && process.env.DEMODESK_SOURCE_BASE) {
    const base = new URL(process.env.DEMODESK_SOURCE_BASE);
    if (!['127.0.0.1','localhost'].includes(base.hostname)) throw new Error('测试来源必须是本机服务器。');
    for (const key of ['premier','competitive','wingman','hltv']) syncUrls[key] = new URL(key === 'hltv' ? '/results' : `/history?mode=${key}`,base).href;
  }
  syncEngine = createSyncEngine({ state, loadPage:loader.load, closePage:loader.close, onChange:() => broadcast(), urls:syncUrls });
  Menu.setApplicationMenu(null);
  win = new BrowserWindow({ width: 1380, height: 920, minWidth: 1020, minHeight: 700, icon: path.join(__dirname, 'assets', 'icon.png'), backgroundColor: '#111318', title: 'CS2 Demo Desk', webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  pwaLogin = createPwaLogin({ BrowserWindow, session, parent:win,
    onCredentials: credentials => { pwaStore.save(credentials); pwaRevision++; state.auth.pwaSaved = true; state.auth.error = ''; },
    onStatus: status => {
      state.auth.pwaLogin = status; broadcast(false);
      // Only predefined stage messages and booleans; never URLs, cookies, IDs or tokens.
      try { atomicSave(path.join(app.getPath('userData'),'pwa-login-status.json'), { time:new Date().toISOString(), phase:status.phase, tokenCaptured:Boolean(status.tokenCaptured), identityCaptured:Boolean(status.identityCaptured), saved:state.auth.pwaSaved }); } catch {}
      if (status.phase === 'saved') { notice('完美平台密钥已自动捕获并保存，正在获取最近比赛。'); void syncPerfect(); }
    }
  });
  win.webContents.on('will-navigate', event => event.preventDefault());
  ipcMain.handle('desk:call', async (event, action, data) => {
    const allowed = [localURL('index.html'), localURL('browser.html')];
    if (event.senderFrame !== event.sender.mainFrame || !allowed.includes(event.senderFrame.url)) return { ok: false, error: '不受信任的页面。' };
    try { return { ok: true, value: await command(action, data) }; } catch (e) { return { ok: false, error: e.message }; }
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  win.webContents.once('did-finish-load', () => {
    if (state.settings.autoSync && (!testing || process.env.DEMODESK_TEST_AUTOSYNC === '1')) {
      setTimeout(() => { if (!quitting) { syncEngine.start('personal'); if (state.auth.pwaSaved) syncPerfect(); syncEngine.start('tournament'); } }, 600);
    }
  });
  win.on('close', event => {
    if (quitting) return;
    if (!testing && (active.size || pending.size || extracting.size || resolvingDownloads.size)) {
      const answer = dialog.showMessageBoxSync(win, { type: 'question', buttons: ['继续下载', '退出软件'], defaultId: 0, cancelId: 0, title: '仍有任务进行中', message: '退出会中断下载或解压。重新打开后，可手动重试下载。' });
      if (answer === 0) { event.preventDefault(); return; }
    }
    event.preventDefault(); quitting = true; pwaLogin.close(); pwaRevision++; syncEngine.stop(); loader.closeAll(); clearTimeout(recoveryTimer);
    for (const [id, item] of active) { const r = state.items.find(x => x.id === id); if (r) r.status = 'interrupted'; item.cancel(); }
    for (const child of extracting.values()) child.kill();
    sourceWin?.close(); clearTimeout(saveTimer); persist();
    vault.stop();
    Promise.resolve(vault.save()).catch(() => {}).finally(() => { clearTimeout(saveTimer); persist(); win.destroy(); app.quit(); });
  });
});
app.on('window-all-closed', () => app.quit());
