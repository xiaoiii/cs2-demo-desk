const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSecretStore } = require('../src/secret-store');

test('PWA credentials are persisted only through OS encryption', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'demodesk-pwa-'));
  const filename = path.join(directory,'pwa-credentials.bin');
  const safeStorage = { isEncryptionAvailable:() => true, encryptString:text => Buffer.from(`encrypted:${Buffer.from(text).toString('base64')}`), decryptString:data => Buffer.from(data.toString().slice(10),'base64').toString() };
  const store = createSecretStore({ safeStorage, filename });
  store.save({ steamId:'76561198159976336', token:'secret-token-123456' });
  assert.equal(fs.readFileSync(filename).includes(Buffer.from('secret-token')),false);
  const restored = createSecretStore({ safeStorage, filename }); assert.equal(restored.load().token,'secret-token-123456');
  restored.clear(); assert.equal(fs.existsSync(filename),false);
});
test('PWA credential store refuses plaintext fallback', () => {
  const store = createSecretStore({ safeStorage:{ isEncryptionAvailable:() => false }, filename:path.join(os.tmpdir(),'never-written-pwa.bin') });
  assert.throws(() => store.save({ token:'secret-token-123456' }),/加密不可用/);
});
