const {_electron:electron}=require('playwright');
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),out=path.join(root,'test-results');let app;
(async()=>{
 const env={...process.env,DEMODESK_TEST:'1',DEMODESK_DATA:fs.mkdtempSync(path.join(out,'live-auto-profile-')),DEMODESK_TEST_AUTOSYNC:'1'};delete env.ELECTRON_RUN_AS_NODE;delete env.DEMODESK_SOURCE_BASE;
 app=await electron.launch({args:[root],env});const page=await app.firstWindow();await page.waitForSelector('#rows');let s;
 for(let i=0;i<70;i++){
  await new Promise(r=>setTimeout(r,500));s=(await page.evaluate(()=>window.desk.call('state'))).value;
  if(i>2&&Object.values(s.sync).every(x=>x.phase!=='syncing'))break;
 }
 const report={date:new Date().toISOString(),version:s.version,sync:s.sync,records:s.items.length,limitations:['Isolated profile has no user Steam login.','Source website challenges are reported without bypass.']};
 fs.writeFileSync(path.join(out,'live-auto-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{if(app)await app.close();});
