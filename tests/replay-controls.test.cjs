const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {defaults,normalize,cfg}=require('../src/replay-controls');
const {writeConfig}=require('../src/replay-config');
const {preparePlayback,stageFiles}=require('../src/playback');
test('Rejects duplicate keys and command injection; permits unassigned keys and supported speeds',()=>{
 const v=defaults();v.bindings[1].key='f6';assert.throws(()=>normalize(v),/重复/);
 v.bindings[1].key='';v.bindings[0].command='demo_timescale 8';assert.match(cfg(v),/bind "F6" "demo_timescale 8"/);
 for(const command of ['demo_togglepause;quit','demoui\nbind x quit','demo_timescale 999','exec other','"']){
  v.bindings[0].command=command;assert.throws(()=>normalize(v),/指令/);
 }
 assert.equal(cfg({...defaults(),enabled:false}).includes('bind "'),false);
});
test('Saving replaces generated CFG, playback loads it, and user autoexec remains intact',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'replay-config-'));
 try{
  const game=path.join(dir,'game/bin/win64/cs2.exe'),cfgDir=path.join(dir,'game/csgo/cfg'),source=path.join(dir,'demo.dem');
  fs.mkdirSync(path.dirname(game),{recursive:true});fs.mkdirSync(cfgDir,{recursive:true});
  fs.writeFileSync(game,'fixture');fs.writeFileSync(source,'PBDEMS2\0fixture');fs.writeFileSync(path.join(cfgDir,'autoexec.cfg'),'user config');
  const config=defaults();config.bindings[0].key='P';
  const stage=await preparePlayback(game,source,config);
  assert.match(fs.readFileSync(stageFiles(game,stage.id).cfg,'utf8'),/exec demodesk_controls\nplaydemo/);
  const file=path.join(cfgDir,'demodesk_controls.cfg');assert.match(fs.readFileSync(file,'utf8'),/bind "P" "demo_togglepause"/);
  config.bindings[0].key='K';writeConfig(cfgDir,config);assert.doesNotMatch(fs.readFileSync(file,'utf8'),/bind "P"/);
  const disabled=await preparePlayback(game,source,{...config,enabled:false});
  assert.doesNotMatch(fs.readFileSync(stageFiles(game,disabled.id).cfg,'utf8'),/exec demodesk_controls/);
  assert.equal(fs.readFileSync(path.join(cfgDir,'autoexec.cfg'),'utf8'),'user config');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
