// App-scoped HTTPS bridge. Never changes system certificates, hosts or proxies.
const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');
const dns = require('node:dns').promises;
const { X509Certificate, generateKeyPairSync, randomBytes } = require('node:crypto');
const { once } = require('node:events');
const forge = require('node-forge');

const steamDomains = ['steamcommunity.com', 'steampowered.com', 'steamstatic.com', 'steamusercontent.com'];
const isSteamHost = host => steamDomains.some(d => host === d || host.endsWith('.' + d));
function normalizeNetwork(value = {}) {
  if (value === null || typeof value !== 'object' || (value.enabled !== undefined && typeof value.enabled !== 'boolean')) throw new Error('Steam 加速设置无效。');
  return { enabled: value.enabled === true };
}
function createIdentity(domains = steamDomains) {
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.publicKeyFromPem(keys.publicKey);
  cert.serialNumber = '01' + randomBytes(16).toString('hex');
  cert.validity.notBefore = new Date(Date.now() - 60000);
  cert.validity.notAfter = new Date(Date.now() + 30 * 86400000);
  cert.setSubject([{ name: 'commonName', value: 'Demo Desk temporary Steam bridge' }]);
  cert.setIssuer(cert.subject.attributes);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames: domains.flatMap(d => [{ type: 2, value: d }, { type: 2, value: '*.' + d }]) }
  ]);
  cert.sign(forge.pki.privateKeyFromPem(keys.privateKey), forge.md.sha256.create());
  const pem = forge.pki.certificateToPem(cert);
  return { key: keys.privateKey, cert: pem, fingerprint: new X509Certificate(pem).fingerprint256 };
}
function verifyLocal(identity, request) {
  if (!isSteamHost(request.hostname)) return -3;
  try { return new X509Certificate(request.certificate.data).fingerprint256 === identity.fingerprint ? 0 : -3; }
  catch { return -3; }
}
function proxyConfig(port) {
  const script = `function FindProxyForURL(url, host) { host=host.toLowerCase(); var domains=${JSON.stringify(steamDomains)}; if(url.substring(0,6)==='https:'){for(var i=0;i<domains.length;i++){if(host===domains[i]||dnsDomainIs(host,'.'+domains[i]))return 'PROXY 127.0.0.1:${port}';}} return 'DIRECT'; }`;
  return { mode: 'pac_script', pacScript: 'data:application/x-ns-proxy-autoconfig;base64,' + Buffer.from(script).toString('base64') };
}
// Encrypted DNS receives public hostnames only, never cookies or request paths.
function createResolver() {
  const cache = new Map();
  return async host => {
    const cached = cache.get(host);
    if (cached && cached.expires > Date.now()) return cached.addresses;
    let addresses;
    try {
      const data = await new Promise((resolve, reject) => {
        const req = https.get('https://dns.alidns.com/resolve?name=' + encodeURIComponent(host) + '&type=A', { timeout: 4000, agent: false, headers: { Accept: 'application/dns-json' } }, res => {
          let body = '';
          res.on('data', chunk => { body += chunk; if (body.length > 65536) req.destroy(new Error('DNS response too large')); });
          res.on('error', reject);
          res.on('end', () => { try { if (res.statusCode !== 200) throw new Error('DNS unavailable'); resolve(JSON.parse(body)); } catch (error) { reject(error); } });
        });
        req.on('timeout', () => req.destroy(new Error('DNS timeout'))); req.on('error', reject);
      });
      addresses = (data.Answer || []).filter(x => x.type === 1 && require('node:net').isIPv4(x.data)).map(x => x.data);
      if (!addresses.length) throw new Error('No DNS address');
    } catch { addresses = (await dns.lookup(host, { all: true, family: 4 })).map(x => x.address); }
    cache.set(host, { addresses, expires: Date.now() + 60000 });
    return addresses;
  };
}
// Retry TLS handshakes only. Login POST bodies are sent once, after verification.
function createUpstreamAgent({ resolve = createResolver(), port = 443, ca } = {}) {
  const agent = new https.Agent({ keepAlive: true, maxSockets: 12, maxFreeSockets: 4 });
  const pending = new Set(), destroy = agent.destroy.bind(agent); let stopped = false;
  agent.destroy = () => { stopped = true; for (const socket of pending) socket.destroy(new Error('Steam bridge stopped')); destroy(); };
  agent.createConnection = (options, callback) => {
    const host = options.host;
    (async () => {
      const addresses = (await resolve(host)).slice(0, 2);
      let lastError;
      for (const servername of ['', host]) {
        for (const address of addresses) {
          if (stopped) throw new Error('Steam bridge stopped');
          try {
            return await new Promise((resolveSocket, reject) => {
              const socket = tls.connect({ host: address, port, servername, ca, rejectUnauthorized: true,
                checkServerIdentity: (_name, cert) => tls.checkServerIdentity(host, cert), ALPNProtocols: ['http/1.1'] });
              pending.add(socket);
              const timer = setTimeout(() => socket.destroy(new Error('Steam TLS timeout')), 4500);
              socket.once('error', error => { pending.delete(socket); clearTimeout(timer); reject(error); });
              socket.once('secureConnect', () => { pending.delete(socket); clearTimeout(timer); resolveSocket(socket); });
            });
          } catch (error) { lastError = error; }
        }
      }
      throw lastError || new Error('Steam DNS unavailable');
    })().then(socket => { if (stopped) { socket.destroy(); callback(new Error('Steam bridge stopped')); } else callback(null, socket); }, error => callback(error));
  };
  return agent;
}
function cleanHeaders(headers) {
  const result = { ...headers };
  for (const key of String(headers.connection || '').split(',')) delete result[key.trim().toLowerCase()];
  for (const key of ['connection', 'proxy-connection', 'proxy-authorization', 'proxy-authenticate', 'keep-alive', 'upgrade', 'transfer-encoding', 'alt-svc']) delete result[key];
  return result;
}
async function createBridge(options = {}) {
  const identity = createIdentity(), sockets = new Set();
  const agent = createUpstreamAgent(options), targets = new WeakMap();
  const secure = https.createServer({ key: identity.key, cert: identity.cert }, (req, res) => {
    const host = targets.get(req.socket) || targets.get(req.socket._parent);
    if (!host || req.headers.host?.toLowerCase().replace(/:443$/, '') !== host || !req.url.startsWith('/') || req.url.startsWith('//')) { res.writeHead(403); res.end(); return; }
    const upstream = https.request({ hostname: host, port: 443, path: req.url, method: req.method, headers: cleanHeaders(req.headers), agent }, reply => {
      res.writeHead(reply.statusCode, cleanHeaders(reply.headers));
      reply.on('error', () => res.destroy()); reply.pipe(res);
    });
    upstream.setTimeout(30000, () => upstream.destroy(new Error('Steam request timeout')));
    upstream.on('error', error => { options.onError?.(error.code || 'CONNECTION_FAILED'); if (!res.headersSent) { res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); res.end('Steam 内置加速连接失败，请在设置中测试连接或关闭加速后重试。'); } else res.destroy(); });
    req.on('aborted', () => upstream.destroy());
    res.on('close', () => { if (!res.writableFinished) upstream.destroy(); });
    req.pipe(upstream);
  });
  secure.on('tlsClientError', () => {});
  secure.on('secureConnection', socket => { targets.set(socket, targets.get(socket._parent)); });
  const server = http.createServer((_req, res) => { res.writeHead(403); res.end(); });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); socket.on('error', () => {}); socket.setTimeout(60000, () => socket.destroy()); });
  server.on('connect', (req, socket, head) => {
    const match = /^([a-z0-9.-]+):443$/i.exec(req.url);
    const host = match?.[1].toLowerCase();
    if (!host || !isSteamHost(host)) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
    targets.set(socket, host);
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) socket.unshift(head);
    secure.emit('connection', socket);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { port: server.address().port, identity,
    close: async () => { agent.destroy(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); secure.close(); }
  };
}
const bridges = new Map();
async function applyNetwork(ses, value) {
  const config = normalizeNetwork(value), old = bridges.get(ses);
  if (config.enabled && old) return;
  if (!config.enabled) {
    await ses.setProxy({ mode: 'system' }); await ses.closeAllConnections();
    ses.setCertificateVerifyProc(null); bridges.delete(ses); if (old) await old.close(); return;
  }
  const bridge = await createBridge();
  try {
    ses.setCertificateVerifyProc((request, callback) => callback(verifyLocal(bridge.identity, request)));
    await ses.setProxy(proxyConfig(bridge.port)); await ses.closeAllConnections(); bridges.set(ses, bridge);
  } catch (error) {
    ses.setCertificateVerifyProc(null); await ses.setProxy({ mode: 'system' }).catch(() => {}); await bridge.close(); throw error;
  }
}
async function closeNetworks() {
  await Promise.all([...bridges.keys()].map(ses => applyNetwork(ses, { enabled: false })));
}
async function testConnection(ses, value) {
  await applyNetwork(ses, value);
  return Promise.all([['Steam 社区', 'https://steamcommunity.com/'], ['Steam 登录', 'https://store.steampowered.com/login/']].map(async ([name, url]) => {
    const start = Date.now();
    try {
      const r = await ses.fetch(url, { credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(25000) });
      const body = await r.text();
      const ok = r.ok && /<title[^>]*>[^<]+<\/title>/i.test(body) && /https:\/\/[^\s"'<>]*\.steamstatic\.com\//i.test(body);
      return { name, ok, message: ok ? `可访问（${Date.now() - start} ms）` : `未通过页面检查（HTTP ${r.status}），可切换加速开关后重试。` };
    } catch { return { name, ok: false, message: '连接失败或超时，当前网络可能无法连接 Steam；可切换加速开关后重试。' }; }
  }));
}
module.exports = { normalizeNetwork, isSteamHost, verifyLocal, proxyConfig, createIdentity, createUpstreamAgent, createBridge, applyNetwork, closeNetworks, testConnection };
