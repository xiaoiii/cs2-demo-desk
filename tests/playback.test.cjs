const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {EventEmitter}=require('node:events');
const {preparePlayback,cleanupPlayback,stageFiles,playbackArgs,launchPlayback,findInLibraries}=require('../src/playback');
function fixture(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'demo-play-'));
 const game=path.join(dir,'game/bin/win64/cs2.exe'),steam=path.join(dir,'steam.exe'),source=path.join(dir,'比赛 demo;test.dem');
 fs.mkdirSync(path.dirname(game),{recursive:true});fs.mkdirSync(path.join(dir,'game/csgo/cfg'),{recursive:true});
 fs.writeFileSync(game,'fixture');fs.writeFileSync(steam,'fixture');fs.writeFileSync(source,Buffer.from('PBDEMS2\0test'));
 return {dir,game,steam,source};
}
test('Copies replay to safe game-relative name and creates automatic config without changing user config',async()=>{
 const f=fixture();try{
  const autoexec=path.join(f.dir,'game/csgo/cfg/autoexec.cfg');fs.writeFileSync(autoexec,'user settings');
  const stage=await preparePlayback(f.game,f.source),files=stageFiles(stage.gameExe,stage.id);
  assert.deepEqual(fs.readFileSync(files.demo),fs.readFileSync(f.source));
  assert.ok(fs.readFileSync(files.cfg,'ascii').includes(`playdemo "${files.name}.dem"\ndemoui true`));
  assert.equal(fs.readFileSync(files.cfg,'ascii').includes(f.source),false);
  let received;
  await launchPlayback(f.steam,stage,(exe,args,opts)=>{received={exe,args,opts};const c=new EventEmitter();c.unref=()=>{};process.nextTick(()=>c.emit('spawn'));return c;});
  assert.equal(received.exe,f.steam);assert.deepEqual(received.args,['-applaunch','730','-condebug','-consolelog',`${files.name}.log`,'+exec',files.name]);
  assert.equal(received.opts.shell,false);assert.equal(received.args.includes('-console'),false);
  await cleanupPlayback(stage,f.game);
  assert.equal(fs.existsSync(files.demo),false);assert.equal(fs.existsSync(files.cfg),false);
  assert.equal(fs.existsSync(f.source),true);assert.equal(fs.readFileSync(autoexec,'utf8'),'user settings');
 }finally{fs.rmSync(f.dir,{recursive:true,force:true});}
});
test('Rejects invalid demos, direct CS2 launch and forged cleanup descriptors',async()=>{
 const f=fixture();try{
  const stage=await preparePlayback(f.game,f.source);
  await assert.rejects(launchPlayback(f.game,stage),/steam.exe/);
  await assert.rejects(launchPlayback(f.steam,stage,()=>{const c=new EventEmitter();process.nextTick(()=>c.emit('error',new Error('failed')));return c;}),/无法启动 Steam/);
  await cleanupPlayback({gameExe:f.game,id:'../../source'},f.game);assert.equal(fs.existsSync(f.source),true);
  assert.throws(()=>playbackArgs({gameExe:f.game,id:'../evil'}),/无效/);
  fs.writeFileSync(f.source,'html');await assert.rejects(preparePlayback(f.game,f.source),/有效/);
 }finally{fs.rmSync(f.dir,{recursive:true,force:true});}
});
test('Detects CS2 in an additional Steam library',()=>{
 const f=fixture();try{
  const steam=path.join(f.dir,'Steam'),library=path.join(f.dir,'Games');
  const exe=path.join(library,'steamapps/common/Counter-Strike Global Offensive/game/bin/win64/cs2.exe');
  fs.mkdirSync(path.dirname(exe),{recursive:true});fs.writeFileSync(exe,'fixture');fs.mkdirSync(path.join(steam,'steamapps'),{recursive:true});
  fs.writeFileSync(path.join(steam,'steamapps/libraryfolders.vdf'),`"path" "${library.replace(/\\/g,'\\\\')}"`);
  assert.equal(findInLibraries([steam]),exe);
 }finally{fs.rmSync(f.dir,{recursive:true,force:true});}
});
