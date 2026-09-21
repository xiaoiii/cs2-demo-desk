// Optional smoke check: reach the real official login page without entering credentials.
const { _electron:electron } = require('playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname,'..');
const profile = fs.mkdtempSync(path.join(root,'test-results','pwa-live-'));
(async () => {
  const env = {...process.env,DEMODESK_TEST:'1',DEMODESK_DATA:profile}; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({executablePath:require('electron'),args:[root],env});
  try {
    const page = await app.firstWindow(); await page.waitForSelector('#rows');
    await page.locator('[data-page="perfect"]').click();
    const opened = app.waitForEvent('window');
    await page.locator('[data-action="pwa-login"]').click();
    const login = await opened;
    await login.waitForURL(url=>url.hostname==='store.steampowered.com',{timeout:45000});
    await login.waitForLoadState('domcontentloaded');
    await login.locator('input[type="password"]').waitFor({timeout:45000});
    assert.equal((await page.evaluate(()=>window.desk.call('state'))).value.auth.pwaSaved,false);
    await login.screenshot({path:path.join(root,'test-results','pwa-official-steam-login.png')});
    console.log('Live official Perfect World login redirects to the Steam login page in the isolated Electron window. No account credentials entered.');
  } finally { await app.close(); }
})().catch(error=>{console.error(error.message);process.exitCode=1;});
