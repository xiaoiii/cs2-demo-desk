// Isolated Electron fixture, not shipped in the application.
const { app, BrowserWindow, session } = require('electron');
const https = require('node:https'), { once } = require('node:events');
const { createIdentity, createBridge, proxyConfig, verifyLocal } = require('../src/steam-network');
let bridge, upstream;
app.whenReady().then(async () => {
  const identity = createIdentity();
  // Electron's BoringSSL requires a CA certificate, unlike Node/OpenSSL's
  // acceptance of a self-signed leaf as an explicit test trust anchor.
  const forge=require('node-forge'), rootIdentity=createIdentity();
  const root=forge.pki.certificateFromPem(rootIdentity.cert);
  root.setSubject([{name:'commonName',value:'Demo Desk fixture root'}]);root.setIssuer(root.subject.attributes);
  root.setExtensions([{name:'basicConstraints',cA:true},{name:'keyUsage',keyCertSign:true,digitalSignature:true}]);
  root.sign(forge.pki.privateKeyFromPem(rootIdentity.key),forge.md.sha256.create());
  const ca=forge.pki.certificateToPem(root), leaf=forge.pki.certificateFromPem(identity.cert);
  leaf.setIssuer(root.subject.attributes);leaf.sign(forge.pki.privateKeyFromPem(rootIdentity.key),forge.md.sha256.create());
  identity.cert=forge.pki.certificateToPem(leaf)+ca;
  upstream = https.createServer(identity, (req, res) => {
    console.error('Fixture request',req.url);
    if (req.url === '/start') { res.writeHead(302, { 'Set-Cookie': 'fixture=kept; Path=/; Secure; HttpOnly; SameSite=Lax', Location: '/ready' }); res.end(); }
    else if (req.url === '/ready') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<title>Fixture</title><body>cookie:' + (req.headers.cookie === 'fixture=kept' ? 'preserved' : 'missing') + '</body>'); }
    else { let body = ''; req.on('data', c => body += c); req.on('end', () => res.end(JSON.stringify({ body, cookie: req.headers.cookie, origin: req.headers.origin, host: req.headers.host }))); }
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  bridge = await createBridge({ resolve: async () => ['127.0.0.1'], port: upstream.address().port, ca, onError: code=>console.error('Fixture upstream error',code) });
  const ses = session.fromPartition('network-cookie-fixture');
  ses.setCertificateVerifyProc((req, cb) => cb(verifyLocal(bridge.identity, req)));
  await ses.setProxy(proxyConfig(bridge.port));
  const win = new BrowserWindow({ show: false, webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  win.webContents.on('did-fail-load', (_event,code,description)=>console.error('Fixture navigation',code,description));
  console.error('Fixture route',await ses.resolveProxy('https://steamcommunity.com/start'));
  await win.loadURL('https://steamcommunity.com/start');
});
app.on('window-all-closed', async () => { await bridge?.close(); upstream?.closeAllConnections(); upstream?.close(); app.quit(); });
