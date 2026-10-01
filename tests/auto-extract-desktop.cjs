const { _electron: electron } = require('playwright');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process'),{once}=require('node:events');
const root=path.resolve(__dirname,'..'),out=path.join(root,'test-results');fs.mkdirSync(out,{recursive:true});
const fixture=fs.mkdtempSync(path.join(out,'auto-extract-'));
const payload=Buffer.concat([Buffer.from('PBDEMS2\0'),Buffer.alloc(256*1024,42)]);
fs.writeFileSync(path.join(fixture,'match.dem'),payload);
execFileSync(path.join(root,'vendor/7zip/7z.exe'),['a','-tbzip2',path.join(fixture,'match.dem.bz2'),path.join(fixture,'match.dem')],{windowsHide:true,stdio:'pipe'});
const compressed=fs.readFileSync(path.join(fixture,'match.dem.bz2'));
const server=http.createServer((req,res)=>{const body=req.url==='/bad.dem.bz2'?compressed.subarray(0,30):req.url==='/direct.dem'?payload:compressed;res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':body.length,'Content-Disposition':`attachment; filename="${req.url.slice(1)}"`});res.end(body);});
let app,page,profile;
async function launch(autoQuit=false){
 profile=fs.mkdtempSync(path.join(out,'extract-profile-'));fs.writeFileSync(path.join(profile,'library.json'),JSON.stringify({items:[],settings:{autoSync:false,autoQuit}}));
 const env={...process.env,DEMODESK_TEST:'1',DEMODESK_DATA:profile};delete env.ELECTRON_RUN_AS_NODE;
 app=await electron.launch({...(process.env.DEMODESK_PACKAGED==='1'?{executablePath:path.join(root,'release/win-unpacked/CS2 Demo Desk.exe'),args:[]}:{args:[root]}),env});page=await app.firstWindow();await page.waitForSelector('#rows');
}
async function rpc(action,data){const r=await page.evaluate(({action,data})=>window.desk.call(action,data),{action,data});assert.ok(r.ok,r.error);return r.value;}
async function waitFor(fn){for(let i=0;i<200;i++){const s=await rpc('state');if(fn(s))return s;await new Promise(r=>setTimeout(r,100));}throw new Error('Auto extraction did not settle');}
async function download(name){await rpc('import',{text:`http://127.0.0.1:${server.address().port}/${name}`,category:'personal'});const r=(await rpc('state')).items.find(x=>x.url.endsWith('/'+name));await rpc('queue',{ids:[r.id]});return r.id;}
(async()=>{
 try{
  // Windows may allocate 4045, which Chromium blocks as an unsafe HTTP port.
  do { server.listen(0,'127.0.0.1');await once(server,'listening');if(![2049,3659,4045,5060,5061,6000,6566,6665,6666,6667,6668,6669,6697,10080].includes(server.address().port))break;await new Promise(r=>server.close(r)); } while(true);
  await launch();
  const id=await download('match.dem.bz2');let s=await waitFor(s=>s.items.find(x=>x.id===id)?.status==='completed');
  // A click during automatic extraction joins it; a later click reuses the valid result.
  await Promise.all([rpc('extract',{id}),rpc('extract',{id})]);
  s=await waitFor(s=>s.items.find(x=>x.id===id)?.files.length===1&&!s.items.find(x=>x.id===id).extracting);
  const r=s.items.find(x=>x.id===id);assert.deepEqual(fs.readFileSync(r.files[0]),payload);assert.deepEqual(fs.readFileSync(r.path),compressed);
  assert.equal(path.dirname(r.files[0]),s.settings.replayDirectory);assert.equal(fs.readdirSync(s.settings.replayDirectory).length,1);
  const direct=await download('direct.dem');s=await waitFor(s=>s.items.find(x=>x.id===direct)?.files.length===1&&!s.items.find(x=>x.id===direct).extracting);const d=s.items.find(x=>x.id===direct);assert.equal(path.dirname(d.files[0]),s.settings.replayDirectory);assert.deepEqual(fs.readFileSync(d.files[0]),payload);
  // A missing destination opens one shared folder picker for simultaneous jobs.
  fs.renameSync(s.settings.replayDirectory,s.settings.replayDirectory+'-old');
  await app.evaluate(({dialog})=>{global.folderCalls=0;dialog.showOpenDialog=async()=>{global.folderCalls++;await new Promise(r=>setTimeout(r,500));return {canceled:true,filePaths:[]};};});
  const cancel1=await download('cancel1.dem.bz2'),cancel2=await download('cancel2.dem.bz2');
  s=await waitFor(s=>[cancel1,cancel2].every(id=>s.items.find(x=>x.id===id)?.error));
  assert.equal(await app.evaluate(()=>global.folderCalls),1);
  assert.ok(s.items.find(x=>x.id===cancel1).error.includes('尚未选择'));
  const selected=path.join(profile,'自选录像');fs.mkdirSync(selected);
  fs.writeFileSync(path.join(selected,'cancel1.dem'),Buffer.from('do not overwrite'));
  await app.evaluate(({dialog},selected)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[selected]});},selected);
  await rpc('replay-folder');await rpc('extract',{id:cancel1});await rpc('extract',{id:cancel2});
  s=await rpc('state');assert.equal(s.settings.replayDirectory,selected);
  assert.equal(fs.readFileSync(path.join(selected,'cancel1.dem'),'utf8'),'do not overwrite');
  for(const id of [cancel1,cancel2]) { const file=s.items.find(x=>x.id===id).files[0];assert.equal(path.dirname(file),selected);assert.deepEqual(fs.readFileSync(file),payload);assert.equal(path.extname(file),'.dem'); }
  await page.click('[data-page="settings"]');await page.waitForSelector('[data-action="replay-folder"]');await page.locator('[data-action="replay-folder"]').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(out,'replay-output-settings.png')});
  await page.click('[data-page="library"]');await page.screenshot({path:path.join(out,'auto-extract-library.png')});
  const bad=await download('bad.dem.bz2');s=await waitFor(s=>Boolean(s.items.find(x=>x.id===bad)?.error));const b=s.items.find(x=>x.id===bad);assert.equal(b.status,'completed');assert.deepEqual(b.files,[]);assert.ok(fs.existsSync(b.path));assert.equal(b.extracting,false);
  await rpc('automation-settings',{autoQuit:true});await waitFor(s=>s.automation?.phase==='attention');
  const retry=await page.evaluate(id=>window.desk.call('extract',{id}),bad);assert.equal(retry.ok,false);assert.deepEqual((await rpc('state')).items.find(x=>x.id===bad).files,[]);
  await app.close();app=null;
  assert.equal(JSON.parse(fs.readFileSync(path.join(profile,'library.json'))).settings.replayDirectory,selected);
  await launch(true);const success=await download('finish.dem.bz2');const closed=app.waitForEvent('close',{timeout:60000});try { await closed; } catch (error) { const state=await rpc('state');console.error('Auto-exit state:',JSON.stringify({automation:state.automation,items:state.items.map(x=>({status:x.status,error:x.error,extracting:x.extracting})),settings:{autoQuit:state.settings.autoQuit}},null,2));throw error; }app=null;
  const saved=JSON.parse(fs.readFileSync(path.join(profile,'library.json'))).items.find(x=>x.id===success);assert.equal(saved.extracting,false);assert.deepEqual(fs.readFileSync(saved.files[0]),payload);assert.ok(fs.existsSync(saved.path));
  console.log('Auto extraction passed: download → DEM, archive retained, concurrent/idempotent extraction, direct DEM, corrupt BZ2/retry, error prevents auto-exit, successful extraction precedes real exit.');
 }finally{if(app)await app.close();server.closeAllConnections();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
