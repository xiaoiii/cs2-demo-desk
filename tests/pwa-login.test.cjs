const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { allowedNavigation, callbackToken, identityFromURL, resolveSessionIdentity, credentialsFromCookies, createPwaLogin } = require('../src/pwa-login');
const token = 'test-platform-token-123456789';
const steamId = '76561198159976336';
const steamCookie = { domain:'.steampowered.com', name:'steamLoginSecure', value:`${steamId}%7C%7Cprivate-steam-session` };
const platformCookie = { domain:'.wmpvp.com', name:'access_token', value:token };
const callback = `https://partner.wmpvp.com/#/login?state=appAdmin&token=${token}`;
const tick = () => new Promise(resolve => setImmediate(resolve));
function harness(validate = async () => {}) {
  const statuses = [], saved = [], windows = [], sessions = [];
  class Window extends EventEmitter {
    constructor(options) { super(); this.options = options; this.webContents = new EventEmitter(); this.webContents.setWindowOpenHandler = fn => this.popup = fn; this.webContents.getURL = () => this.url; this.webContents.loadURL = url => this.loadURL(url); windows.push(this); }
    async loadURL(url) { this.url = url; }
    show() {} focus() {} isDestroyed() { return Boolean(this.destroyed); }
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  const session = { fromPartition(partition) {
    const ses = new EventEmitter(); ses.partition = partition; ses.rows = [];
    ses.webRequest = { onBeforeRequest:(filter,handler)=>ses.beforeRequest=handler, onHeadersReceived:(filter,handler)=>ses.headersReceived=handler };
    ses.cookies = new EventEmitter(); ses.cookies.get = async () => ses.rows;
    ses.setPermissionRequestHandler = fn => ses.permission = fn;
    ses.setPermissionCheckHandler = () => {};
    ses.clearStorageData = async () => { ses.rows = []; ses.cleared = true; };
    sessions.push(ses); return ses;
  }};
  const login = createPwaLogin({ BrowserWindow:Window, session, validate, onCredentials:c => saved.push(c), onStatus:s => statuses.push(s) });
  return { login, windows, sessions, statuses, saved };
}
test('Only exact HTTPS official login origins and expected callback state are accepted', () => {
  assert.equal(callbackToken(callback), token);
  for (const url of [callback.replace('partner.wmpvp.com','partner.wmpvp.com.evil.test'), callback.replace('https:','http:'), callback.replace('appAdmin','other')]) assert.equal(callbackToken(url),'');
  for (const url of ['file:///c:/secret','https://evil.test','https://partner.wmpvp.com.evil.test','https://user:pass@partner.wmpvp.com','https://partner.wmpvp.com:8443']) assert.equal(allowedNavigation(url),false);
  assert.equal(allowedNavigation('https://store.steampowered.com/login/'),true);
});
test('Credentials use platform token and Steam identity from the same isolated session; reject ambiguous IDs', () => {
  assert.deepEqual(credentialsFromCookies([steamCookie,platformCookie]),{ steamId,token });
  assert.deepEqual(credentialsFromCookies([steamCookie,platformCookie],'earlier-callback-token-123456789'),{ steamId,token });
  assert.equal(credentialsFromCookies([{...steamCookie,domain:'evil.test'},platformCookie]),null);
  assert.equal(credentialsFromCookies([steamCookie,{...platformCookie,domain:'.evil.wmpvp.com'}]),null);
  assert.equal(credentialsFromCookies([steamCookie,{...steamCookie,value:'76561198159976337||other'},platformCookie]),null);
});
test('Callback automatically validates and commits once, then clears temporary session', async () => {
  const h = harness(); h.login.open(); h.login.open(); assert.equal(h.windows.length,1);
  h.sessions[0].rows = [steamCookie];
  h.windows[0].webContents.emit('did-navigate-in-page',{},callback,true);
  await tick();
  assert.deepEqual(h.saved,[{steamId,token}]); assert.equal(h.sessions[0].cleared,true);
  assert.equal(h.windows[0].destroyed,true); assert.equal(h.statuses.at(-1).phase,'saved');
  assert.equal(JSON.stringify(h.statuses).includes(token),false);
  assert.equal(h.windows[0].options.webPreferences.nodeIntegration,false);
  assert.equal(h.windows[0].options.webPreferences.preload,undefined);
  assert.equal(h.sessions[0].partition.startsWith('persist:'),false);
});
test('Platform HttpOnly cookie arrival also triggers automatic capture', async () => {
  const h = harness(); h.login.open(); h.sessions[0].rows = [steamCookie,platformCookie];
  h.sessions[0].cookies.emit('changed',{},platformCookie,'explicit',false); await tick();
  assert.equal(h.saved.length,1);
});
test('Closing or clearing during validation prevents a late credential save', async () => {
  let finish; const h = harness(() => new Promise(resolve => finish = resolve)); h.login.open();
  h.sessions[0].rows = [steamCookie,platformCookie]; h.sessions[0].cookies.emit('changed',{},platformCookie,'explicit',false); await tick();
  h.login.close(); finish(); await tick(); assert.equal(h.saved.length,0); assert.equal(h.sessions[0].cleared,true);
  h.login.open(); assert.notEqual(h.sessions[0].partition,h.sessions[1].partition); h.login.close();
});
test('Validation failures do not save or expose upstream secrets', async () => {
  const h = harness(async () => { throw new Error(token); }); h.login.open(); h.sessions[0].rows = [steamCookie,platformCookie];
  h.sessions[0].cookies.emit('changed',{},platformCookie,'explicit',false); await tick();
  assert.equal(h.saved.length,0); assert.equal(h.statuses.at(-1).phase,'error'); assert.equal(JSON.stringify(h.statuses).includes(token),false); h.login.close();
});
test('Cookie arriving while another scan awaits is not missed', async () => {
  const h = harness(); h.login.open(); let release;
  h.sessions[0].cookies.get = () => new Promise(resolve => release = resolve);
  h.sessions[0].cookies.emit('changed',{},steamCookie,'explicit',false);
  h.sessions[0].cookies.emit('changed',{},platformCookie,'explicit',false);
  h.sessions[0].cookies.get = async () => [steamCookie,platformCookie]; release([steamCookie]); await tick();
  assert.equal(h.saved.length,1);
});

test('Callback handles state in query with token in fragment and observed account IDs', () => {
  assert.equal(callbackToken(`https://partner.wmpvp.com/?state=appAdmin#/login?token=${token}`),token);
  assert.equal(identityFromURL(`https://passport.pwesports.cn/steam/callback?steamid=${steamId}`),steamId);
  assert.equal(identityFromURL(`https://evil.test/?steamid=${steamId}`),'');
  assert.deepEqual(credentialsFromCookies([platformCookie],'',steamId),{steamId,token});
  assert.equal(credentialsFromCookies([steamCookie,platformCookie],'','76561198159976337'),null);
});
test('Missing Steam cookies can be resolved from the same logged-in session own profile', async () => {
  const h = harness(); h.login.open(); h.sessions[0].rows = [platformCookie];
  h.sessions[0].fetch = async url => {
    assert.equal(url,'https://steamcommunity.com/my/?xml=1');
    return {ok:true,url:`https://steamcommunity.com/profiles/${steamId}/?xml=1`,text:async()=>`<profile><steamID64>${steamId}</steamID64></profile>`};
  };
  h.sessions[0].cookies.emit('changed',{},platformCookie,'explicit',false); await tick();
  assert.deepEqual(h.saved,[{steamId,token}]);
});
test('Missing identity is reported as token captured instead of silently waiting', async () => {
  const h = harness(); h.login.open(); h.sessions[0].rows = [platformCookie];
  h.sessions[0].cookies.emit('changed',{},platformCookie,'explicit',false); await tick();
  assert.equal(h.saved.length,0); assert.equal(h.statuses.at(-1).phase,'identity_required');
  assert.equal(h.statuses.at(-1).tokenCaptured,true); h.login.close();
});
test('Own-profile fallback rejects HTML and off-origin responses', async () => {
  assert.equal(await resolveSessionIdentity({fetch:async()=>({ok:true,url:'https://evil.test/',text:async()=>`<steamID64>${steamId}</steamID64>`})}),'');
  assert.equal(await resolveSessionIdentity({fetch:async()=>({ok:true,url:'https://steamcommunity.com/login/',text:async()=>'<p>Sign in</p>'})}),'');
});
test('Short-lived HTTP Location callback is captured before page navigation', async () => {
  const h = harness(); h.login.open(); h.sessions[0].rows = [steamCookie];
  let continued = false;
  h.sessions[0].headersReceived({resourceType:'mainFrame',url:'https://passport.pwesports.cn/steam/callback',responseHeaders:{Location:[callback]}},()=>continued=true);
  await tick(); assert.equal(continued,true); assert.deepEqual(h.saved,[{steamId,token}]);
  assert.equal(h.sessions[0].headersReceived,undefined);
});
