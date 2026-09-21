const { randomUUID } = require('node:crypto');
const { validateSteamId, validateToken } = require('./pwa-client');

const CALLBACK = 'https://partner.wmpvp.com/#/login';
const LOGIN_URL = `https://passport.pwesports.cn/steam/login?appId=10&callback=${encodeURIComponent(CALLBACK)}&state=appAdmin`;
const LOGIN_HOSTS = new Set(['partner.wmpvp.com', 'passport.pwesports.cn', 'store.steampowered.com', 'steamcommunity.com', 'login.steampowered.com', 'help.steampowered.com']);
function allowedNavigation(value) {
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && !u.port && LOGIN_HOSTS.has(u.hostname); } catch { return false; }
}
function callbackToken(value) {
  try {
    const u = new URL(value);
    if (u.origin !== 'https://partner.wmpvp.com') return '';
    const p = new URLSearchParams(u.search);
    const fragment = new URLSearchParams(u.hash.includes('?') ? u.hash.slice(u.hash.indexOf('?') + 1) : u.hash.slice(1));
    for (const [key, value] of fragment) p.set(key, value);
    if (p.get('state') !== 'appAdmin') return '';
    return validateToken(p.get('token') || p.get('access_token'));
  } catch { return ''; }
}
function platformToken(cookies, fallback = '') {
  const hosts = ['partner.wmpvp.com', 'wmpvp.com', 'pwaweblogin.wmpvp.com', 'client.wmpvp.com'];
  for (const name of ['access_token', 'steam_cn_token']) {
    for (const c of cookies) {
      if (hosts.includes(String(c.domain || '').replace(/^\./, '').toLowerCase()) && c.name === name) {
        try { return validateToken(c.value); } catch {}
      }
    }
  }
  try { return validateToken(fallback); } catch { return ''; }
}
function identityFromURL(value) {
  try {
    const u = new URL(value);
    if (!['https://passport.pwesports.cn', 'https://partner.wmpvp.com'].includes(u.origin)) return '';
    const p = new URLSearchParams(u.search);
    for (const [key, value] of new URLSearchParams(u.hash.includes('?') ? u.hash.slice(u.hash.indexOf('?') + 1) : u.hash.slice(1))) p.set(key,value);
    const claimed = p.get('openid.claimed_id') || '';
    const id = p.get('steamid') || p.get('steam_id') || (claimed.match(/^https:\/\/steamcommunity\.com\/openid\/id\/(7656119\d{10})$/) || [])[1];
    return validateSteamId(id);
  } catch { return ''; }
}
function credentialsFromCookies(cookies, token = '', observedId = '') {
  const domain = c => String(c.domain || '').replace(/^\./, '').toLowerCase();
  // The platform may exchange the callback token for a final access_token cookie.
  token = platformToken(cookies, token);
  const ids = new Set();
  try { if (observedId) ids.add(validateSteamId(observedId)); } catch {}
  for (const c of cookies) {
    if (!['store.steampowered.com', 'steampowered.com', 'steamcommunity.com', 'login.steampowered.com'].includes(domain(c)) || !['steamLoginSecure', 'steamLogin'].includes(c.name)) continue;
    try { ids.add(validateSteamId(decodeURIComponent(c.value).split('||')[0])); } catch {}
  }
  // Never pair an ambiguous Steam identity with a platform token.
  if (ids.size !== 1) return null;
  try { return { steamId:[...ids][0], token:validateToken(token) }; } catch { return null; }
}

async function resolveSessionIdentity(ses) {
  try {
    // /my refers to this isolated session's own profile, never to a local Steam account guess.
    const response = await ses.fetch('https://steamcommunity.com/my/?xml=1', { credentials:'include', signal:AbortSignal.timeout(15000) });
    if (!response.ok || new URL(response.url).origin !== 'https://steamcommunity.com') return '';
    const xml = await response.text();
    const id = xml.match(/<steamID64>\s*(7656119\d{10})\s*<\/steamID64>/)?.[1];
    return validateSteamId(id);
  } catch { return ''; }
}
function createPwaLogin({ BrowserWindow, session, parent, validate = async () => {}, onCredentials, onStatus }) {
  let current = null;
  function close() { current?.finish(); }
  function open() {
    if (current) { current.window.show(); current.window.focus(); return; }
    const ses = session.fromPartition(`pwa-login-${randomUUID()}`, { cache:false });
    ses.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
    ses.setPermissionCheckHandler(() => false);
    const window = new BrowserWindow({ width:1000, height:800, title:'使用 Steam 登录完美平台 · 登录后自动保存', autoHideMenuBar:true, parent,
      webPreferences:{ session:ses, contextIsolation:true, sandbox:true, nodeIntegration:false, devTools:false } });
    const run = { window, stopped:false, token:'', steamId:'', checking:false, lastAttempt:'', timer:null, poll:null, finish:null, tokenCaptured:false, identityCaptured:false, identityAttemptAt:0 };
    current = run;
    const status = (phase, message) => {
      if (!run.stopped) {
        const value = { phase, message, tokenCaptured:run.tokenCaptured, identityCaptured:run.identityCaptured };
        const key = JSON.stringify(value);
        if (key !== run.lastStatus) { run.lastStatus = key; onStatus(value); }
      }
    };
    const finish = (completed = false) => {
      if (run.stopped) return;
      run.stopped = true; clearTimeout(run.timer); clearInterval(run.poll); ses.cookies.removeListener('changed', changed);
      ses.webRequest?.onBeforeRequest(null);
      ses.webRequest?.onHeadersReceived(null);
      if (current === run) current = null;
      if (!window.isDestroyed()) window.destroy();
      void ses.clearStorageData().catch(() => {});
      if (!completed) onStatus({ phase:'closed', message:run.tokenCaptured ? '登录窗口已关闭；本次已收到令牌，但尚未完成账号识别或保存。请重新打开登录。' : '登录窗口已关闭；本次尚未收到完美平台令牌。', tokenCaptured:run.tokenCaptured, identityCaptured:run.identityCaptured });
    };
    run.finish = finish;
    async function capture(url = '') {
      if (run.stopped) return;
      const token = callbackToken(url); if (token) run.token = token;
      const steamId = identityFromURL(url); if (steamId) run.steamId = steamId;
      if (run.checking) { run.pending = true; return; }
      run.checking = true;
      try {
        const cookies = await ses.cookies.get({});
        if (run.stopped) return;
        run.token = platformToken(cookies, run.token);
        run.tokenCaptured = Boolean(run.token);
        let credentials = credentialsFromCookies(cookies, run.token, run.steamId);
        if (run.token && !credentials && !run.steamId && Date.now() - run.identityAttemptAt > 20000) {
          run.identityAttemptAt = Date.now();
          status('identifying', '已自动捕获完美平台密钥，正在识别本次登录的 Steam 账号…');
          run.steamId = await resolveSessionIdentity(ses);
          if (run.stopped) return;
          credentials = credentialsFromCookies(await ses.cookies.get({}), run.token, run.steamId);
        }
        run.identityCaptured = Boolean(credentials);
        if (!credentials) {
          if (run.token) status('identity_required', '已捕获密钥，但暂未识别 Steam 账号；请在登录窗口完成 Steam 授权并稍候。');
          return;
        }
        const attempt = JSON.stringify(credentials);
        if (attempt === run.lastAttempt) return;
        run.lastAttempt = attempt;
        status('checking', '已捕获密钥并识别账号，正在加密保存…');
        await validate(credentials);
        if (run.stopped) return;
        // Synchronous encrypted commit, after the cancellation check.
        onCredentials(credentials);
        status('saved', '已自动捕获密钥和账号，并加密保存。');
        finish(true);
      } catch {
        run.lastAttempt = '';
        status('error', '已捕获的凭证未能保存，请检查本机加密和文件写入权限后重试。');
      } finally { run.checking = false; if (run.pending && !run.stopped) { run.pending = false; void capture(); } }
    }
    function changed(_event, _cookie, _cause, removed) { if (!removed) void capture(); }
    ses.cookies.on('changed', changed);
    window.on('closed', () => finish());
    const wc = window.webContents;
    // Catch short-lived HTTP redirects before the page replaces its callback URL.
    const filter = { urls:['https://partner.wmpvp.com/*', 'https://passport.pwesports.cn/*'] };
    ses.webRequest?.onBeforeRequest(filter, (details, done) => { done({}); if (details.resourceType === 'mainFrame') void capture(details.url); });
    ses.webRequest?.onHeadersReceived(filter, (details, done) => {
      done({});
      if (details.resourceType !== 'mainFrame') return;
      for (const [key, values] of Object.entries(details.responseHeaders || {})) {
        if (key.toLowerCase() === 'location') for (const value of values) { try { void capture(new URL(value, details.url).href); } catch {} }
      }
    });
    for (const eventName of ['will-navigate', 'will-redirect']) wc.on(eventName, (event, url) => {
      if (!allowedNavigation(url)) { event.preventDefault(); status('error', '已阻止非官方登录页面，请关闭窗口后重试。'); }
      else void capture(url);
    });
    wc.on('did-navigate', (_event, url) => void capture(url));
    wc.on('did-navigate-in-page', (_event, url, isMainFrame) => { if (isMainFrame) void capture(url); });
    wc.on('did-finish-load', async () => {
      const url = wc.getURL();
      try {
        if (['https://store.steampowered.com', 'https://steamcommunity.com'].includes(new URL(url).origin)) {
          const id = await wc.executeJavaScript('typeof g_steamID === "string" ? g_steamID : ""');
          if (!run.stopped && id) run.steamId = validateSteamId(id);
        }
      } catch {}
      void capture(url);
    });
    wc.on('did-fail-load', (_e, code, _description, _url, isMainFrame) => {
      if (isMainFrame && code !== -3) status('error', '官方登录页面加载失败，请检查网络后重新登录。');
    });
    wc.setWindowOpenHandler(({ url }) => {
      if (allowedNavigation(url)) void wc.loadURL(url).catch(() => {});
      return { action:'deny' };
    });
    ses.on('will-download', event => event.preventDefault());
    run.timer = setTimeout(() => { status('timeout', run.tokenCaptured ? '已收到密钥，但账号识别或保存尚未完成，登录等待超时。请重新登录。' : '尚未收到完美平台密钥，登录等待超时。请重新登录。'); finish(true); }, 10 * 60 * 1000);
    run.poll = setInterval(() => { if (!run.stopped && !wc.isDestroyed?.()) void capture(wc.getURL()); }, 1500);
    run.poll.unref?.();
    status('waiting', '请在官方窗口登录 Steam 并授权完美平台，完成后自动保存。');
    void window.loadURL(LOGIN_URL).catch(() => status('error', '官方登录页面加载失败，请检查网络后重试。'));
  }
  return { open, close };
}
module.exports = { LOGIN_URL, allowedNavigation, callbackToken, platformToken, identityFromURL, resolveSessionIdentity, credentialsFromCookies, createPwaLogin };
