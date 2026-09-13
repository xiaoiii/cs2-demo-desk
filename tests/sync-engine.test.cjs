const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSyncEngine, clampDays } = require('../src/sync-engine');
const DAY=86400000, now=Date.UTC(2026,8,9,12);
const urls={premier:'https://steamcommunity.com/history?mode=premier',competitive:'https://steamcommunity.com/history?mode=competitive',wingman:'https://steamcommunity.com/history?mode=wingman',hltv:'https://www.hltv.org/results'};
const state=()=>({items:[],settings:{historyDays:7,tournamentDays:7},sync:{personal:{},tournament:{}}});
const page=records=>({recognized:true,records,hasMore:false});
const row=(key,days,extra={})=>({matchKey:key,matchAt:now-days*DAY,title:key,url:`https://replay.valve.net/${key}.dem.bz2`,pageUrl:urls.premier,...extra});
test('default seven-day refresh collects all official modes, respects actual match time and deduplicates',async()=>{
 const s=state(),calls=[];
 const e=createSyncEngine({state:s,urls,now:()=>now,onChange:()=>{},loadPage:async(url,options)=>{calls.push(options.mode);return page([row('recent',1),row('old',9),row('unknown',0,{matchAt:null})]);}});
 await e.start('personal');
 assert.deepEqual(calls,['premier','competitive','wingman']);assert.equal(s.items.length,2);assert.ok(!s.items.some(x=>x.matchKey==='old'));assert.equal(s.items.find(x=>x.matchKey==='unknown').matchAt,null);assert.equal(s.sync.personal.phase,'idle');
 await e.start('personal');assert.equal(s.items.length,2);
});
test('date range expansion adds older records without removing completed downloads',async()=>{
 const s=state();s.items=[{id:'done',url:'https://x.example/done.dem',status:'completed',files:['local.dem']}];
 const e=createSyncEngine({state:s,urls,now:()=>now,onChange:()=>{},loadPage:async()=>page([row('older',20)])});
 await e.start('personal');assert.equal(s.items.length,1);s.settings.historyDays=30;await e.start('personal');assert.equal(s.items.length,2);assert.equal(s.items.find(x=>x.id==='done').status,'completed');
});
test('login expiry and website challenge preserve existing matches with actionable state',async()=>{
 const s=state();s.items=[{id:'old'}];
 const e=createSyncEngine({state:s,urls,now:()=>now,onChange:()=>{},loadPage:async()=>({...page([]),loginRequired:true,pageUrl:'https://steamcommunity.com/login/'})});
 await e.start('personal');assert.equal(s.sync.personal.phase,'login_required');assert.equal(s.items[0].id,'old');
 const t=createSyncEngine({state:s,urls,now:()=>now,onChange:()=>{},loadPage:async()=>({...page([]),challenge:true})});await t.start('tournament');assert.equal(s.sync.tournament.phase,'verification_required');
});
test('AJAX history pagination stops once older matches are reached',async()=>{
 const s=state();let pages=0;
 const e=createSyncEngine({state:s,urls,now:()=>now,onChange:()=>{},loadPage:async(url,o)=>{
   if(o.mode!=='premier')return page([]);pages++;
   if(!o.moreSelector)return {...page([row('one',1)]),hasMore:true,loadMoreSelector:'#load_more'};
   assert.equal(o.moreSelector,'#load_more');return {...page([row('one',1),row('two',4),row('expired',10)]),hasMore:true,oldestAt:now-10*DAY,loadMoreSelector:'#load_more'};
 }});await e.start('personal');assert.equal(pages,2);assert.equal(s.items.length,2);
});
test('tournaments are cataloged by real event and lazily resolve downloads',async()=>{
 const s=state(),calls=[];
 const e=createSyncEngine({state:s,urls,now:()=>now,onChange:()=>{},loadPage:async(url,o)=>{
   calls.push(o.kind);if(o.kind==='hltv-match')return page([row('match',1,{url:'https://cdn.example/maps.rar'})]);
   return page([row('hltv:1',2,{url:'',pageUrl:'https://www.hltv.org/matches/1/a',event:'IEM Test',eventId:'12',team1:'A',team2:'B'})]);
 }});await e.start('tournament');assert.deepEqual(calls,['hltv-results']);assert.equal(s.items[0].status,'catalog');assert.equal(s.items[0].event,'IEM Test');await e.resolveRecord(s.items[0]);assert.equal(s.items[0].status,'ready');assert.equal(s.items[0].url,'https://cdn.example/maps.rar');
});
test('unpublished official demos can become downloadable on a later refresh',async()=>{
 const s=state();let published=false;
 const e=createSyncEngine({state:s,urls,now:()=>now,onChange:()=>{},loadPage:async()=>page([row('same',1,{url:published?'https://replay.valve.net/a.dem.bz2':''})])});
 await e.start('personal');assert.equal(s.items[0].status,'unavailable');published=true;await e.start('personal');assert.equal(s.items.length,1);assert.equal(s.items[0].status,'ready');
});
test('concurrent refresh clicks coalesce and pagination bounds report partial results',async()=>{
 const s=state();let pages=0;
 const e=createSyncEngine({state:s,urls,now:()=>now,onChange:()=>{},limits:{pages:2},loadPage:async()=>{await new Promise(r=>setTimeout(r,5));pages++;return {...page([row(`p${pages}`,1,{url:'',pageUrl:`https://www.hltv.org/matches/${pages}/a`})]),hasMore:true,nextUrl:`https://www.hltv.org/results?offset=${pages*100}`};}});
 await Promise.all([e.start('tournament'),e.start('tournament')]);assert.equal(pages,2);assert.equal(s.sync.tournament.phase,'partial');assert.equal(s.items.length,2);
});
test('range settings clamp to 1–365 days',()=>{assert.equal(clampDays(),7);assert.equal(clampDays(-9),1);assert.equal(clampDays(500),365);assert.equal(clampDays('14'),14);});
test('stopping and immediately restarting waits for old cleanup then fetches the new range',async()=>{
 const s=state();let release,calls=0;
 const e=createSyncEngine({state:s,urls,now:()=>now,onChange:()=>{},loadPage:async()=>{calls++;if(calls===1)await new Promise(r=>release=r);return page([row('new',1,{url:'',pageUrl:'https://www.hltv.org/matches/1/a'})]);}});
 const old=e.start('tournament');e.stop('tournament');s.settings.tournamentDays=30;const restarted=e.start('tournament');release();await Promise.all([old,restarted]);
 assert.equal(calls,2);assert.equal(s.sync.tournament.phase,'idle');assert.equal(s.sync.tournament.days,30);assert.equal(s.items.length,1);
});
test('a detail-page challenge cannot be overwritten by concurrent catalog completion',async()=>{
 const s=state();let release,loaded;const pageTwo=new Promise(r=>loaded=r);let count=0;
 const e=createSyncEngine({state:s,urls,now:()=>now,onChange:()=>{},loadPage:async(url,o)=>{
   if(o.kind==='hltv-match')return {...page([]),challenge:true,pageUrl:url};
   if(++count===1)return {...page([row('catalog',1,{url:'',pageUrl:'https://www.hltv.org/matches/1/a'})]),hasMore:true,nextUrl:'https://www.hltv.org/results?offset=100'};
   loaded();await new Promise(r=>release=r);return page([]);
 }});
 const refresh=e.start('tournament');await pageTwo;await e.resolveRecord(s.items[0]);release();await refresh;
 assert.equal(s.sync.tournament.phase,'verification_required');assert.ok(s.sync.tournament.verifyUrl.includes('/matches/1/'));assert.equal(s.items[0].status,'failed');
});
