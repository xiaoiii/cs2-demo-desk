const { _electron: electron } = require('playwright');
const path = require('node:path'), assert = require('node:assert/strict');
(async () => {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [path.join(__dirname, 'network-harness.cjs')], env });
  app.process().stderr.on('data', c => process.stderr.write(c));
  try {
    const page = await app.firstWindow(); await page.waitForURL('https://steamcommunity.com/ready');
    assert.equal(await page.locator('body').innerText(), 'cookie:preserved');
    assert.equal(await page.evaluate(() => document.cookie), '');
    const reply = await page.evaluate(async () => (await fetch('/post', { method: 'POST', body: 'synthetic-login' })).json());
    assert.deepEqual(reply, { body: 'synthetic-login', cookie: 'fixture=kept', origin: 'https://steamcommunity.com', host: 'steamcommunity.com' });
    assert.equal(await page.evaluate(() => location.origin), 'https://steamcommunity.com');
    console.log('Electron bridge verified: redirect, Secure HttpOnly cookie, original HTTPS origin and authenticated POST.');
  } finally { await app.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
