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
  server.listen(0,'127.0.0.1');await once(server,'listening');await launch();
  const id=await download('match.dem.bz2');let s=await waitFor(s=>s.items.find(x=>x.id===id)?.status==='completed');
  // A click during automatic extraction joins it; a later click reuses the valid result.
  await Promise.all([rpc('extract',{id}),rpc('extract',{id})]);
  s=await waitFor(s=>s.items.find(x=>x.id===id)?.files.length===1&&!s.items.find(x=>x.id===id).extracting);
  const r=s.items.find(x=>x.id===id);assert.deepEqual(fs.readFileSync(r.files[0]),payload);assert.deepEqual(fs.readFileSync(r.path),compressed);
  assert.equal(fs.readdirSync(path.join(path.dirname(r.path),'extracted',id)).length,1);
  const direct=await download('direct.dem');s=await waitFor(s=>s.items.find(x=>x.id===direct)?.status==='completed');const d=s.items.find(x=>x.id===direct);assert.deepEqual(d.files,[d.path]);
  await page.click('[data-page="library"]');await page.screenshot({path:path.join(out,'auto-extract-library.png')});
  const bad=await download('bad.dem.bz2');s=await waitFor(s=>Boolean(s.items.find(x=>x.id===bad)?.error));const b=s.items.find(x=>x.id===bad);assert.equal(b.status,'completed');assert.deepEqual(b.files,[]);assert.ok(fs.existsSync(b.path));assert.equal(b.extracting,false);
  await rpc('automation-settings',{autoQuit:true});await waitFor(s=>s.automation?.phase==='attention');
  const retry=await page.evaluate(id=>window.desk.call('extract',{id}),bad);assert.equal(retry.ok,false);assert.deepEqual((await rpc('state')).items.find(x=>x.id===bad).files,[]);
  await app.close();app=null;
  await launch(true);const success=await download('finish.dem.bz2');const closed=app.waitForEvent('close',{timeout:30000});await closed;app=null;
  const saved=JSON.parse(fs.readFileSync(path.join(profile,'library.json'))).items.find(x=>x.id===success);assert.equal(saved.extracting,false);assert.deepEqual(fs.readFileSync(saved.files[0]),payload);assert.ok(fs.existsSync(saved.path));
  console.log('Auto extraction passed: download → DEM, archive retained, concurrent/idempotent extraction, direct DEM, corrupt BZ2/retry, error prevents auto-exit, successful extraction precedes real exit.');
 }finally{if(app)await app.close();server.closeAllConnections();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
