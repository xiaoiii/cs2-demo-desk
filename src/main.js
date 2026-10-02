const { app, BrowserWindow, WebContentsView, ipcMain, session, dialog, shell, clipboard, Menu, Tray, safeStorage, utilityProcess } = require('electron');
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
const { detectSteam, findInLibraries, isCs2Running, preparePlayback, cleanupPlayback, launchPlayback, stageFiles } = require('./playback');
const { validateSteamId, validateToken, fetchRecentMatches, createDemoDownload } = require('./pwa-client');
const { extractSourcePage } = require('./source-parsers');
const { normalizeOptions, getAutoLaunch, setAutoLaunch } = require('./startup-settings');
const { createDownloadAutomation } = require('./download-automation');
const { createTrayController } = require('./tray-controller');
const {normalizeNetwork,applyNetwork,testConnection,closeNetworks}=require('./steam-network');
const {createReviewService}=require('./review-service');
const {createObs,obsAddress}=require('./studio-obs');
const {createRecording,gameCommand,playerCommand}=require('./studio-recording');
const {createEditor}=require('./studio-editor');
const {createStudioSecrets}=require('./studio-secrets');
const {reviewWithAI,endpoint:aiEndpoint}=require('./studio-ai');
const {createMapService}=require('./studio-map');
const {createVoiceService}=require('./studio-voice');
const {createVoiceHud}=require('./studio-hud');
const {promisify}=require('node:util');

const { isDirectory, gameReplayDirectory, publishDemos } = require('./replay-output');
let replayFolderPrompt;

const testing = process.env.DEMODESK_TEST === '1';
if (testing && process.env.DEMODESK_DATA) app.setPath('userData', process.env.DEMODESK_DATA);
let win, sourceWin, sourceView, browserCategory = 'personal', sourceSession, stateFile, saveTimer, quitting = false, syncEngine, loader, vault, pwaStore, recoveryTimer, pwaSyncing = false;
let recoveryRevision = 0;
let pwaLogin, pwaRevision = 0;
let playbackBusy = false;
let automation, automationTimer, startupPending = true;
let trayController, exitRequested=false;
let networkTesting=false,networkSaving=false;
let reviews,studioObs,studioRecording,studioEditor,studioSecrets,ffmpeg,studioRecordingBusy=false,studioRecordingPromise,studioExportPromise;
let studioMaps,studioVoice,voiceHud;
const studioSettings=()=>state.settings.studio||{};
async function playbackLocations(){
  let steam=state.settings.steamPath||await detectSteam();
  if(!steam||!fs.existsSync(steam)){const result=await dialog.showOpenDialog(win,{title:'选择 steam.exe',properties:['openFile'],filters:[{name:'Steam',extensions:['exe']}]});if(result.canceled)throw new Error('已取消选择 Steam。');steam=result.filePaths[0];}
  if(path.basename(steam).toLowerCase()!=='steam.exe')throw new Error('请选择 Steam 安装目录中的 steam.exe。');
  let game=findInLibraries([path.dirname(steam)])||state.settings.cs2InstallPath;
  if(!game||!fs.existsSync(game)){const result=await dialog.showOpenDialog(win,{title:'定位 CS2 的 game/bin/win64/cs2.exe',properties:['openFile'],filters:[{name:'CS2',extensions:['exe']}]});if(result.canceled)throw new Error('已取消选择游戏目录。');game=result.filePaths[0];}
  if(path.basename(game).toLowerCase()!=='cs2.exe')throw new Error('请选择 CS2 安装目录中的 cs2.exe。');
  Object.assign(state.settings,{steamPath:steam,cs2InstallPath:game});persist();return {steam,game};
}
async function launchStudioDemo(row){
  if(await isCs2Running())throw new Error('请先退出 CS2，再由 Steam 载入所选录像。');
  const {steam,game}=await playbackLocations();await cleanupPlayback(state.settings.playbackStage,game);
  const stage=await preparePlayback(game,row.path,state.settings.replayControls,studioSettings());state.settings.playbackStage=stage;persist();await launchPlayback(steam,stage);return stage;
}
async function videoInfo(filename){
  let text='';try{const r=await promisify(execFile)(ffmpeg,['-hide_banner','-i',filename],{windowsHide:true,timeout:15000,maxBuffer:200000});text=r.stderr;}catch(error){text=error.stderr||'';}
  const match=text.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);if(!match)throw new Error('无法读取视频时长，请检查素材文件。');return {path:filename,name:path.basename(filename),duration:Number(match[1])*3600+Number(match[2])*60+Number(match[3]),preview:pathToFileURL(filename).href,noAudio:!text.includes('Audio:')};
}
function showMain(page){if(!win||win.isDestroyed())return;if(win.isMinimized())win.restore();win.show();win.focus();if(page)win.webContents.send('desk:navigate',page);}
function requestExit(){if(quitting)return;exitRequested=true;if(win&&!win.isDestroyed())win.close();}
let state = { items: [], settings: { directory: '', concurrency: 2, historyDays: 7, tournamentDays: 7, perfectDays: 7, autoSync: true }, sync: { personal: { phase:'idle', message:'登录 Steam 后自动获取最近一周官匹记录。', lastSync:0, found:0 }, perfect: { phase:'login_required', message:'登录完美平台后自动获取 Demo。', lastSync:0, found:0 }, tournament: { phase:'idle', message:'将自动获取最近一周赛事并分类。', lastSync:0, found:0 } }, auth: { steamSaved: false, pwaSaved:false, encryptionAvailable: false, error: '' }, notice: '', version: app.getVersion() };
const active = new Map(), pending = new Map(), extracting = new Map(), resolvingDownloads = new Set();
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
const localURL = name => pathToFileURL(path.join(__dirname, name)).href;
function persist() { try { atomicSave(stateFile, { items: state.items, settings: state.settings, sync: state.sync }); } catch (e) { state.notice = `保存记录失败：${e.message}`; } }
function broadcast(save = true) {
  trayController?.update(state);
  if(win&&!win.isDestroyed()){
    const tasks=state.items.filter(x=>['downloading','connecting','paused'].includes(x.status));
    const total=tasks.reduce((n,x)=>n+(x.total||0),0),received=tasks.reduce((n,x)=>n+(x.received||0),0);
    win.setProgressBar(tasks.length?(total?Math.min(1,received/total):2):-1,{mode:tasks.some(x=>x.status==='paused')?'paused':'normal'});
  }
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
    active.set(record.id, item); automation?.track([record.id]); broadcast();
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
          record.files = [];
          record.error = '';
          record.completedAt = Date.now();
        } catch (e) { record.status = 'failed'; record.error = e.message; }
      } else if (status !== 'cancelled') record.error = '下载中断或链接已过期，请重试；如需登录，请在来源窗口直接下载。';
      if (!quitting && record.status === 'completed' && ['dem','bz2','zip','rar','7z'].includes(record.kind)) {
        // extract() marks the record busy before yielding so completion auto-exit waits.
        void extract(record).catch(error => { record.error = error.message; broadcast(); });
      }
      broadcast(); pump();
    });
  });
}
function pump() {
  if (quitting || networkSaving) return;
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
async function replayDirectory(choose = false) {
  if (!choose && isDirectory(state.settings.replayDirectory)) return state.settings.replayDirectory;
  if (replayFolderPrompt) return replayFolderPrompt;
  replayFolderPrompt = (async () => {
    if (!choose && !state.settings.replayDirectory) {
      const steam = state.settings.steamPath || await detectSteam();
      const found = gameReplayDirectory(state.settings.cs2InstallPath) || gameReplayDirectory(findInLibraries(steam ? [path.dirname(steam)] : []));
      if (found) { state.settings.replayDirectory = found; broadcast(); return found; }
    }
    showMain();
    const result = await dialog.showOpenDialog(win, { title: '选择 Demo 录像目录（建议 CS2 的 game/csgo/replays）', defaultPath: state.settings.replayDirectory || state.settings.directory, properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled || !isDirectory(result.filePaths[0])) throw new Error('尚未选择录像目录。下载文件已保留，请在设置中选择目录后点击重试保存。');
    state.settings.replayDirectory = result.filePaths[0]; persist(); broadcast(); return result.filePaths[0];
  })();
  try { return await replayFolderPrompt; } finally { replayFolderPrompt = null; }
}
async function extract(record) {
  if (record.status !== 'completed' || !record.path || !fs.existsSync(record.path)) throw new Error('请先完成下载，或检查文件是否已被移动。');
  if (extracting.has(record.id)) return extracting.get(record.id).completion;
  if (record.files?.length && !record.error && record.files.every(file => { try { return inspectFile(file) === 'dem'; } catch { return false; } })) return record.files;
  const job = { child: null, kill() { this.child?.kill(); } };
  extracting.set(record.id, job);
  record.extracting = true; record.error = ''; record.files = []; broadcast();
  job.completion = (async () => {
    let attempt;
    try {
      const destination = await replayDirectory();
      job.ready = true;
      if (quitting) throw new Error('保存已中断，原文件已保留。');
      let files = [record.path];
      if (record.kind !== 'dem') {
        // Fresh staging prevents a truncated DEM from a failed attempt being reused.
        const staging = path.join(app.getPath('userData'), 'extraction');
        fs.mkdirSync(staging, { recursive: true });
        attempt = fs.mkdtempSync(path.join(staging, 'unpack-'));
        const binary = app.isPackaged ? path.join(process.resourcesPath, '7zip', '7z.exe') : path.join(__dirname, '..', 'vendor', '7zip', '7z.exe');
        await new Promise((resolve, reject) => {
          const args = ['e', record.path, '-o' + attempt, '-aou', '-y'];
          if (record.kind !== 'bz2') args.push('*.dem', '-r');
          job.child = execFile(binary, args, { windowsHide: true, timeout: 15 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 }, error => error ? reject(new Error('解压失败：压缩包可能损坏、加密或磁盘空间不足。原文件已保留，可重试。')) : resolve());
        });
        files = fs.readdirSync(attempt).map(x => path.join(attempt, x)).filter(x => {
          try { return fs.lstatSync(x).isFile() && !fs.lstatSync(x).isSymbolicLink() && inspectFile(x) === 'dem'; } catch { return false; }
        });
        if (!files.length) throw new Error('压缩包中没有有效的 .dem 文件。原文件已保留。');
      }
      if (quitting) throw new Error('保存已中断，原文件已保留。');
      record.files = await publishDemos(files, destination);
      notice('已保存 ' + record.files.length + ' 个 DEM 到录像目录，可直接一键播放。');
      return record.files;
    } catch (error) { record.files = []; record.error = error.message; throw error; }
    finally {
      // Delete only this operation's generated staging files, without recursive deletion.
      if (attempt) {
        try { for (const entry of fs.readdirSync(attempt, { withFileTypes: true })) if (entry.isFile() || entry.isSymbolicLink()) fs.unlinkSync(path.join(attempt, entry.name)); fs.rmdirSync(attempt); } catch {}
      }
      record.extracting = false; extracting.delete(record.id); broadcast();
    }
  })();
  return job.completion;
}
async function command(action, data = {}) {
  if(networkSaving && !['state','hide-to-tray','cancel-auto-quit'].includes(action))throw new Error('正在切换 Steam 加速，请稍候。');
  switch (action) {
    case 'studio-state': return {library:reviews.list(),recording:studioRecording.status(),editor:studioEditor.list(),settings:studioSettings(),secrets:studioSecrets.status()};
    case 'review-scan': return reviews.scan(await replayDirectory());
    case 'review-players': return reviews.players(data.id);
    case 'review-analyze': return reviews.analyze(data.id,data.playerId);
    case 'review-radar': return reviews.radar(data.id,data.tick,data.endTick);
    case 'review-map': {const meta=await reviews.players(data.id);let game=state.settings.cs2InstallPath;if(!game||!fs.existsSync(game)){const steam=state.settings.steamPath||await detectSteam();game=findInLibraries(steam?[path.dirname(steam)]:[]);}if(!game)throw Error('未找到 CS2 安装目录，可在偏好设置中指定。');return studioMaps.load(game,meta.map);}
    case 'review-voice': {const record=reviews.get(data.id),meta=await reviews.players(data.id),value=await studioVoice.analyze(record.path);voiceHud.prepare(value,meta.players);return {...value,packets:undefined};}
    case 'studio-voice-seek': {if(studioRecordingBusy)throw Error('录制中不能切换语音预览。');return voiceHud.seek(data.tick);}
    case 'studio-voice-hud': {if(studioRecordingBusy)throw Error('请先结束录制。');const url=await voiceHud.start();clipboard.writeText(url);return {url,mode:'preview'};}
    case 'studio-voice-obs': {if(studioRecordingBusy)throw Error('请先结束录制。');return studioObs.addVoiceHud(await voiceHud.start(),studioSettings().obsScene);}
    case 'studio-voice-clear': voiceHud.clear();return true;
    case 'review-open-record': {
      const record=state.items.find(x=>x.id===data.id&&x.status==='completed');if(!record)throw new Error('请先完成 Demo 下载。');if(!record.files?.length)await extract(record);
      const filename=record.files?.[Math.max(0,Number(data.index)||0)];if(!filename)throw new Error('未找到 DEM 文件。');const row=reviews.add(filename);return {record:row,meta:await reviews.players(row.id)};
    }
    case 'review-open-file': {const result=await dialog.showOpenDialog(win,{title:'选择 DEM 文件',properties:['openFile'],filters:[{name:'CS2 Demo',extensions:['dem']}]});if(result.canceled)return null;const row=reviews.add(result.filePaths[0]);return {record:row,meta:await reviews.players(row.id)};}
    case 'review-play': {const row=reviews.get(data.id);if(studioRecordingBusy)throw new Error('请先结束录制。');await launchStudioDemo(row);return true;}
    case 'review-play-clip': {
      if(studioRecordingBusy)throw new Error('请先结束录制。');const analysis=await reviews.analyze(data.id,data.playerId),clip=analysis.clips.find(x=>x.id===data.clipId);if(!clip)throw new Error('片段已失效，请重新分析。');await launchStudioDemo(reviews.get(data.id));notice('录像已由 Steam 启动，载入后可在回放面板跳到目标 Tick。');return {tick:clip.startTick};
    }
    case 'studio-obs-status': return studioObs.status();
    case 'studio-settings': {
      if(studioRecordingBusy)throw new Error('录制进行中，不能修改连接。');const current=studioSettings();const next={obsAddress:obsAddress(data.obsAddress||current.obsAddress),obsScene:String(data.obsScene??current.obsScene??'').slice(0,200),aiBase:String(data.aiBase??current.aiBase??'').trim(),aiModel:String(data.aiModel??current.aiModel??'').trim().slice(0,200),xray:data.xray!==false,cleanHud:data.cleanHud===true};if(next.aiBase)aiEndpoint(next.aiBase);
      const values={};for(const [input,key]of [['obsPassword','obsPassword'],['aiKey','aiKey']])if(typeof data[input]==='string'&&data[input])values[key]=data[input];if(data.clearSecrets===true){values.obsPassword='';values.aiKey='';}if(Object.keys(values).length)studioSecrets.save(values);
      state.settings.studio=next;await studioObs.close();persist();return studioSecrets.status();
    }
    case 'studio-record': {
      voiceHud.clear();
      if(studioRecordingBusy)throw new Error('已有录制任务。');const analysis=await reviews.analyze(data.id,data.playerId);const ids=[...new Set(Array.isArray(data.clipIds)?data.clipIds:[])];const available=new Map(analysis.clips.map(x=>[x.id,x]));let segments=ids.filter(id=>available.has(id)).map(id=>available.get(id));if(data.whole===true)segments=[{label:'整场个人 POV',startTick:Math.min(...analysis.clips.filter(x=>x.kind==='round').map(x=>x.startTick)),endTick:analysis.meta.endTick}];if(!segments.length)throw new Error('请选择录制片段。');if((await studioObs.status()).recording)throw new Error('OBS 已在录制。');await playbackLocations();studioRecordingBusy=true;studioRecordingPromise=studioRecording.execute({demo:reviews.get(data.id),player:analysis.player,segments,scene:studioSettings().obsScene}).catch(error=>notice(error.message)).finally(()=>{studioRecordingBusy=false;});return true;
    }
    case 'studio-record-cancel': studioRecording.cancel();return true;
    case 'studio-ai': return reviewWithAI({settings:studioSettings(),key:studioSecrets.get().aiKey,analysis:await reviews.analyze(data.id,data.playerId)});
    case 'studio-auto-project': {
      const analysis=await reviews.analyze(data.id,data.playerId),valid=new Set(analysis.clips.map(x=>x.id));const ids=[...new Set(Array.isArray(data.clipIds)?data.clipIds:[])].filter(x=>valid.has(x));const recorded=studioRecording.status().clips.filter(x=>x.reviewId===data.id&&x.playerId===data.playerId&&x.complete);const segments=[];
      for(const id of ids){const clip=recorded.find(x=>x.sourceClipId===id);if(clip&&fs.existsSync(clip.path)){const video=await videoInfo(clip.path);segments.push({path:clip.path,start:0,end:video.duration,speed:1,volume:1,title:clip.name,fade:true,noAudio:video.noAudio});}}
      if(!segments.length)throw new Error('没有对应的完整录制素材，请先录制所选片段。');return studioEditor.save({name:`${analysis.player.name} 精彩集锦`,segments});
    }
    case 'studio-video-import': {const result=await dialog.showOpenDialog(win,{title:'添加剪辑素材',properties:['openFile','multiSelections'],filters:[{name:'视频',extensions:['mp4','mkv','mov','avi','webm']}]});return result.canceled?[]:Promise.all(result.filePaths.slice(0,20).map(videoInfo));}
    case 'studio-video-recorded': {const clip=studioRecording.status().clips.find(x=>x.id===data.id);if(!clip||!fs.existsSync(clip.path))throw new Error('录制素材不存在。');return videoInfo(clip.path);}
    case 'studio-project-save': return studioEditor.save(data);
    case 'studio-project-export': {const result=await dialog.showSaveDialog(win,{title:'导出 MP4',defaultPath:path.join(app.getPath('videos'),`Demo-Desk-${Date.now()}.mp4`),filters:[{name:'MP4',extensions:['mp4']}]});if(result.canceled)return false;studioExportPromise=studioEditor.exportProject(data.id,result.filePath).catch(error=>notice(error.message));return true;}
    case 'studio-export-cancel': studioEditor.cancel();return true;
    case 'steam-network-save': {
      const next=normalizeNetwork(data);
      if(networkSaving||active.size||pending.size||resolvingDownloads.size||pwaSyncing||syncEngine.isRunning('personal')||syncEngine.isRunning('tournament')||BrowserWindow.getAllWindows().length>1)throw new Error('请等待下载或获取结束，并关闭来源 / 登录窗口后再修改网络设置。');
      networkSaving=true;
      try{await applyNetwork(sourceSession,next);state.settings.steamNetwork=next;persist();notice('Steam 网络设置已保存，请重新刷新比赛或打开登录页面。');return next;}
      catch(error){await applyNetwork(sourceSession,state.settings.steamNetwork).catch(()=>{});throw error;}
      finally{networkSaving=false;pump();}
    }
    case 'steam-network-test': {
      const next=normalizeNetwork(data);if(networkTesting)throw new Error('连接测试正在进行，请稍候。');networkTesting=true;
      const ses=session.fromPartition(`steam-network-test-${randomUUID()}`,{cache:false});
      try{return await testConnection(ses,next);}finally{await applyNetwork(ses,{enabled:false});await ses.clearStorageData();networkTesting=false;}
    }
    case 'hide-to-tray': if(!trayController)throw new Error('托盘图标暂不可用。');win.hide();trayController.announce();return true;
    case 'exit-app': requestExit();return true;
    case 'refresh-all': await Promise.allSettled([syncEngine.start('personal'),syncEngine.start('tournament'),...(state.auth.pwaSaved?[syncPerfect()]:[])]);return true;
    case 'pause-all':
    case 'resume-all': {
      for(const [id,item] of active){
        const r=state.items.find(x=>x.id===id);if(!r)continue;
        if(action==='pause-all'&&r.status==='downloading'){item.pause();r.status='paused';r.speed=0;}
        if(action==='resume-all'&&r.status==='paused'){item.resume();r.status='downloading';}
      }
      broadcast();return true;
    }
    case 'automation-settings': {
      const next = {...normalizeOptions(state.settings)};
      for(const key of ['autoDownload','autoQuit'])if(data[key]!==undefined){
        if(typeof data[key]!=='boolean')throw new Error('自动任务设置无效。');
        next[key]=data[key];
      }
      if(data.autoDownloadSources!==undefined){
        if(!Array.isArray(data.autoDownloadSources)||data.autoDownloadSources.some(x=>!['personal','perfect','tournament'].includes(x)))throw new Error('自动下载来源无效。');
        next.autoDownloadSources=[...new Set(data.autoDownloadSources)];
      }
      if(next.autoDownload&&!next.autoDownloadSources.length)throw new Error('请至少选择一个自动下载来源。');
      if(data.openAtLogin!==undefined){
        if(typeof data.openAtLogin!=='boolean')throw new Error('开机启动设置无效。');
        state.settings.openAtLogin = testing ? data.openAtLogin : setAutoLaunch(app,data.openAtLogin);
      }
      Object.assign(state.settings,next);
      if(data.autoDownload===false){automation?.stopAutomatic();automation?.cancel();}
      persist();broadcast();return true;
    }
    case 'cancel-auto-quit': automation?.cancel();return true;
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
      const queued = [];
      for (const id of (data.ids || []).slice(0, 300)) {
        const x = state.items.find(x => x.id === id);
        if (x && (['ready', 'catalog', 'failed', 'cancelled', 'interrupted'].includes(x.status) || (x.status === 'unavailable' && x.source === 'hltv')) && !active.has(id) && !resolvingDownloads.has(id)) { x.status = 'queued'; x.error = ''; x.received = 0; queued.push(id); }
      }
      automation?.track(queued); broadcast(); pump(); return;
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
    case 'replay-folder': return replayDirectory(true);
    case 'open-replay-folder': { const folder = await replayDirectory(); const error = await shell.openPath(folder); if (error) throw new Error(error); return; }
    case 'folder': {
      const result = await dialog.showOpenDialog(win, { title: '选择 Demo 保存位置', defaultPath: state.settings.directory, properties: ['openDirectory', 'createDirectory'] });
      if (!result.canceled) { state.settings.directory = result.filePaths[0]; broadcast(); } return;
    }
    case 'concurrency': state.settings.concurrency = Math.min(4, Math.max(1, Number(data.value) || 2)); broadcast(); pump(); return;
    case 'open-folder': { fs.mkdirSync(state.settings.directory, { recursive: true }); const error = await shell.openPath(state.settings.directory); if (error) throw new Error(error); return; }
    case 'reveal': { const r = state.items.find(x => x.id === data.id); const p = r?.files?.[0] || r?.path; if (!p || !fs.existsSync(p)) throw new Error('文件不存在，可能已被移动。'); shell.showItemInFolder(p); return; }
    case 'extract': { const r = state.items.find(x => x.id === data.id); if (!r) throw new Error('找不到该记录。'); return extract(r); }
    case 'play-demo': {
      if(studioRecordingBusy)throw new Error('请先结束工作室录制。');
      if (playbackBusy) throw new Error('正在准备回放，请稍候。');
      playbackBusy = true;
      try {
      const record = state.items.find(item => item.id === data.id);
      if (!record || record.status !== 'completed') throw new Error('请先完成 Demo 下载。');
      if (await isCs2Running()) throw new Error('CS2 已在运行。请先退出游戏，再点一键播放；Steam 重新启动游戏后会自动载入录像，无需输入控制台命令。');
      if (record.extracting || !record.files?.length) await extract(record);
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
      if (typeof saved.settings?.replayDirectory === 'string') state.settings.replayDirectory = saved.settings.replayDirectory;
      if (typeof saved.settings?.directory === 'string') state.settings.directory = saved.settings.directory;
      state.settings.concurrency = Math.min(4, Math.max(1, Number(saved.settings?.concurrency) || 2));
      state.settings.historyDays = clampDays(saved.settings?.historyDays);
      state.settings.tournamentDays = clampDays(saved.settings?.tournamentDays);
      state.settings.perfectDays = clampDays(saved.settings?.perfectDays);
      if (typeof saved.settings?.steamPath === 'string') state.settings.steamPath = saved.settings.steamPath;
      if (typeof saved.settings?.cs2InstallPath === 'string') state.settings.cs2InstallPath = saved.settings.cs2InstallPath;
      if(saved.settings?.studio&&typeof saved.settings.studio==='object')state.settings.studio=saved.settings.studio;
      try { state.settings.replayControls = require('./replay-controls').normalize(saved.settings?.replayControls); } catch { state.settings.replayControls = require('./replay-controls').defaults(); }
      if (saved.settings?.playbackStage && typeof saved.settings.playbackStage.gameExe === 'string' && typeof saved.settings.playbackStage.id === 'string') state.settings.playbackStage = saved.settings.playbackStage;
      state.settings.autoSync = saved.settings?.autoSync !== false;
      try{state.settings.steamNetwork=normalizeNetwork(saved.settings?.steamNetwork);}catch{state.settings.steamNetwork=normalizeNetwork();}
      Object.assign(state.settings,normalizeOptions(saved.settings));
      if(testing)state.settings.openAtLogin=saved.settings?.openAtLogin===true;
      for (const category of ['personal','perfect','tournament']) if (saved.sync?.[category]) Object.assign(state.sync[category], { lastSync: Number(saved.sync[category].lastSync) || 0, found: Number(saved.sync[category].found) || 0 });
      for (const r of state.items) { if (['queued','connecting','downloading','paused','interrupted','resolving'].includes(r.status)) { r.status = 'interrupted'; r.error = '上次退出时下载未完成。点击重试将重新下载。'; } r.extracting = false; r.speed = 0; }
    }
  } catch { state.notice = '历史记录读取失败，已启动空白列表。原记录保留在用户数据目录。'; stateFile = path.join(app.getPath('userData'), `library-recovered-${Date.now()}.json`); }
  if (testing && !state.settings.replayDirectory) {
    state.settings.replayDirectory = path.join(app.getPath('userData'), 'replays');
    fs.mkdirSync(state.settings.replayDirectory, { recursive: true });
  } else if (!state.settings.replayDirectory) {
    const steam = state.settings.steamPath || await detectSteam();
    state.settings.replayDirectory = gameReplayDirectory(state.settings.cs2InstallPath) || gameReplayDirectory(findInLibraries(steam ? [path.dirname(steam)] : []));
  }
  sourceSession = session.fromPartition('persist:demo-sources'); setupSession(sourceSession);
  const studioDirectory=path.join(app.getPath('userData'),'studio');fs.mkdirSync(studioDirectory,{recursive:true});
  reviews=createReviewService({directory:studioDirectory,workerFactory:(file,options)=>{
    const child=utilityProcess.fork(file.replace('app.asar','app.asar.unpacked'),[],{serviceName:'Demo Desk DEM Parser',stdio:'ignore'});
    child.once('spawn',()=>child.postMessage(options.workerData));child.terminate=async()=>{child.kill();};return child;
  }});studioSecrets=createStudioSecrets({filename:path.join(studioDirectory,'connections.bin'),safeStorage});
  studioMaps=createMapService({directory:path.join(studioDirectory,'maps'),decoder:app.isPackaged?path.join(process.resourcesPath,'source2-cli','Source2Viewer-CLI.exe'):path.join(__dirname,'..','vendor','source2-cli','Source2Viewer-CLI.exe')});
  studioVoice=createVoiceService({workerFactory:(file,options)=>{const child=utilityProcess.fork(file,[],{serviceName:'Demo Desk Voice Parser',stdio:'ignore'});child.once('spawn',()=>child.postMessage(options.workerData));child.terminate=async()=>{child.kill();};return child;}});voiceHud=createVoiceHud();
  studioObs=createObs({settings:studioSettings,secrets:studioSecrets.get});
  studioRecording=createRecording({obs:studioObs,launch:launchStudioDemo,gameExe:()=>state.settings.cs2InstallPath,directory:studioDirectory});
  ffmpeg=app.isPackaged?path.join(process.resourcesPath,'ffmpeg','ffmpeg.exe'):require('ffmpeg-static');studioEditor=createEditor({directory:studioDirectory,ffmpeg});
  state.settings.steamNetwork=normalizeNetwork(state.settings.steamNetwork);
  try {await applyNetwork(sourceSession,state.settings.steamNetwork);}
  catch {state.settings.steamNetwork={enabled:false};state.notice='内置 Steam 加速启动失败，已恢复普通连接。可在设置中重新开启。';}
  Object.assign(state.settings,normalizeOptions(state.settings));
  if(!testing){
    try { state.settings.openAtLogin=getAutoLaunch(app); }
    catch {state.settings.openAtLogin=false;}
  }
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
    configureSession:ses=>applyNetwork(ses,state.settings.steamNetwork),
    releaseSession:ses=>applyNetwork(ses,{enabled:false}),
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
  if(!testing||process.env.DEMODESK_TEST_TRAY==='1'){
    try {trayController=createTrayController({Tray,Menu,icon:path.join(__dirname,'assets','icon.ico'),show:showMain,action:name=>{void command(name).catch(e=>notice(e.message));},exit:requestExit});trayController.update(state);}
    catch {notice('托盘图标创建失败，关闭窗口时将退出软件。');}
  }
  automation = createDownloadAutomation({state,queue:ids=>{void command('queue',{ids});},
    isBusy:()=>startupPending||networkTesting||networkSaving||reviews.busy||studioMaps.busy||studioVoice.busy||studioRecordingBusy||studioEditor.busy||active.size||pending.size||extracting.size||resolvingDownloads.size||playbackBusy||pwaSyncing||Boolean(sourceWin&&!sourceWin.isDestroyed())||BrowserWindow.getAllWindows().length>1,
    quit:requestExit,onChange:()=>broadcast(false)});
  automationTimer=setInterval(()=>{if(!quitting)automation.tick();},500);
  win.webContents.once('did-finish-load', () => {
    setTimeout(async()=>{
      while(networkSaving&&!quitting)await new Promise(resolve=>setTimeout(resolve,100));
      if(quitting)return;
      try {
        if(!testing||process.env.DEMODESK_TEST_AUTOSYNC==='1'){
          const options=normalizeOptions(state.settings), sources=new Set();
          if(state.settings.autoSync){sources.add('personal');sources.add('tournament');if(state.auth.pwaSaved)sources.add('perfect');}
          if(options.autoDownload){automation.begin(options.autoDownloadSources);options.autoDownloadSources.forEach(x=>sources.add(x));}
          await Promise.allSettled([...sources].map(c=>c==='perfect'?syncPerfect():syncEngine.start(c)));
          automation.settled();
        }
      } finally {startupPending=false;}
    },600);
  });
  win.on('close', event => {
    if (quitting) return;
    if(trayController&&!exitRequested){event.preventDefault();win.hide();trayController.announce();return;}
    if (!testing && (active.size || pending.size || extracting.size || resolvingDownloads.size || reviews.busy || studioVoice.busy || studioMaps.busy || studioRecordingBusy || studioEditor.busy)) {
      const answer = dialog.showMessageBoxSync(win, { type: 'question', buttons: ['继续下载', '退出软件'], defaultId: 0, cancelId: 0, title: '仍有任务进行中', message: '退出会中断下载或解压。重新打开后，可手动重试下载。' });
      if (answer === 0) { exitRequested=false;event.preventDefault(); return; }
    }
    event.preventDefault(); quitting = true; clearInterval(automationTimer); pwaLogin.close(); pwaRevision++; syncEngine.stop(); loader.closeAll(); clearTimeout(recoveryTimer);
    for (const [id, item] of active) { const r = state.items.find(x => x.id === id); if (r) r.status = 'interrupted'; item.cancel(); }
    for (const child of extracting.values()) child.kill();
    sourceWin?.close(); clearTimeout(saveTimer); persist();
    vault.stop();
    studioRecording.cancel();studioEditor.cancel();
    Promise.allSettled([vault.save(),reviews.stop(),studioVoice.stop(),studioMaps.stop(),voiceHud.close(),studioRecordingPromise,studioExportPromise, ...[...extracting.values()].filter(job => job.ready).map(job => job.completion)]).then(()=>studioObs.close()).then(()=>closeNetworks()).catch(()=>{}).finally(() => { clearTimeout(saveTimer); persist(); trayController?.destroy();trayController=null;win.destroy(); app.quit(); });
  });
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit',event=>{if(!quitting&&win&&!win.isDestroyed()){event.preventDefault();requestExit();}});
