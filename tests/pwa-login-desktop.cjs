const { _electron:electron } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = path.join(root,'test-results');
fs.mkdirSync(output,{recursive:true});
const profile = fs.mkdtempSync(path.join(output,'pwa-login-profile-'));
const token = 'mock-platform-token-123456789';
const regression = process.env.DEMODESK_PWA_CASE === 'redirect';
let app;
async function launch() {
  const env = {...process.env, DEMODESK_TEST:'1', DEMODESK_DATA:profile}; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ executablePath:process.env.DEMODESK_PACKAGED === '1' ? path.join(root,'release','win-unpacked','CS2 Demo Desk.exe') : require('electron'), args:process.env.DEMODESK_PACKAGED === '1' ? [] : [root], env });
  const page = await app.firstWindow(); await page.waitForSelector('#rows'); return page;
}
(async () => {
  let page = await launch();
  // Fake only the remote service in this test process; exercise real Electron windows/cookies/DPAPI.
  await app.evaluate(({session}, {token,regression}) => {
    const original = session.fromPartition.bind(session);
    session.fromPartition = (partition, options) => {
      const ses = original(partition, options);
      if (partition.startsWith('pwa-login-')) {
        const originalFetch = ses.fetch.bind(ses);
        // Electron protocol.handle synthetic Responses omit the URL; supply the
        // known fixture endpoint, keeping production origin checks unchanged.
        ses.fetch = async (...args) => {
          const r = await originalFetch(...args);
          if (args[0] === 'https://steamcommunity.com/my/?xml=1' && !r.url) Object.defineProperty(r,'url',{value:args[0]});
          return r;
        };
      }
      if (partition.startsWith('pwa-login-')) ses.protocol.handle('https', async request => {
        if (new URL(request.url).hostname === 'passport.pwesports.cn') {
          if (!regression) await ses.cookies.set({url:'https://store.steampowered.com',name:'steamLoginSecure',value:'76561198159976336%7C%7Cmock-steam-session',secure:true,httpOnly:true});
          const callback = regression ? `https://partner.wmpvp.com/?state=appAdmin#/login?token=${token}` : `https://partner.wmpvp.com/#/login?state=appAdmin&token=${token}`;
          return new Response(`<a href="${callback}">完成模拟授权</a>`,{headers:{'content-type':'text/html;charset=utf-8'}});
        }
        if (new URL(request.url).hostname === 'steamcommunity.com') return new Response('<profile><steamID64>76561198159976336</steamID64></profile>',{headers:{'content-type':'text/xml'}});
        return new Response('<script>history.replaceState({},"","/#/login")</script><p>授权完成</p>',{headers:{'content-type':'text/html;charset=utf-8'}});
      });
      return ses;
    };
    global.fetch = async value => {
      const url = new URL(value);
      if (url.hostname !== 'pwaweblogin.wmpvp.com' || url.searchParams.get('access_token') !== token || url.searchParams.get('uid') !== '76561198159976336') throw new Error('Unexpected mock API request');
      if (regression) return new Response('Temporary service failure',{status:503});
      return new Response(JSON.stringify({data:[]}),{headers:{'content-type':'application/json'}});
    };
  },{token,regression});
  await page.locator('[data-page="perfect"]').click();
  assert.equal(await page.locator('#pwaToken').isVisible(),false);
  await page.locator('[data-action="pwa-login"]').click();
  let login;
  for (let i=0;i<50;i++) { login = app.windows().find(w=>w!==page); if(login)break;await page.waitForTimeout(100); }
  assert.ok(login,'Login window opens');
  await login.getByText('完成模拟授权').waitFor();
  assert.deepEqual(await login.evaluate(()=>({node:typeof require,bridge:typeof window.desk})),{node:'undefined',bridge:'undefined'});
  await login.getByText('完成模拟授权').click();
  for (let i=0;i<30;i++) {
    const current = await page.evaluate(()=>window.desk.call('state'));
    if (current.value.auth.pwaSaved && current.value.sync.perfect.phase === (regression ? 'error' : 'idle')) break;
    await page.waitForTimeout(250);
  }
  const state = await page.evaluate(()=>window.desk.call('state'));
  assert.equal(state.value.auth.pwaSaved,true,'Credentials must be saved after the callback');
  assert.equal(state.value.sync.perfect.phase,regression ? 'error' : 'idle');
  assert.equal(JSON.stringify(state).includes(token),false);
  const diagnostic = JSON.parse(fs.readFileSync(path.join(profile,'pwa-login-status.json'),'utf8'));
  assert.equal(diagnostic.saved,true); assert.equal(diagnostic.tokenCaptured,true); assert.equal(diagnostic.identityCaptured,true);
  assert.equal(JSON.stringify(diagnostic).includes(token),false);
  assert.equal(JSON.stringify(diagnostic).includes('76561198159976336'),false);
  const encrypted = fs.readFileSync(path.join(profile,'pwa-credentials.bin')); assert.equal(encrypted.includes(Buffer.from(token)),false);
  await page.screenshot({path:path.join(output,'pwa-auto-login.png'),fullPage:true});
  await page.waitForTimeout(300);
  assert.equal(fs.readFileSync(path.join(profile,'library.json'),'utf8').includes(token),false);
  await app.close(); app = null;
  page = await launch();
  assert.equal((await page.evaluate(()=>window.desk.call('state'))).value.auth.pwaSaved,true);
  await page.locator('[data-page="perfect"]').click();
  await page.locator('[data-action="pwa-clear"]').click();
  await page.waitForFunction(async()=>!(await window.desk.call('state')).value.auth.pwaSaved);
  assert.equal(fs.existsSync(path.join(profile,'pwa-credentials.bin')),false);
  console.log(`PWA login desktop passed (${regression ? 'mixed callback, missing cookies, same-session identity fallback, API failure preserves credentials' : 'normal callback'}): encrypted save, refresh, restart, clear, no plaintext secret.`);
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{if(app)await app.close();});
