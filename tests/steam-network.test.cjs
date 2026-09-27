const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http'), https = require('node:https'), tls = require('node:tls');
const { once } = require('node:events');
const vm = require('node:vm');
const network = require('../src/steam-network');
async function request(bridge, host = 'steamcommunity.com', body = '', headers = {}) {
  const socket = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: bridge.port, method: 'CONNECT', path: host + ':443' });
    req.on('connect', (res, socket) => { if (res.statusCode !== 200) { socket.destroy(); reject(new Error('CONNECT ' + res.statusCode)); } else resolve(socket); });
    req.on('error', reject); req.end();
  });
  const secure = tls.connect({ socket, servername: host, ca: bridge.identity.cert });
  await once(secure, 'secureConnect');
  return new Promise((resolve, reject) => {
    let result = '';
    secure.on('data', chunk => result += chunk);
    secure.on('error', reject);
    secure.on('end', () => resolve(result));
    secure.write(`${body ? 'POST' : 'GET'} /test HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(body)}\r\n${Object.entries(headers).map(([k,v])=>k+': '+v+'\r\n').join('')}\r\n${body}`);
  });
}
test('built-in switch has no external proxy address and strict input', () => {
  assert.deepEqual(network.normalizeNetwork(), { enabled: false });
  assert.deepEqual(network.normalizeNetwork({ enabled: true, address: 'http://secret@outside' }), { enabled: true });
  assert.throws(() => network.normalizeNetwork({ enabled: 'yes' }));
  assert.throws(() => network.normalizeNetwork(null));
});
test('PAC routes only HTTPS Steam hosts, excludes lookalikes and unrelated sites', () => {
  const script = Buffer.from(network.proxyConfig(1234).pacScript.split(',')[1], 'base64').toString();
  const ctx = vm.createContext({ dnsDomainIs: (host,suffix)=>host.endsWith(suffix) }); vm.runInContext(script,ctx);
  for (const host of ['steamcommunity.com','store.steampowered.com','login.steampowered.com','community.fastly.steamstatic.com']) assert.equal(ctx.FindProxyForURL('https://'+host,host),'PROXY 127.0.0.1:1234');
  for (const host of ['steamcommunity.com.evil.test','evilsteamcommunity.com','partner.wmpvp.com','www.hltv.org']) assert.equal(ctx.FindProxyForURL('https://'+host,host),'DIRECT');
  assert.equal(ctx.FindProxyForURL('http://steamcommunity.com','steamcommunity.com'),'DIRECT');
});
test('session trust is pinned to temporary certificate and Steam hostname', () => {
  const a=network.createIdentity(), b=network.createIdentity();
  assert.equal(network.verifyLocal(a,{hostname:'steamcommunity.com',certificate:{data:a.cert}}),0);
  assert.equal(network.verifyLocal(a,{hostname:'evil.test',certificate:{data:a.cert}}),-3);
  assert.equal(network.verifyLocal(a,{hostname:'steamcommunity.com',certificate:{data:b.cert}}),-3);
});
test('bridge preserves POST, cookies, redirects and validates destination; stops on close', async () => {
  const identity=network.createIdentity(); let received;
  const upstream=https.createServer(identity,(req,res)=>{let body='';req.on('data',c=>body+=c);req.on('end',()=>{received={body,headers:req.headers,sni:req.socket.servername};res.writeHead(302,{'Set-Cookie':'sessionid=fake-test; Secure; HttpOnly; SameSite=Lax','Location':'/next'});res.end('redirect');});});
  upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
  const bridge=await network.createBridge({resolve:async()=>['127.0.0.1'],port:upstream.address().port,ca:identity.cert});
  try {
    const result=await request(bridge,'steamcommunity.com','fake-login-body',{'Cookie':'test=fixture','Proxy-Authorization':'must-not-forward'});
    assert.match(result,/302/);assert.match(result,/set-cookie: sessionid=fake-test/i);assert.match(result,/location: \/next/i);
    assert.equal(received.body,'fake-login-body');assert.equal(received.headers.cookie,'test=fixture');assert.equal(received.headers['proxy-authorization'],undefined);assert.equal(received.sni,false);
    await assert.rejects(request(bridge,'example.com'),/403/);
    await bridge.close(); await assert.rejects(request(bridge),/ECONNREFUSED/);
  } finally {await bridge.close();upstream.closeAllConnections();await new Promise(r=>upstream.close(r));}
});
test('upstream rejects untrusted certificates and wrong-host certificates before sending credentials',async()=>{
  for(const wrongHost of [false,true]){
    const identity=network.createIdentity(wrongHost?['unrelated.test']:undefined);let requests=0;
    const upstream=https.createServer(identity,(_req,res)=>{requests++;res.end('must not reach');});
    upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
    const bridge=await network.createBridge({resolve:async()=>['127.0.0.1'],port:upstream.address().port,...(wrongHost?{ca:identity.cert}:{})});
    try {assert.match(await request(bridge,'steamcommunity.com','credential-fixture'),/502/);assert.equal(requests,0);}
    finally{await bridge.close();upstream.closeAllConnections();await new Promise(r=>upstream.close(r));}
  }
});
test('TLS fallback uses original SNI and submits a login POST only once',async()=>{
  const valid=network.createIdentity(), other=network.createIdentity(['unrelated.test']);let count=0,body='',sni;
  const upstream=https.createServer({...other,SNICallback:(_name,cb)=>cb(null,tls.createSecureContext(valid))},(req,res)=>{
    count++;sni=req.socket.servername;req.on('data',c=>body+=c);req.on('end',()=>res.end('ok'));
  });
  upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
  const bridge=await network.createBridge({resolve:async()=>['127.0.0.1'],port:upstream.address().port,ca:valid.cert});
  try{assert.match(await request(bridge,'steamcommunity.com','single-post'),/200/);assert.equal(count,1);assert.equal(body,'single-post');assert.equal(sni,'steamcommunity.com');}
  finally{await bridge.close();upstream.closeAllConnections();await new Promise(r=>upstream.close(r));}
});
