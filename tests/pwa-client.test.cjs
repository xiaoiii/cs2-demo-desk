const test = require('node:test');
const assert = require('node:assert/strict');
const pwa = require('../src/pwa-client');

test('PWA request signing matches fixed compatibility vectors', () => {
  assert.equal(pwa.requestSignature('123456','1710000000','access_token=sample-token&cup_id=0&match_id=987654321'), '32f466a84a03ba8585a6f9860758df28dceaf624');
  assert.equal(pwa.downloadSignature('76561198159976336',1710000000,'203.0.113.42'), '1710000000-8465cfc44da528cbb82577bd2eebed13');
});
test('PWA recent match request signs credentials without returning them in records', async () => {
  let request;
  const rows = await pwa.fetchRecentMatches({ steamId:'76561198159976336', token:'test-token-123456789', size:20, fetcher:async (url, options) => {
    request = { url:String(url), options };
    return { ok:true, status:200, json:async () => ({ data:[{ match:'m-1', cup_id:2, map:'de_mirage', match_starttime:1710000000 }] }) };
  }});
  assert.equal(rows[0].matchId,'m-1'); assert.equal(rows[0].matchAt,1710000000000); assert.equal(rows[0].map,'de_mirage');
  assert.match(request.url,/access_token=test-token-123456789/); assert.match(request.url,/&s=[0-9a-f]{40}/);
  assert.equal(JSON.stringify(rows).includes('test-token'),false);
  const headers = new Headers(request.options.headers);
  assert.equal(headers.get('pwasteamid'),'76561198159976336');
  assert.equal(headers.get('x-pwa-steamid'),'76561198159976336');
  assert.equal(new Set(Object.keys(request.options.headers).map(x=>x.toLowerCase())).size,Object.keys(request.options.headers).length);
});
test('PWA download is generated just in time with required headers', async () => {
  const result = await pwa.createDemoDownload({ steamId:'76561198159976336', token:'test-token-123456789', matchId:'m-1', cupId:2, fetcher:async () => ({ ok:true, text:async () => '203.0.113.42' }) });
  assert.match(result.url,/\/m-1_2\.dem\?/); assert.match(result.url,/access_token=test-token-123456789/);
  assert.equal(result.headers['X-PWA-SteamId'],'76561198159976336'); assert.match(result.headers['X-PWA-Signature'],/^\d+-[0-9a-f]+$/);
  assert.equal(result.filename,'PWA-m-1.dem.zip');
  const headers = new Headers(result.headers);
  assert.equal(headers.get('pwasteamid'),'76561198159976336');
  assert.equal(headers.get('x-pwa-steamid'),'76561198159976336');
  assert.equal(new Set(Object.keys(result.headers).map(x=>x.toLowerCase())).size,Object.keys(result.headers).length);
});
test('Service refusal preserves numeric error code without claiming token expiry or echoing secrets', async () => {
  await assert.rejects(pwa.fetchRecentMatches({steamId:'76561198159976336',token:'test-token-123456789',fetcher:async()=>({ok:true,status:200,json:async()=>({code:1033,message:'test-token-123456789'})})}),error=>error.message.includes('1033') && !/test-token|令牌.*失效/.test(error.message));
});
test('Recent list size is capped to the accepted 20-record limit', async () => {
  await pwa.fetchRecentMatches({steamId:'76561198159976336',token:'test-token-123456789',size:100,fetcher:async url=>{
    assert.equal(url.searchParams.get('size'),'20');
    return {ok:true,status:200,json:async()=>({code:0,data:[]})};
  }});
});
test('Actual recent-list date field is normalized for date filtering', () => {
  const match = pwa.normalizeMatch({match:'test-match',date:'2026-09-19 12:00:00',score:10});
  assert.equal(match.matchAt,new Date('2026-09-19 12:00:00').getTime());
});
