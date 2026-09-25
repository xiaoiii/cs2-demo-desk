const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),net=require('node:net');
const {execFile}=require('node:child_process');
const {once}=require('node:events');
const root=path.resolve(__dirname,'..'),out=path.join(root,'test-results');
const version=require('../package.json').version;
(async()=>{
 const socket=net.createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(r=>socket.close(r));
 const env={...process.env,DEMODESK_TEST:'1',DEMODESK_DATA:fs.mkdtempSync(path.join(out,'portable-profile-'))};delete env.ELECTRON_RUN_AS_NODE;
 const child=execFile(path.join(root,'release',`CS2-Demo-Desk-${version}-Windows-x64.exe`),[`--remote-debugging-port=${port}`],{windowsHide:true,env});
 child.on('error',error=>console.error(error.message));
 let browser;
 for(let i=0;i<90;i++){try{browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`,{timeout:1000});break;}catch{await new Promise(r=>setTimeout(r,500));}}
 if(!browser){child.kill();throw new Error('Portable app did not expose its test debugging endpoint');}
 const page=browser.contexts()[0].pages()[0]||await browser.contexts()[0].waitForEvent('page');await page.waitForSelector('#rows');
 const result=await page.evaluate(()=>window.desk.call('state'));
 if(!result.ok||result.value.items.length!==0||result.value.version!==version)throw new Error('Unexpected portable initial state or version');
 await page.click('[data-page="settings"]');
 for(const key of ['openAtLogin','autoDownload','autoQuit'])if(await page.locator('#'+key).isChecked())throw new Error('Automation must default to off');
 await page.check('#autoDownload');
 const saved=await page.evaluate(()=>window.desk.call('state'));
 if(!saved.value.settings.autoDownload)throw new Error('Packaged automation settings did not save');
 await page.click('[data-page="replay"]');
 await page.getByLabel('绑定按键 1',{exact:true}).selectOption('P');
 await page.click('#saveBindings');
 await page.waitForFunction(()=>document.querySelector('#replaySaveStatus').textContent.includes('已保存'));
 if(!fs.readFileSync(path.join(env.DEMODESK_DATA,'demodesk_controls.cfg'),'utf8').includes('bind "P" "demo_togglepause"'))throw new Error('Packaged replay editor did not generate CFG');
 await page.screenshot({path:path.join(out,'03-portable-app.png')});
 await page.close();await browser.close().catch(()=>{});
 fs.writeFileSync(path.join(out,'portable-report.json'),JSON.stringify({date:new Date().toISOString(),passed:true,version:result.value.version,checks:['Portable EXE self-extracts and launches on Windows','Chinese UI and secure preload load from packaged ASAR','Clean user profile starts with zero fabricated matches']},null,2));
 console.log('Portable EXE smoke test passed.');
})().catch(e=>{console.error(e);process.exitCode=1;});
