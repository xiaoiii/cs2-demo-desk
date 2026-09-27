const { _electron: electron } = require('playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..'), out = path.join(root, 'test-results');
const profile = fs.mkdtempSync(path.join(out, 'network-profile-'));
let app, page;
async function launch() {
  const env = { ...process.env, DEMODESK_TEST: '1', DEMODESK_DATA: profile }; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [root], env }); page = await app.firstWindow(); await page.waitForSelector('#rows');
  await page.click('[data-page="settings"]');
}
async function rpc(action, data) {
  const r = await page.evaluate(({ action, data }) => window.desk.call(action, data), { action, data });
  assert.ok(r.ok, r.error); return r.value;
}
(async () => {
  try {
    await launch(); assert.equal(await page.locator('#steamAcceleration').isChecked(), false);
    await page.check('#steamAcceleration');
    await page.waitForFunction(() => !document.querySelector('#steamAcceleration').disabled);
    assert.equal((await rpc('state')).settings.steamNetwork.enabled, true);
    const route = await app.evaluate(async ({ session }) => session.fromPartition('persist:demo-sources').resolveProxy('https://steamcommunity.com/'));
    assert.match(route, /^PROXY 127\.0\.0\.1:\d+$/);
    const other = await app.evaluate(async ({ session }) => session.fromPartition('persist:demo-sources').resolveProxy('https://partner.wmpvp.com/'));
    assert.equal(other, 'DIRECT');
    if (process.env.DEMODESK_LIVE_NETWORK === '1') {
      await page.click('#testSteamNetwork');
      await page.waitForFunction(() => document.querySelector('#steamNetworkResults').children.length === 2, { timeout: 65000 });
      const messages = await page.locator('#steamNetworkResults').innerText();
      fs.writeFileSync(path.join(out, 'steam-network-live.json'), JSON.stringify({ at: new Date().toISOString(), messages }, null, 2));
      console.log(messages);
    }
    await page.screenshot({ path: path.join(out, 'steam-network-settings.png'), fullPage: true });
    await app.close(); app = null;
    await launch(); assert.equal(await page.locator('#steamAcceleration').isChecked(), true);
    await page.uncheck('#steamAcceleration');
    await page.waitForFunction(() => !document.querySelector('#steamAcceleration').disabled);
    assert.equal((await rpc('state')).settings.steamNetwork.enabled, false);
    const normal = await app.evaluate(async ({ session }) => {
      const actual = await session.fromPartition('persist:demo-sources').resolveProxy('https://steamcommunity.com/');
      const expected = await session.fromPartition('network-baseline').resolveProxy('https://steamcommunity.com/');
      return { actual, expected };
    });
    assert.equal(normal.actual, normal.expected);
    console.log('Steam acceleration desktop passed: switch, scoped routing, persisted restart, disable restores system mode.');
  } finally { if (app) await app.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
