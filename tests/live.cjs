const { _electron: electron } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const root=path.resolve(__dirname,'..'), output=path.join(root,'test-results');
const profile=fs.mkdtempSync(path.join(output,'live-profile-'));
const env={...process.env,DEMODESK_TEST:'1',DEMODESK_DATA:profile};delete env.ELECTRON_RUN_AS_NODE;
let app;
(async()=>{
  app=await electron.launch({args:[root],env,timeout:60000});const page=await app.firstWindow();await page.waitForSelector('#rows');
  const rpc=(action,data)=>page.evaluate(({action,data})=>window.desk.call(action,data),{action,data});
  const report={date:new Date().toISOString(),sources:[]};
  for(const [category,url] of [['tournament','https://www.hltv.org/matches/2397605/big-vs-g2-fissure-playground-3'],['personal','https://steamcommunity.com/my/gcpd/730/?tab=matchhistorypremier']]) {
    await rpc('source',{url,category});
    let snapshot;
    for(let i=0;i<35;i++){
      await new Promise(r=>setTimeout(r,1000));
      snapshot=await app.evaluate(async({webContents},category)=>{
        const w=webContents.getAllWebContents().find(x=>/^https?:/.test(x.getURL()));
        if(!w)return {loading:true};
        return {url:w.getURL(),title:w.getTitle(),loading:w.isLoading(),body:await w.executeJavaScript('document.body.innerText.slice(0,800)').catch(()=>''),links:await w.executeJavaScript('Array.from(document.querySelectorAll("[data-demo-link],a[href]"),x=>x.getAttribute("data-demo-link")||x.href).filter(x=>/download\\/demo/.test(x))').catch(()=>[])};
      },category);
      if(!snapshot.loading)break;
    }
    const imported=await rpc('scan');
    report.sources.push({category,requestedURL:url,snapshot,imported});
    if(category==='tournament'&&imported.ok&&imported.value>0){
      const s=await rpc('state');const item=s.value.items.find(x=>x.category==='tournament');await rpc('queue',{ids:[item.id]});
      let latest;
      for(let i=0;i<35;i++){await new Promise(r=>setTimeout(r,1000));latest=(await rpc('state')).value.items.find(x=>x.id===item.id);if(['failed','completed'].includes(latest.status)||latest.received>1024*1024)break;}
      report.sources[0].download={status:latest.status,received:latest.received,error:latest.error};
      if(latest.status==='downloading')await rpc('cancel',{id:item.id});
    }
  }
  fs.writeFileSync(path.join(output,'live-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{if(app)await app.close();});
