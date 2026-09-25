const {_electron:electron}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {once}=require('node:events');
const root=path.resolve(__dirname,'..'),out=path.join(root,'test-results');fs.mkdirSync(out,{recursive:true});
const profile=fs.mkdtempSync(path.join(out,'startup-'));let downloads=0,app,page;
const server=http.createServer((req,res)=>{
 const u=new URL(req.url,'http://localhost');
 if(u.pathname==='/history'){
  res.setHeader('Content-Type','text/html');
  const rows=u.searchParams.get('mode')==='premier'?['new','done'].map(id=>`<tr><td class="val_left"><table class="csgo_scoreboard_inner_left"><tr><td>de_mirage</td></tr><tr><td>${new Date(Date.now()-86400000).toISOString().replace("T"," ").replace(/\.\d+Z$/," GMT")}</td></tr><tr><td><a href="/${id}.dem">Download GOTV Replay</a></td></tr></table></td><td>13 : 8</td></tr>`).join(''):'';
  return res.end(`<title>Steam Personal Game Data</title><table class="csgo_scoreboard_root">${rows}</table><p>No matches</p>`);
 }
 if(u.pathname.endsWith('.dem')){downloads++;const payload=Buffer.from('PBDEMS2\0fixture');res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':payload.length,'Content-Disposition':'attachment; filename="match.dem"'});return res.end(payload);}
 res.writeHead(404);res.end();
});
async function launch(base){const env={...process.env,DEMODESK_TEST:'1',DEMODESK_DATA:profile,DEMODESK_TEST_AUTOSYNC:'1',DEMODESK_SOURCE_BASE:base};delete env.ELECTRON_RUN_AS_NODE;app=await electron.launch({args:[root],env});page=await app.firstWindow();await page.waitForSelector('#rows');}
async function rpc(action,data){const r=await page.evaluate(({action,data})=>window.desk.call(action,data),{action,data});assert.ok(r.ok,r.error);return r.value;}
(async()=>{
 try{
  server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
  const settings={autoSync:false,autoDownload:true,autoDownloadSources:['personal'],autoQuit:false,historyDays:7};
  fs.writeFileSync(path.join(profile,'library.json'),JSON.stringify({settings,items:[{id:'done',url:base+'/done.dem',category:'personal',status:'completed',matchAt:Date.now()-86400000}]}));
  await launch(base);
  let state;
  for(let i=0;i<150;i++){state=await rpc('state');if(state.automation?.phase==='complete')break;await new Promise(r=>setTimeout(r,200));}
  assert.equal(state.automation?.phase,'complete');assert.equal(downloads,1);assert.equal(state.items.filter(x=>x.status==='completed').length,2);
  await page.click('[data-page="settings"]');await page.check('#openAtLogin');await page.check('#autoQuit');
  await page.waitForSelector('#autoQuitBanner:not([hidden])',{timeout:5000});await page.click('[data-action="cancel-auto-quit"]');
  await page.waitForSelector('#autoQuitBanner[hidden]',{state:'attached'});assert.equal((await rpc('state')).settings.openAtLogin,true);
  await page.screenshot({path:path.join(out,'startup-settings.png'),fullPage:true});
  await app.close();app=null;await launch(base);
  const closed=app.waitForEvent('close',{timeout:30000});await closed;app=null;
  assert.equal(downloads,1);const saved=JSON.parse(fs.readFileSync(path.join(profile,'library.json'),'utf8'));assert.equal(saved.settings.autoQuit,true);assert.equal(saved.settings.openAtLogin,true);
  console.log('Startup desktop passed: sync then automatic download, no completed duplicates, three settings, cancel exit, restart and automatic exit with no new demos.');
 }finally{if(app)await app.close();server.closeAllConnections();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
