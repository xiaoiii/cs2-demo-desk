const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createDownloadAutomation}=require('../src/download-automation');
const {normalizeOptions,loginOptions,setAutoLaunch}=require('../src/startup-settings');
function fixture(){
 let time=Date.now(),busy=false,exits=0;
 const state={settings:{autoDownload:true,autoQuit:true,autoDownloadSources:['personal'],historyDays:7},sync:{personal:{phase:'idle'}},items:[]};
 const queued=[];
 const a=createDownloadAutomation({state,now:()=>time,isBusy:()=>busy,queue:ids=>{queued.push(...ids);ids.forEach(id=>state.items.find(x=>x.id===id).status='queued');},quit:()=>exits++,onChange:()=>{}});
 const add=(id,status='ready',extra={})=>state.items.push({id,status,category:'personal',source:'steam',url:'https://example.test/'+id,matchAt:time-1000,...extra});
 return {state,a,queued,add,advance:n=>time+=n,busy:v=>busy=v,exits:()=>exits};
}
test('Startup waits for sync, selects only recent chosen sources, skips completed/cancelled/unknown, retries at most once',()=>{
 const f=fixture();f.add('new');f.add('done','completed');f.add('cancel','cancelled');f.add('old','ready',{matchAt:1});f.add('unknown','ready',{matchAt:null});f.add('other','ready',{category:'tournament'});f.add('retry','failed');
 f.a.begin(['personal']);f.a.tick();assert.deepEqual(f.queued,[]);
 f.a.settled();f.a.tick();assert.deepEqual(f.queued,['new','retry']);
 f.state.items.find(x=>x.id==='new').status='completed';f.state.items.find(x=>x.id==='retry').status='failed';
 f.a.tick();f.advance(20000);f.a.tick();assert.equal(f.exits(),0);assert.equal(f.state.automation.phase,'attention');assert.deepEqual(f.queued,['new','retry']);
});
test('Exit waits for paused downloads, extraction/sync and ten-second countdown; cancellation prevents exit',()=>{
 const f=fixture();f.add('one');f.a.begin(['personal']);f.a.settled();f.a.tick();
 f.state.items[0].status='paused';f.advance(20000);f.a.tick();assert.equal(f.exits(),0);
 f.state.items[0].status='completed';f.busy(true);f.a.tick();assert.equal(f.state.automation.quitAt,0);
 f.busy(false);f.a.tick();assert.equal(f.state.automation.phase,'countdown');
 f.advance(9000);f.a.tick();assert.equal(f.exits(),0);f.a.cancel();f.advance(2000);f.a.tick();assert.equal(f.exits(),0);
});
test('Empty successful startup exits, source/login/partial failures stay open; disabled auto-download does not queue',()=>{
 for(const phase of ['idle','partial','error','login_required','verification_required']){
  const f=fixture();f.state.sync.personal.phase=phase;f.a.begin(['personal']);f.a.settled();f.a.tick();f.advance(11000);f.a.tick();assert.equal(f.exits(),phase==='idle'?1:0);
 }
 const f=fixture();f.add('one');f.state.settings.autoDownload=false;f.a.begin(['personal']);f.a.settled();f.a.tick();assert.deepEqual(f.queued,[]);
});
test('Manual download completion also triggers exit, but cancelled tasks do not',()=>{
 const f=fixture();f.state.settings.autoDownload=false;f.add('one','queued');f.a.track(['one']);f.a.tick();f.state.items[0].status='cancelled';f.a.tick();assert.equal(f.state.automation.phase,'attention');
 f.state.items[0].status='queued';f.a.track(['one']);f.state.items[0].status='completed';f.a.tick();f.advance(10001);f.a.tick();assert.equal(f.exits(),1);
});
test('Portable autostart registers the durable EXE, verifies OS state and removes by stable name',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'demo-login-')),exe=path.join(dir,'Demo Desk.exe');fs.writeFileSync(exe,'fixture');
 try{
  let registered;const app={isPackaged:true,getPath:()=>path.join(dir,'temporary.exe'),setLoginItemSettings:v=>{registered=v;},getLoginItemSettings:()=>({openAtLogin:registered.openAtLogin,executableWillLaunchAtLogin:registered.openAtLogin})};
  const env={PORTABLE_EXECUTABLE_FILE:exe};assert.equal(loginOptions(app,env).path,exe);assert.equal(setAutoLaunch(app,true,env),true);assert.equal(registered.name,'CS2 Demo Desk');assert.deepEqual(registered.args,[]);
  assert.equal(setAutoLaunch(app,false,env),false);assert.equal(registered.openAtLogin,false);
  assert.throws(()=>loginOptions({...app,isPackaged:false},{}),/EXE/);
  app.getLoginItemSettings=()=>({openAtLogin:true,executableWillLaunchAtLogin:false});assert.throws(()=>setAutoLaunch(app,true,env),/Windows/);
  assert.deepEqual(normalizeOptions(),{autoDownload:false,autoQuit:false,autoDownloadSources:['personal','perfect']});
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
