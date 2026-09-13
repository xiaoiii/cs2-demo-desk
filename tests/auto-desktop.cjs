const { _electron: electron } = require('playwright');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {once}=require('node:events');
const root=path.resolve(__dirname,'..'),out=path.join(root,'test-results');fs.mkdirSync(out,{recursive:true});
const profile=fs.mkdtempSync(path.join(out,'auto-profile-'));
const DAY=86400000,now=Date.now();let loggedIn=false,challenge=false,requests=[];
const stamp=days=>new Date(now-days*DAY).toISOString().replace('T',' ').replace(/\.\d+Z$/,' GMT');
function steamRow(id,days,map='de_mirage',download=true){return `<tr><td class="val_left"><table class="csgo_scoreboard_inner_left"><tr><td>${map}</td></tr><tr><td>${stamp(days)}</td></tr><tr><td>${download?`<a href="/${id}.dem">Download GOTV Replay</a>`:'Download unavailable'}</td></tr></table></td><td class="val_right">13 : 8</td></tr>`;}
function result(id,days,event){return `<div class="result-con" data-zonedgrouping-entry-unix="${now-days*DAY}"><a class="a-reset" href="/matches/${id}/team-a-vs-team-b"><div class="team1"><div class="team">Team A</div></div><div class="team2"><div class="team">Team B</div></div><span class="event-name">${event}</span><span class="result-score">2 - 1</span></a></div>`;}
const server=http.createServer((req,res)=>{
 const url=new URL(req.url,'http://localhost');requests.push(url.pathname+url.search);
 if(url.pathname==='/login'){res.setHeader('Content-Type','text/html');return res.end('<title>Steam 登录</title><form id="login_form"><input type="password"></form>');}
 if(url.pathname==='/history'){
  if(!loggedIn){res.writeHead(302,{Location:'/login'});return res.end();}
  const mode=url.searchParams.get('mode');res.setHeader('Content-Type','text/html');
  if(mode!=='premier')return res.end('<title>Steam Personal Game Data</title><table class="csgo_scoreboard_root"></table><p>No matches</p>');
  const more=steamRow('second',4,'de_nuke')+steamRow('old',20,'de_ancient');
  return res.end(`<title>Steam Personal Game Data</title><table class="csgo_scoreboard_root"><tbody id="matches">${steamRow('first',1)}${steamRow('unavailable',2,'de_dust2',false)}</tbody></table><button id="load_more_button" onclick='document.getElementById("matches").insertAdjacentHTML("beforeend",${JSON.stringify(more)});this.hidden=true;'>Load More</button>`);
 }
 if(url.pathname==='/results'){
  res.setHeader('Content-Type','text/html');if(challenge)return res.end('<title>Just a moment...</title><h1>Performing security verification</h1><div id="cf-challenge-running">Checking your browser</div>');
  return res.end(`<title>Counter-Strike Results | HLTV.org</title><div class="results-all">${result('1',1,'IEM Test')}${result('2',3,'BLAST Test')}${result('3',25,'Old Event')}</div>`);
 }
 if(url.pathname.startsWith('/matches/')){res.setHeader('Content-Type','text/html');return res.end('<title>Team A vs Team B | HLTV.org</title><div class="match-info-box"><div class="timeAndEvent"><div class="event">IEM Test</div></div></div><a data-demo-link="/tournament.dem">Demo download</a>');}
 if(url.pathname.endsWith('.dem')){const b=Buffer.concat([Buffer.from('PBDEMS2\0'),Buffer.alloc(16384,42)]);res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Disposition':`attachment; filename="${path.basename(url.pathname)}"`,'Content-Length':b.length});return res.end(b);}
 res.writeHead(404);res.end('Not found');
});
let app,page;const checks=[];
async function rpc(action,data){const r=await page.evaluate(({action,data})=>window.desk.call(action,data),{action,data});assert.ok(r.ok,r.error);return r.value;}
async function until(predicate){for(let i=0;i<250;i++){const s=await rpc('state');if(predicate(s))return s;await new Promise(r=>setTimeout(r,100));}throw new Error('State wait timed out');}
async function launch(base){const env={...process.env,DEMODESK_TEST:'1',DEMODESK_DATA:profile,DEMODESK_SOURCE_BASE:base,DEMODESK_TEST_AUTOSYNC:'1'};delete env.ELECTRON_RUN_AS_NODE;app=await electron.launch({...(process.env.DEMODESK_PACKAGED==='1'?{executablePath:path.join(root,'release','win-unpacked','CS2 Demo Desk.exe'),args:[]}:{args:[root]}),env});page=await app.firstWindow();await page.waitForSelector('#rows');}
(async()=>{
 server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
 await launch(base);
 let s=await until(s=>s.sync.personal.phase==='login_required'&&s.sync.tournament.lastSync>0);
 assert.equal(s.settings.historyDays,7);assert.equal(s.settings.tournamentDays,7);assert.equal(s.items.length,2);checks.push('Startup automatically fetches seven-day event catalog and detects Steam login requirement');
 await page.locator('[data-page="tournament"]').click();const eventValue=await page.locator('#eventFilter option').filter({hasText:'IEM Test'}).getAttribute('value');await page.locator('#eventFilter').selectOption(eventValue);assert.equal(await page.locator('.demo-row').count(),1);await page.locator('#eventFilter').selectOption('all');checks.push('Real catalog metadata produces event categories and functional filtering');
 assert.equal(requests.filter(x=>x.startsWith('/matches/')).length,0);
 const tournament=s.items.find(x=>x.event==='IEM Test');await rpc('queue',{ids:[tournament.id]});s=await until(s=>s.items.find(x=>x.id===tournament.id).status==='completed');assert.ok(requests.some(x=>x.startsWith('/matches/1/')));checks.push('Selected catalog match resolves its demo automatically and downloads to disk');
 loggedIn=true;
 await app.evaluate(async({session})=>session.fromPartition('persist:demo-sources').cookies.set({url:'https://steamcommunity.com',name:'steamLoginSecure',value:'LOCAL_TEST_ONLY_NEVER_REAL_CREDENTIAL',secure:true,httpOnly:true}));
 await rpc('source',{url:base+'/history?mode=premier',category:'personal'});s=await until(s=>s.sync.personal.lastSync>0);
 const personal=s.items.filter(x=>x.category==='personal');assert.equal(personal.length,3);assert.ok(personal.some(x=>x.map==='de_nuke'));assert.ok(!personal.some(x=>x.url.includes('/old.dem')));assert.ok(personal.some(x=>x.status==='unavailable'));checks.push('Post-login page navigation automatically resumes official sync, paginates and filters by match date');
 await page.locator('[data-page="personal"]').click();await page.locator('#rangeSelect').selectOption('30');s=await until(s=>s.settings.historyDays===30&&s.items.some(x=>x.url.includes('/old.dem')));checks.push('Changing UI date range automatically refreshes and adds older matches');
 await page.screenshot({path:path.join(out,'auto-personal.png'),fullPage:true});
 const previous=s.items.length;challenge=true;await rpc('sync',{category:'tournament'});s=await until(s=>s.sync.tournament.phase==='verification_required');assert.equal(s.items.length,previous);checks.push('Website verification is reported without bypassing it or losing cached matches');challenge=false;
 await until(s=>s.auth.steamSaved);await app.close();app=null;
 const encrypted=fs.readFileSync(path.join(profile,'steam-session.bin'));assert.ok(!encrypted.includes(Buffer.from('LOCAL_TEST_ONLY_NEVER_REAL_CREDENTIAL')));checks.push('Steam session is saved encrypted with Windows safeStorage, not plaintext');
 requests=[];await launch(base);s=await until(s=>s.sync.personal.phase==='idle'&&s.sync.personal.lastSync>0&&s.auth.steamSaved);assert.equal(s.settings.historyDays,30);
 const restored=await app.evaluate(async({session})=>(await session.fromPartition('persist:demo-sources').cookies.get({domain:'steamcommunity.com'})).some(x=>x.name==='steamLoginSecure'&&x.value==='LOCAL_TEST_ONLY_NEVER_REAL_CREDENTIAL'));
 assert.ok(restored);checks.push('Application restart restores the login session and configured range, then syncs automatically');
 await rpc('logout');s=await rpc('state');assert.equal(s.auth.steamSaved,false);assert.equal(fs.existsSync(path.join(profile,'steam-session.bin')),false);assert.ok(s.items.length>=previous);checks.push('Clear login removes the encrypted vault and keeps downloaded history');
 await app.close();app=null;
 fs.writeFileSync(path.join(out,process.env.DEMODESK_PACKAGED==='1'?'auto-packaged-report.json':'auto-desktop-report.json'),JSON.stringify({date:new Date().toISOString(),passed:checks.length,checks,limitations:['Synthetic controlled source pages; no real Steam account login.','Website verification is detected, not bypassed.']},null,2));console.log(JSON.stringify({passed:checks.length,checks},null,2));
})().catch(async e=>{console.error(e);if(page)await page.screenshot({path:path.join(out,'auto-failure.png')}).catch(()=>{});process.exitCode=1;}).finally(async()=>{if(app)await app.close().catch(()=>{});server.closeAllConnections();server.close();});
