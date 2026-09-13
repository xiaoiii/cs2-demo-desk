'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { createSessionVault } = require('../src/session-vault');

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const cookieKey = cookie => `${cookie.domain.replace(/^\./, '')}/${cookie.path || '/'}/${cookie.name}`;
const login = (value = 'SECRET-STEAM-LOGIN') => ({ domain: '.steamcommunity.com', path: '/', name: 'steamLoginSecure', value, secure: true, httpOnly: true, hostOnly: false });

function fakeSession(initial = []) {
  const cookies = new EventEmitter();
  cookies.values = initial.map(cookie => ({ ...cookie }));
  cookies.getCalls = 0;
  cookies.setCalls = [];
  cookies.flushCalls = 0;
  cookies.get = async ({ domain }) => {
    cookies.getCalls += 1;
    return cookies.values.filter(cookie => cookie.domain.replace(/^\./, '') === domain || cookie.domain.endsWith(`.${domain}`)).map(cookie => ({ ...cookie }));
  };
  cookies.set = async details => {
    cookies.setCalls.push({ ...details });
    const cookie = { ...details, domain: details.domain || new URL(details.url).hostname, hostOnly: !details.domain };
    delete cookie.url;
    cookies.values = cookies.values.filter(current => cookieKey(current) !== cookieKey(cookie));
    cookies.values.push(cookie);
    cookies.emit('changed', {}, cookie, 'explicit', false);
  };
  cookies.flushStore = async () => { cookies.flushCalls += 1; };
  return { cookies };
}

function fakeSafeStorage() {
  const key = crypto.randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    encryptString: value => {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
    },
    decryptString: data => {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
      decipher.setAuthTag(data.subarray(12, 28));
      return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
    }
  };
}

async function fixture(t, initial = []) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cs2-vault-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'steam-session.dat');
  const session = fakeSession(initial);
  const safeStorage = fakeSafeStorage();
  const statuses = [];
  const vault = createSessionVault({ session, safeStorage, filename, onStatus: status => statuses.push(status) });
  t.after(() => vault.stop());
  return { directory, filename, session, safeStorage, statuses, vault };
}

async function contents(f) {
  const bytes = await fs.readFile(f.filename);
  return JSON.parse(f.safeStorage.decryptString(bytes.subarray(bytes.indexOf(10) + 1)));
}

test('construction does not access credentials; encrypted vault only stores exact Steam allowlist', async t => {
  const f = await fixture(t, [
    login(),
    { ...login('REMEMBER'), name: 'steamRememberLogin' },
    { ...login('CSRF-SECRET'), name: 'sessionid' },
    { ...login('MACHINE-SECRET'), name: 'steamMachineAuth76561198000000000' },
    { ...login('STORE-SECRET'), domain: '.store.steampowered.com', name: 'browserid' },
    { ...login('TRACKING-SECRET'), name: '_ga' },
    { ...login('WRONG-NAME-SECRET'), name: 'steamLoginSecureExtra' },
    { ...login('WRONG-MACHINE-SECRET'), name: 'steamMachineAuthinvalid' },
    { ...login('PHISHING-SECRET'), domain: '.steamcommunity.com.evil.example' },
    { ...login('UNRELATED-SECRET'), domain: '.example.com' }
  ]);
  assert.equal(f.session.cookies.getCalls, 0);
  assert.deepEqual(await f.vault.save(), { saved: true, available: true });
  const payload = await contents(f);
  assert.deepEqual(payload.cookies.map(cookie => cookie.name), ['steamLoginSecure', 'steamRememberLogin', 'sessionid', 'steamMachineAuth76561198000000000', 'browserid']);
  const bytes = await fs.readFile(f.filename);
  for (const cookie of f.session.cookies.values) assert.equal(bytes.includes(Buffer.from(cookie.value)), false);
  assert.doesNotMatch(JSON.stringify(f.statuses), /SECRET|REMEMBER|steamLogin/);
  assert.equal(f.session.cookies.flushCalls, 1);
  assert.deepEqual(await fs.readdir(f.directory), ['steam-session.dat']);
});

test('restore keeps session cookies across restarts without inventing expiry or broadening host-only cookies', async t => {
  const expires = Date.now() / 1000 + 3600;
  const f = await fixture(t, [login(), { ...login('HOST-TOKEN'), domain: 'store.steampowered.com', name: 'browserid', hostOnly: true, expirationDate: expires, sameSite: 'strict' }]);
  await f.vault.save();
  f.session.cookies.values = [];
  assert.deepEqual(await f.vault.restore(), { saved: true, available: true });
  const [sessionCookie, persistentCookie] = f.session.cookies.setCalls;
  assert.equal(Object.hasOwn(sessionCookie, 'expirationDate'), false);
  assert.equal(sessionCookie.url, 'https://steamcommunity.com/');
  assert.equal(sessionCookie.httpOnly, true);
  assert.equal(persistentCookie.expirationDate, expires);
  assert.equal(persistentCookie.sameSite, 'strict');
  assert.equal(Object.hasOwn(persistentCookie, 'domain'), false);
  assert.equal(persistentCookie.url, 'https://store.steampowered.com/');
});

test('expired credentials are skipped both on save and on restore; existing browser values win', async t => {
  const f = await fixture(t, [login('OLD-TOKEN'), { ...login('EXPIRED-TOKEN'), name: 'browserid', expirationDate: 1 }]);
  await f.vault.save();
  assert.equal((await contents(f)).cookies.length, 1);
  f.session.cookies.values = [login('NEW-TOKEN')];
  await f.vault.restore();
  assert.equal(f.session.cookies.setCalls.length, 0);
  assert.equal(f.session.cookies.values[0].value, 'NEW-TOKEN');
  const payload = { version: 1, cookies: [{ ...login('NOW-EXPIRED'), expirationDate: 1 }] };
  await fs.writeFile(f.filename, Buffer.concat([Buffer.from('CS2-STEAM-VAULT:1:S\n'), f.safeStorage.encryptString(JSON.stringify(payload))]));
  f.session.cookies.values = [];
  assert.equal((await f.vault.restore()).saved, false);
  assert.equal(f.session.cookies.setCalls.length, 0);
});

test('unavailable OS encryption never writes a plaintext fallback', async t => {
  const f = await fixture(t, [login()]);
  f.safeStorage.isEncryptionAvailable = () => false;
  const status = await f.vault.save();
  assert.equal(status.available, false);
  assert.equal(status.saved, false);
  assert.match(status.error, /安全加密不可用/);
  assert.deepEqual(await fs.readdir(f.directory), []);
});

test('failed encryption leaves previous atomic snapshot intact and errors never contain secrets', async t => {
  const f = await fixture(t, [login()]);
  await f.vault.save();
  const previous = await fs.readFile(f.filename);
  f.safeStorage.encryptString = () => { throw new Error('SECRET-STEAM-LOGIN'); };
  assert.equal((await f.vault.save()).saved, false);
  assert.deepEqual(await fs.readFile(f.filename), previous);
  assert.deepEqual(await fs.readdir(f.directory), ['steam-session.dat']);
  assert.doesNotMatch(JSON.stringify(f.statuses), /SECRET-STEAM-LOGIN/);
});

test('concurrent saves serialize and leave a complete latest snapshot without temporary files', async t => {
  const f = await fixture(t, [login('FIRST-TOKEN')]);
  const get = f.session.cookies.get;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let first = true;
  f.session.cookies.get = async filter => {
    const snapshot = await get(filter);
    if (first) { first = false; await gate; }
    return snapshot;
  };
  const saving = f.vault.save();
  await delay(10);
  f.session.cookies.values = [login('SECOND-TOKEN')];
  const next = f.vault.save();
  release();
  await Promise.all([saving, next]);
  assert.equal((await contents(f)).cookies[0].value, 'SECOND-TOKEN');
  assert.deepEqual(await fs.readdir(f.directory), ['steam-session.dat']);
});

test('clear cancels an in-flight save and prevents old cookies rebuilding the vault until start', async t => {
  const f = await fixture(t, [login()]);
  await f.vault.start();
  const originalGet = f.session.cookies.get;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  f.session.cookies.get = async filter => { await gate; return originalGet(filter); };
  const saving = f.vault.save();
  await delay(10);
  const clearing = f.vault.clear();
  release();
  await Promise.all([saving, clearing]);
  assert.equal(f.session.cookies.listenerCount('changed'), 0);
  await f.vault.save();
  f.session.cookies.emit('changed', {}, login(), 'explicit', false);
  await delay(350);
  assert.deepEqual(await fs.readdir(f.directory), []);
  await f.vault.start();
  await f.vault.save();
  assert.equal((await contents(f)).cookies[0].value, 'SECRET-STEAM-LOGIN');
});

test('changed cookies are debounced, stop removes timers/listeners, and explicit final save remains possible', async t => {
  const f = await fixture(t, [login()]);
  await f.vault.start();
  await f.vault.start();
  assert.equal(f.session.cookies.listenerCount('changed'), 1);
  for (let i = 0; i < 5; i++) f.session.cookies.emit('changed', {}, login(), 'explicit', false);
  await delay(380);
  await f.vault.stop();
  assert.equal(f.session.cookies.flushCalls, 1);
  await f.vault.start();
  f.session.cookies.emit('changed', {}, login(), 'explicit', false);
  await f.vault.stop();
  await delay(350);
  assert.equal(f.session.cookies.flushCalls, 1);
  assert.equal(f.session.cookies.listenerCount('changed'), 0);
  await f.vault.save();
  assert.equal(f.session.cookies.flushCalls, 2);
});

test('a queued start cannot undo a subsequent clear or stop', async t => {
  const f = await fixture(t, [login()]);
  const starting = f.vault.start();
  const clearing = f.vault.clear();
  await Promise.all([starting, clearing]);
  assert.equal(f.session.cookies.listenerCount('changed'), 0);
  await f.vault.save();
  assert.deepEqual(await fs.readdir(f.directory), []);
  const restarting = f.vault.start();
  const stopping = f.vault.stop();
  await Promise.all([restarting, stopping]);
  assert.equal(f.session.cookies.listenerCount('changed'), 0);
});

test('corrupt or foreign-user ciphertext is recoverable with sanitized status', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.filename, 'CORRUPTED-SECRET');
  const status = await f.vault.restore();
  assert.equal(status.saved, false);
  assert.equal(status.available, true);
  assert.match(status.error, /重新登录/);
  assert.doesNotMatch(JSON.stringify(status), /CORRUPTED-SECRET/);
  assert.equal(f.session.cookies.setCalls.length, 0);
});

test('supports newer async safeStorage while remaining compatible with the sync Electron API', async t => {
  const f = await fixture(t, [login()]);
  const { encryptString, decryptString } = f.safeStorage;
  f.safeStorage.isAsyncEncryptionAvailable = async () => true;
  f.safeStorage.encryptStringAsync = async value => encryptString(value);
  f.safeStorage.decryptStringAsync = async value => ({ result: decryptString(value), shouldReEncrypt: false });
  f.safeStorage.encryptString = () => { throw new Error('Sync path should not be used'); };
  f.safeStorage.decryptString = () => { throw new Error('Sync path should not be used'); };
  await f.vault.save();
  assert.equal((await fs.readFile(f.filename)).subarray(0, 20).toString(), 'CS2-STEAM-VAULT:1:A\n'.slice(0, 20));
  f.session.cookies.values = [];
  assert.equal((await f.vault.restore()).saved, true);
  assert.equal(f.session.cookies.values[0].value, 'SECRET-STEAM-LOGIN');
});

test('an unavailable optional async provider still restores and saves through the supported sync provider', async t => {
  const f = await fixture(t, [login()]);
  await f.vault.save();
  f.safeStorage.isAsyncEncryptionAvailable = async () => { throw new Error('SECRET-PROVIDER-DETAIL'); };
  f.safeStorage.encryptStringAsync = async () => { throw new Error('Must use sync provider'); };
  f.safeStorage.decryptStringAsync = async () => { throw new Error('Must use sync provider'); };
  f.session.cookies.values = [];
  assert.deepEqual(await f.vault.restore(), { saved: true, available: true });
  assert.deepEqual(await f.vault.save(), { saved: true, available: true });
  assert.doesNotMatch(JSON.stringify(f.statuses), /SECRET/);
});

test('a start already awaiting encryption cannot publish stale status after clear or stop', async t => {
  for (const action of ['clear', 'stop']) {
    const f = await fixture(t, [login()]);
    const entered = deferred(), gate = deferred();
    f.safeStorage.isAsyncEncryptionAvailable = async () => { entered.resolve(); await gate.promise; return true; };
    f.safeStorage.encryptStringAsync = async value => f.safeStorage.encryptString(value);
    f.safeStorage.decryptStringAsync = async value => ({ result: f.safeStorage.decryptString(value), shouldReEncrypt: false });
    const starting = f.vault.start();
    await entered.promise;
    assert.equal(f.session.cookies.listenerCount('changed'), 1);
    const ending = f.vault[action]();
    assert.equal(f.session.cookies.listenerCount('changed'), 0);
    gate.resolve();
    await Promise.all([starting, ending]);
    assert.equal(f.statuses.length, action === 'clear' ? 1 : 0);
    assert.equal(f.session.cookies.listenerCount('changed'), 0);
    assert.deepEqual(await fs.readdir(f.directory), []);
  }
});

test('cookies deleted while async decryption is pending are not resurrected from the saved snapshot', async t => {
  const f = await fixture(t, [login('SAVED-OLDER-TOKEN')]);
  const entered = deferred(), gate = deferred();
  f.safeStorage.isAsyncEncryptionAvailable = async () => true;
  f.safeStorage.encryptStringAsync = async value => f.safeStorage.encryptString(value);
  f.safeStorage.decryptStringAsync = async value => {
    entered.resolve();
    await gate.promise;
    return { result: f.safeStorage.decryptString(value), shouldReEncrypt: false };
  };
  await f.vault.save();
  const restoring = f.vault.restore();
  await entered.promise;
  f.session.cookies.values = [];
  f.session.cookies.emit('changed', {}, login('SAVED-OLDER-TOKEN'), 'explicit', true);
  gate.resolve();
  await restoring;
  assert.equal(f.session.cookies.setCalls.length, 0);
  assert.equal(f.session.cookies.values.length, 0);
  assert.equal(f.session.cookies.listenerCount('changed'), 0);
});

test('clear cancels pending decryption and removes the vault without restoring old login cookies', async t => {
  const f = await fixture(t, [login()]);
  const entered = deferred(), gate = deferred();
  f.safeStorage.isAsyncEncryptionAvailable = async () => true;
  f.safeStorage.encryptStringAsync = async value => f.safeStorage.encryptString(value);
  f.safeStorage.decryptStringAsync = async value => {
    entered.resolve();
    await gate.promise;
    return { result: f.safeStorage.decryptString(value), shouldReEncrypt: false };
  };
  await f.vault.save();
  f.session.cookies.values = [];
  const restoring = f.vault.restore();
  await entered.promise;
  const clearing = f.vault.clear();
  gate.resolve();
  await Promise.all([restoring, clearing]);
  assert.equal(f.session.cookies.setCalls.length, 0);
  assert.equal(f.session.cookies.listenerCount('changed'), 0);
  assert.deepEqual(await fs.readdir(f.directory), []);
  assert.deepEqual(f.statuses.at(-1), { saved: false, available: true });
});

test('restore revalidates the allowlist even for decryptable files', async t => {
  const f = await fixture(t);
  const payload = { version: 1, cookies: [
    login(),
    { ...login('WRONG-DOMAIN'), domain: '.steamcommunity.com.evil.example' },
    { ...login('WRONG-NAME'), name: 'arbitraryPassword' },
    { ...login('TOO-LARGE'), name: 'sessionid', value: 'x'.repeat(32769) },
    { ...login('EXPIRED'), name: 'browserid', expirationDate: 1 }
  ] };
  await fs.writeFile(f.filename, Buffer.concat([Buffer.from('CS2-STEAM-VAULT:1:S\n'), f.safeStorage.encryptString(JSON.stringify(payload))]));
  assert.deepEqual(await f.vault.restore(), { saved: true, available: true });
  assert.equal(f.session.cookies.setCalls.length, 1);
  assert.equal(f.session.cookies.setCalls[0].value, 'SECRET-STEAM-LOGIN');
  assert.doesNotMatch(JSON.stringify(f.statuses), /SECRET|WRONG|EXPIRED/);
});

test('unexpected decryptor rejection values also return only sanitized status', async t => {
  const f = await fixture(t, [login()]);
  await f.vault.save();
  f.session.cookies.values = [];
  f.safeStorage.decryptString = () => { throw null; };
  const status = await f.vault.restore();
  assert.equal(status.saved, false);
  assert.match(status.error, /重新登录/);
  assert.deepEqual(Object.keys(status).sort(), ['available', 'error', 'saved']);
  assert.equal(f.session.cookies.setCalls.length, 0);
  assert.equal(f.session.cookies.listenerCount('changed'), 0);
});
