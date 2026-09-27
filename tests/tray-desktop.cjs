const {_electron:electron}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),http=require('node:http');
const {once}=require('node:events');
const root=path.resolve(__dirname,'..'),profile=fs.mkdtempSync(path.join(root,'test-results','tray-profile-'));
let app,page;
const server=http.createServer((req,res)=>{const b=Buffer.concat([Buffer.from('PBDEMS2\0'),Buffer.alloc(300000)]);res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':b.length,'Content-Disposition':'attachment; filename="test.dem"'});res.write(b.subarray(0,100));setTimeout(()=>res.end(b.subarray(100)),1800);});
async function rpc(action,data){const r=await page.evaluate(({action,data})=>window.desk.call(action,data),{action,data});assert.ok(r.ok,r.error);return r.value;}
(async()=>{
 try{
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const env={...process.env,DEMODESK_TEST:'1',DEMODESK_TEST_TRAY:'1',DEMODESK_DATA:profile};delete env.ELECTRON_RUN_AS_NODE;
  app=await electron.launch({args:[root],env});page=await app.firstWindow();await page.waitForSelector('#rows');
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.click('[data-action="nav-downloads"]');assert.equal(await page.locator('#breadcrumb').textContent(),'下载队列');
  await page.click('[data-action="nav-library"]');assert.equal(await page.locator('#breadcrumb').textContent(),'本地 Demo 库');
  await rpc('import',{text:`http://127.0.0.1:${server.address().port}/test.dem`,category:'personal'});const s=await rpc('state');await rpc('queue',{ids:[s.items[0].id]});
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.getTitle()==='CS2 Demo Desk').close());
  assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.getTitle()==='CS2 Demo Desk').isVisible()),false);
  for(let i=0;i<80;i++){if((await rpc('state')).items[0].status==='completed')break;await new Promise(r=>setTimeout(r,100));}
  assert.equal((await rpc('state')).items[0].status,'completed');
  await rpc('main');await page.screenshot({path:path.join(root,'test-results','tray-quickbar.png')});
  assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.getTitle()==='CS2 Demo Desk').isVisible()),true);
  await page.click('[data-action="hide-to-tray"]');
  await rpc('automation-settings',{autoQuit:true});
  // Completed background work should exit, rather than merely hiding to the tray.
  const closed=app.waitForEvent('close',{timeout:20000});await closed;app=null;assert.deepEqual(errors,[]);
  console.log('Tray desktop passed: shortcuts, close-to-background, continued download, restore, hide, and automatic exit with tray active.');
 }finally{if(app)await app.close();server.closeAllConnections();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
