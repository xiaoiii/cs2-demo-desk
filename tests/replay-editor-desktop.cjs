const {_electron:electron}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),out=path.join(root,'test-results');
fs.mkdirSync(out,{recursive:true});const profile=fs.mkdtempSync(path.join(out,'replay-editor-'));
let app,page;const errors=[];
async function launch(){
 const env={...process.env,DEMODESK_TEST:'1',DEMODESK_DATA:profile};delete env.ELECTRON_RUN_AS_NODE;
 app=await electron.launch({args:[root],env,timeout:60000});page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));
 await page.waitForSelector('#rows');await page.click('[data-page="replay"]');
}
(async()=>{
 try{
  await launch();
  await page.getByLabel('绑定按键 1',{exact:true}).selectOption('P');
  await page.click('#saveBindings');await page.waitForFunction(()=>document.querySelector('#replaySaveStatus').textContent.includes('已保存'));
  const file=path.join(profile,'demodesk_controls.cfg');assert.match(fs.readFileSync(file,'utf8'),/bind "P" "demo_togglepause"/);
  await page.getByLabel('绑定按键 2',{exact:true}).selectOption('P');await page.click('#saveBindings');
  await page.waitForFunction(()=>document.querySelector('#replaySaveStatus').textContent.includes('重复'));
  assert.doesNotMatch(fs.readFileSync(file,'utf8'),/bind "P" "demoui"/);
  await page.getByLabel('绑定按键 2',{exact:true}).selectOption('F7');
  await page.click('[data-page="library"]');await page.click('[data-page="replay"]');
  assert.equal(await page.getByLabel('绑定按键 1',{exact:true}).inputValue(),'P');
  await page.click('#addBinding');await page.getByLabel('绑定按键 11',{exact:true}).selectOption('K');
  await page.getByLabel('播放指令 11',{exact:true}).selectOption('demo_timescale 8');
  await page.click('#saveBindings');await page.waitForFunction(()=>document.querySelector('#replaySaveStatus').textContent.includes('已保存'));
  await page.screenshot({path:path.join(out,'replay-controls-editor.png'),fullPage:true});
  await app.close();app=null;await launch();
  assert.equal(await page.getByLabel('绑定按键 11',{exact:true}).inputValue(),'K');
  await page.uncheck('#replayEnabled');await page.click('#saveBindings');
  await page.waitForFunction(()=>document.querySelector('#replaySaveStatus').textContent.includes('已保存'));
  assert.doesNotMatch(fs.readFileSync(file,'utf8'),/bind "/);
  await page.click('#resetBindings');assert.equal(await page.getByLabel('绑定按键 1',{exact:true}).inputValue(),'F6');
  assert.deepEqual(errors,[]);console.log('Replay editor passed: save CFG, conflict validation, draft navigation, add row, restart persistence, disable, reset, no renderer errors.');
 }finally{if(app)await app.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
