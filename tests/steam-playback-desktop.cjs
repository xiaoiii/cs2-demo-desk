const { _electron:electron }=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const profile=fs.mkdtempSync(path.join(root,'test-results','steam-playback-'));
const fixture=path.join(profile,'中文录像路径');fs.mkdirSync(fixture);
const gameExe=path.join(profile,'Game/game/bin/win64/cs2.exe');
fs.mkdirSync(path.dirname(gameExe),{recursive:true});fs.writeFileSync(gameExe,'fixture');
fs.mkdirSync(path.join(profile,'Game/game/csgo'),{recursive:true});
const demo=path.join(fixture,'比赛 demo.dem'),archive=path.join(fixture,'比赛.zip');
fs.writeFileSync(demo,Buffer.from('PBDEMS2\0Synthetic transport fixture'));
execFileSync(path.join(root,'vendor','7zip','7z.exe'),['a','-tzip',archive,demo],{windowsHide:true,stdio:'pipe'});
// A local stand-in captures the real Windows process arguments without starting a game.
const stub=path.join(profile,'SteamStub.cs'),steam=path.join(profile,'steam.exe'),capture=path.join(profile,'launch-args.txt');
fs.writeFileSync(stub,'using System; using System.IO; class SteamStub { static void Main(string[] args) { File.WriteAllLines(Environment.GetEnvironmentVariable("DEMODESK_LAUNCH_CAPTURE"), args); } }');
execFileSync(path.join(process.env.WINDIR,'Microsoft.NET','Framework64','v4.0.30319','csc.exe'),['/nologo','/target:winexe',`/out:${steam}`,stub],{windowsHide:true,stdio:'pipe'});
fs.writeFileSync(path.join(profile,'library.json'),JSON.stringify({settings:{steamPath:steam,cs2InstallPath:gameExe,cs2Path:'C:/obsolete/cs2.exe',autoSync:false},items:[{id:'steam-playback-fixture',url:'https://example.com/fixture.zip',title:'中文录像',category:'personal',status:'completed',kind:'zip',path:archive,files:[]}]}));
(async()=>{
 const env={...process.env,DEMODESK_TEST:'1',DEMODESK_DATA:profile,DEMODESK_LAUNCH_CAPTURE:capture};delete env.ELECTRON_RUN_AS_NODE;
 const packaged=process.env.DEMODESK_PACKAGED==='1';
 const app=await electron.launch({executablePath:packaged?path.join(root,'release','win-unpacked','CS2 Demo Desk.exe'):require('electron'),args:packaged?[]:[root],env});
 try{
  const page=await app.firstWindow();await page.waitForSelector('#rows');
  await page.locator('[data-page="library"]').click();
  await page.getByRole('button',{name:'▶ 解压并播放',exact:true}).click();
  for(let i=0;i<80&&!fs.existsSync(capture);i++)await page.waitForTimeout(100);
  assert.ok(fs.existsSync(capture),'Steam launcher must be invoked');
  const state=(await page.evaluate(()=>window.desk.call('state'))).value;
  const record=state.items.find(x=>x.id==='steam-playback-fixture');
  assert.equal(record.files.length,1);
  assert.deepEqual(fs.readFileSync(record.files[0]),fs.readFileSync(demo));
  const args=fs.readFileSync(capture,'utf8').trim().split(/\r?\n/);
  const {playbackArgs,stageFiles}=require('../src/playback');
  assert.deepEqual(args,playbackArgs(state.settings.playbackStage));
  const staged=stageFiles(gameExe,state.settings.playbackStage.id);
  assert.deepEqual(fs.readFileSync(staged.demo),fs.readFileSync(demo));
  assert.match(fs.readFileSync(staged.cfg,'ascii'),/playdemo "demodesk_[a-f0-9]+\.dem"/);
  assert.equal(await page.locator('[data-action="play-command"]').count(),0);
  assert.match(state.notice,/Steam.*自动回放/);
  console.log('Desktop Steam playback passed: ZIP extraction -> game-local DEM copy and CFG -> Steam AppID 730 +exec config; no external paths or manual console command.');
 }finally{await app.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
