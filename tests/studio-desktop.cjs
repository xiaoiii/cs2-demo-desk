const { _electron:electron }=require('playwright');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),profile=fs.mkdtempSync(path.join(os.tmpdir(),'desk-studio-ui-')),source=process.env.DEMODESK_REAL_DEMO;
const output=path.join(root,'test-results');fs.mkdirSync(output,{recursive:true});
const damaged=path.join(profile,'damaged.dem');fs.writeFileSync(damaged,'PBDEMS2\0invalid');
const records=[...(source?[{id:'studio-real',url:'https://example.invalid/demo',title:'独立复盘测试',status:'completed',category:'personal',path:source,files:[source],kind:'dem',created:Date.now()}]:[]),{id:'damaged',url:'https://example.invalid/damaged',title:'损坏录像测试',status:'completed',category:'personal',path:damaged,files:[damaged],kind:'dem',created:0}];
fs.writeFileSync(path.join(profile,'library.json'),JSON.stringify({items:records,settings:{autoSync:false,replayDirectory:source?path.dirname(source):profile},sync:{}}));
let app;
(async()=>{const env={...process.env,DEMODESK_TEST:'1',DEMODESK_DATA:profile};delete env.ELECTRON_RUN_AS_NODE;
  app=await electron.launch({...(process.env.DEMODESK_PACKAGED==='1'?{executablePath:process.env.DEMODESK_INSTALLED_EXE||path.join(root,'release','win-unpacked','CS2 Demo Desk.exe'),args:[]}:{args:[root]}),env,timeout:60000});const page=await app.firstWindow();const errors=[];page.on('pageerror',error=>errors.push(error.message));await page.locator('#rows').waitFor();
  const rejected=await page.evaluate(()=>window.desk.call('review-open-record',{id:'damaged'}));assert.equal(rejected.ok,false);assert.equal(page.isClosed(),false);
  if(source){await page.locator('[data-page="library"]').click();await page.locator('[data-action="review-demo"]').first().click();await page.locator('[data-studio="analyze"]').first().waitFor({timeout:90000});await page.locator('[data-studio="analyze"]').first().click();await page.locator('.studio-clip').first().waitFor({timeout:90000});assert.ok(await page.locator('.studio-clip').count()>0);await page.screenshot({path:path.join(output,'studio-analysis.png'),fullPage:true});await page.locator('[data-studio="radar-clip"]').first().click();await page.locator('#radarCaption').filter({hasText:'Tick'}).waitFor({timeout:90000});assert.ok(await page.locator('#radarFrame').getAttribute('max')>0);await page.screenshot({path:path.join(output,'studio-radar.png'),fullPage:true});}
  else{await page.locator('[data-page="studio"]').click();await page.locator('.studio-status').filter({hasText:'已完成'}).waitFor();}
  for(const tab of ['record','edit','settings','review']){await page.locator(`[data-studio-tab="${tab}"]`).click();assert.ok(await page.locator('#studioRoot').isVisible());}
  await page.locator('[data-studio-tab="settings"]').click();await page.locator('[name="obsAddress"]').fill('ws://127.0.0.1:4455');await page.locator('#studioSettings button[type="submit"]').click();await page.locator('.studio-status').filter({hasText:'已完成'}).waitFor();
  const check=await page.evaluate(()=>window.desk.call('studio-state'));assert.equal(check.ok,true,check.error);assert.equal(check.value.settings.obsAddress,'ws://127.0.0.1:4455/');assert.equal(check.value.secrets.aiKeySaved,false);assert.deepEqual(errors,[]);
  console.log('PASS own studio tabs, encrypted-settings status, native analysis'+(source?', real DEM and coordinate replay':''));
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{await app?.close();fs.rmSync(profile,{recursive:true,force:true,maxRetries:10,retryDelay:200});});
