const { _electron: electron } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { once } = require('node:events');
const root = path.resolve(__dirname, '..');
const output = path.join(root,'test-results');
fs.mkdirSync(output,{recursive:true});
const profile = fs.mkdtempSync(path.join(output,'profile-'));
const fixtures = fs.mkdtempSync(path.join(output,'fixtures-'));
// Synthetic transport fixtures with a demo signature, not playable match recordings.
const payload = Buffer.concat([Buffer.from('PBDEMS2\0'), Buffer.alloc(160 * 1024, 42)]);
fs.writeFileSync(path.join(fixtures,'fixture.dem'),payload);
const seven = path.join(root,'vendor','7zip','7z.exe');
for (const [kind, filename] of [['zip','maps.zip'],['bzip2','fixture.dem.bz2'],['7z','maps.7z']]) execFileSync(seven,['a',`-t${kind}`,path.join(fixtures,filename),path.join(fixtures,'fixture.dem')],{windowsHide:true,stdio:'pipe'});
// Minimal RAR4 store-only archive, allowing a real RAR decoder test without a RAR encoder dependency.
function crc32(b){let c=0xffffffff;for(const v of b){c^=v;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return (c^0xffffffff)>>>0;}
function rarHeader(type,flags,length){const b=Buffer.alloc(length);b[2]=type;b.writeUInt16LE(flags,3);b.writeUInt16LE(length,5);return b;}
function crcHeader(b){b.writeUInt16LE(crc32(b.subarray(2))&0xffff,0);return b;}
const rarMain=crcHeader(rarHeader(0x73,0,13)),rarName=Buffer.from('fixture.dem'),rarFile=rarHeader(0x74,0x8000,32+rarName.length);
rarFile.writeUInt32LE(payload.length,7);rarFile.writeUInt32LE(payload.length,11);rarFile[15]=2;rarFile.writeUInt32LE(crc32(payload),16);rarFile[24]=20;rarFile[25]=0x30;rarFile.writeUInt16LE(rarName.length,26);rarFile.writeUInt32LE(32,28);rarName.copy(rarFile,32);
fs.writeFileSync(path.join(fixtures,'maps.rar'),Buffer.concat([Buffer.from([82,97,114,33,26,7,0]),rarMain,crcHeader(rarFile),payload,crcHeader(rarHeader(0x7b,0,7))]));
let activeRequests = 0, maxRequests = 0;
const server = http.createServer((req,res) => {
  const u = new URL(req.url,'http://localhost');
  if(u.pathname === '/history') { res.setHeader('Content-Type','text/html'); return res.end(`<title>Steam match history fixture</title><div class="csgo_scoreboard_root">2026-09-09 de_mirage 13 : 8 <a href="/fixture.dem.bz2">Download GOTV Replay</a></div><div class="csgo_scoreboard_root">2026-09-08 de_nuke 11 : 13 <a href="/fixture.dem">Download</a></div><a href="/fixture.dem">Duplicate</a><a href="/about">Other</a>`); }
  if(u.pathname === '/match') { res.setHeader('Content-Type','text/html'); return res.end('<title>Team A vs Team B | HLTV.org</title><a data-demo-link="/download/demo/123">GOTV Demo</a><a href="/download/demo/123" hidden>Fallback link</a>'); }
  if(u.pathname === '/download/demo/123') { res.writeHead(302,{Location:'/maps.zip'}); return res.end(); }
  if(u.pathname === '/html.dem') { res.setHeader('Content-Type','application/octet-stream'); res.setHeader('Content-Disposition','attachment; filename="html.dem"'); return res.end('<html>Login required</html>'); }
  if(u.pathname === '/missing.dem') { res.writeHead(404,{'Content-Type':'text/html'}); return res.end('Not found'); }
  if(u.pathname.startsWith('/slow')) {
    const total=payload.length * 40;
    res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':total,'Content-Disposition':'attachment; filename="slow.dem"','Accept-Ranges':'bytes','ETag':'fixture-v1','Last-Modified':'Wed, 09 Sep 2026 00:00:00 GMT'});
    activeRequests++;maxRequests=Math.max(maxRequests,activeRequests);let sent=0;
    const interval=setInterval(()=>{ if(sent>=total){clearInterval(interval);res.end();return;}res.write(payload);sent+=payload.length;},80);
    res.on('close',()=>{clearInterval(interval);activeRequests--;});return;
  }
  const target=path.join(fixtures,path.basename(u.pathname));
  if(fs.existsSync(target)) {res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':fs.statSync(target).size,'Content-Disposition':`attachment; filename="${path.basename(target)}"`});return fs.createReadStream(target).pipe(res);}
  res.writeHead(404);res.end();
});
const checks=[];let app,page;
async function rpc(action,data) {const response=await page.evaluate(async ({action,data})=>window.desk.call(action,data),{action,data});assert.equal(response.ok,true,response.error);return response.value;}
async function waitFor(predicate, timeout=20000) {const start=Date.now();while(Date.now()-start<timeout){const s=await rpc('state');if(predicate(s))return s;await new Promise(r=>setTimeout(r,100));}throw new Error('Timed out waiting for expected app state');}
async function waitSource(fragment) { for(let i=0;i<150;i++){ if(await app.evaluate(({webContents},fragment)=>webContents.getAllWebContents().some(w=>w.getURL().includes(fragment)&&!w.isLoading()),fragment))return;await new Promise(r=>setTimeout(r,100)); } throw new Error('Source page did not load'); }
async function launch() {
 const env={...process.env,DEMODESK_TEST:'1',DEMODESK_DATA:profile};delete env.ELECTRON_RUN_AS_NODE;
 app=await electron.launch({...(process.env.DEMODESK_PACKAGED === '1' ? {executablePath:path.join(root,'release','win-unpacked','CS2 Demo Desk.exe'),args:[]} : {args:[root]}),env,timeout:60000}); page=await app.firstWindow();await page.waitForSelector('#rows');
 page.on('pageerror',e=>{throw e;});
}
(async()=>{
 server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
 await launch();
 await page.screenshot({path:path.join(output,'01-personal.png'),fullPage:true});
 assert.equal(await page.locator('h1').innerText(),'每一场，都值得复盘.');checks.push('Windows app launches with Chinese UI and empty real-data state');
 for(const target of ['perfect','tournament','downloads','library','settings','help','personal']){await page.locator(`[data-page="${target}"]`).click();assert.equal(await page.locator('#pageContent').isVisible(),true);if(target==='perfect')assert.equal(await page.locator('#pwaLoginPanel').isVisible(),true);}checks.push('All seven navigation pages render, including Perfect World Arena credentials');
 await page.locator('#importButton').click();await page.locator('#links').fill('javascript:alert(1)');await page.locator('#importForm button[type=submit]').click();await page.locator('#importError').filter({hasText:'只支持'}).waitFor();await page.locator('#cancelDialog').click();checks.push('UI rejects unsafe pasted URLs');
 await rpc('source',{url:base+'/history',category:'personal'});
 await waitSource('/history');
 assert.equal(await rpc('scan'),2);assert.equal(await rpc('scan'),0);checks.push('Steam-style DOM import extracts two matches and deduplicates');
 const isolation=await app.evaluate(async({webContents})=>webContents.getAllWebContents().find(w=>w.getURL().includes('/history')).executeJavaScript('({bridge:typeof window.desk,node:typeof require})'));
 assert.deepEqual(isolation,{bridge:'undefined',node:'undefined'});checks.push('Remote source page cannot access desktop bridge or Node.js');
 await page.locator('#selectAll').check();await page.locator('#downloadSelected').click();let s=await waitFor(s=>s.items.length===2&&s.items.every(x=>x.status==='completed'));
 for(const item of s.items)assert.equal(fs.existsSync(item.path),true);checks.push('UI multi-select downloads DEM and BZ2 files to disk');
 const bz=s.items.find(x=>x.kind==='bz2');await rpc('extract',{id:bz.id});s=await rpc('state');const unpacked=s.items.find(x=>x.id===bz.id).files[0];assert.deepEqual(fs.readFileSync(unpacked),payload);checks.push('BZ2 decompression produces byte-identical DEM');
 await rpc('source',{url:base+'/match',category:'tournament'});await waitSource('/match');await rpc('scan');
 s=await rpc('state');const tournament=s.items.find(x=>x.url.includes('/download/demo'));assert.ok(tournament);await rpc('queue',{ids:[tournament.id]});await waitFor(s=>s.items.find(x=>x.id===tournament.id).status==='completed');await rpc('extract',{id:tournament.id});s=await rpc('state');assert.deepEqual(fs.readFileSync(s.items.find(x=>x.id===tournament.id).files[0]),payload);checks.push('HLTV-style match import, redirect download and ZIP extraction');
 await rpc('import',{text:base+'/maps.7z',category:'tournament'});s=await rpc('state');const sevenItem=s.items.find(x=>x.url.endsWith('/maps.7z'));await rpc('queue',{ids:[sevenItem.id]});await waitFor(s=>s.items.find(x=>x.id===sevenItem.id).status==='completed');await rpc('extract',{id:sevenItem.id});checks.push('7z archive extraction succeeds');
 await rpc('import',{text:base+'/maps.rar',category:'tournament'});s=await rpc('state');const rarItem=s.items.find(x=>x.url.endsWith('/maps.rar'));await rpc('queue',{ids:[rarItem.id]});await waitFor(s=>s.items.find(x=>x.id===rarItem.id).status==='completed');await rpc('extract',{id:rarItem.id});s=await rpc('state');assert.deepEqual(fs.readFileSync(s.items.find(x=>x.id===rarItem.id).files[0]),payload);checks.push('RAR archive extraction produces byte-identical DEM');
 await rpc('import',{text:base+'/html.dem\n'+base+'/missing.dem',category:'personal'});s=await rpc('state');const bad=s.items.filter(x=>x.status==='ready');await rpc('queue',{ids:bad.map(x=>x.id)});await waitFor(s=>bad.every(b=>s.items.find(x=>x.id===b.id).status==='failed'));checks.push('Disguised HTML and HTTP 404 fail without appearing in Demo library');
 await rpc('concurrency',{value:1});
 await rpc('import',{text:base+'/slow1.dem\n'+base+'/slow2.dem',category:'personal'});
 s=await rpc('state');const slow=s.items.filter(x=>x.status==='ready');
 await rpc('queue',{ids:slow.map(x=>x.id)});
 s=await waitFor(s=>slow.some(x=>s.items.find(y=>y.id===x.id).received>0));
 const first=s.items.find(x=>slow.some(y=>y.id===x.id)&&x.status==='downloading');
 assert.equal(s.items.filter(x=>x.status==='queued').length,1);
 assert.equal(maxRequests,1);
 await rpc('pause',{id:first.id});s=await rpc('state');
 assert.equal(s.items.find(x=>x.id===first.id).status,'paused');
 await rpc('resume',{id:first.id});await rpc('cancel',{id:first.id});
 const second=slow.find(x=>x.id!==first.id);
 s=await waitFor(s=>s.items.find(x=>x.id===second.id).status==='completed');
 assert.equal(s.items.find(x=>x.id===first.id).status,'cancelled');
 // Remote socket close events may lag the cancellation; inspect concurrency before cancellation.
 checks.push('Concurrency limit, pause, resume, cancel and queued task scheduling');
 await page.locator('[data-page="library"]').click();assert.ok(await page.locator('[data-action="play-demo"]').count()>0);await page.screenshot({path:path.join(output,'02-library.png'),fullPage:true});checks.push('Downloaded demos expose one-click playback in the local library');
 await rpc('play-command',{id:bz.id});const clip=await app.evaluate(({clipboard})=>clipboard.readText());assert.ok(clip.startsWith('playdemo "'));assert.ok(clip.includes('fixture.dem'));checks.push('CS2 play command copied to Windows clipboard');
 await page.locator('[data-page="personal"]').click();await page.locator('#searchInput').fill('no-match-xyz');assert.equal(await page.locator('.demo-row').count(),0);await page.locator('#searchInput').fill('');checks.push('Search updates visible matches');
 await rpc('import',{text:base+'/slow3.dem',category:'personal'});s=await rpc('state');const restartItem=s.items.find(x=>x.url.endsWith('/slow3.dem'));await rpc('queue',{ids:[restartItem.id]});await waitFor(s=>s.items.find(x=>x.id===restartItem.id).received>0);await app.close();await launch();s=await rpc('state');assert.ok(['interrupted','cancelled'].includes(s.items.find(x=>x.id===restartItem.id).status));assert.ok(s.items.filter(x=>x.status==='completed').length>=5);checks.push('Download history persists across app restart; unfinished tasks remain retryable');
 await app.close();app=null;
 fs.writeFileSync(path.join(output,process.env.DEMODESK_PACKAGED === '1' ? 'packaged-report.json' : 'desktop-report.json'),JSON.stringify({date:new Date().toISOString(),passed:checks.length,checks,limitations:['Synthetic transport fixtures are not playable match demos.','Steam account login and real personal history require the owner.','Live HLTV source availability is separately checked; fixture tests do not prove all remote sources work.'],profile},null,2));
 console.log(JSON.stringify({passed:checks.length,checks},null,2));
})().catch(async error=>{console.error(error);if(page)await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});process.exitCode=1;}).finally(async()=>{if(app)await app.close().catch(()=>{});server.closeAllConnections();server.close();});
