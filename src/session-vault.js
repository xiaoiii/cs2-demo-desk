'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const DOMAINS = ['steamcommunity.com', 'steampowered.com'];
const COOKIE_NAMES = new Set(['steamLoginSecure', 'steamRememberLogin', 'sessionid', 'steamCountry', 'browserid']);
const SAME_SITE = new Set(['unspecified', 'no_restriction', 'lax', 'strict']);
const HEADER = 'CS2-STEAM-VAULT:1:';
const MAX_FILE_SIZE = 1024 * 1024;

function approvedCookie(cookie, includeExpired = false) {
  if (!cookie || typeof cookie !== 'object' || typeof cookie.domain !== 'string') return null;
  const domain = cookie.domain.toLowerCase();
  const host = domain.replace(/^\./, '');
  if (!/^[a-z0-9.-]+$/.test(host) || !DOMAINS.some(root => host === root || host.endsWith(`.${root}`))) return null;
  if (!COOKIE_NAMES.has(cookie.name) && !/^(?:steamMachineAuth|SteamMachineAuth)\d{17}$/.test(cookie.name || '')) return null;
  if (typeof cookie.value !== 'string' || cookie.value.length > 32768) return null;
  if (cookie.expirationDate !== undefined && (!Number.isFinite(cookie.expirationDate) || (!includeExpired && cookie.expirationDate <= Date.now() / 1000))) return null;
  const result = {
    domain,
    hostOnly: typeof cookie.hostOnly === 'boolean' ? cookie.hostOnly : !domain.startsWith('.'),
    name: cookie.name,
    value: cookie.value,
    path: typeof cookie.path === 'string' && cookie.path.startsWith('/') ? cookie.path : '/',
    secure: cookie.secure === true,
    httpOnly: cookie.httpOnly === true
  };
  if (cookie.expirationDate !== undefined) result.expirationDate = cookie.expirationDate;
  if (SAME_SITE.has(cookie.sameSite)) result.sameSite = cookie.sameSite;
  return result;
}

function cookieKey(cookie) {
  return `${cookie.domain.replace(/^\./, '')}\n${cookie.path}\n${cookie.name}`;
}

function hasLogin(cookies) {
  return cookies.some(cookie => cookie.name === 'steamLoginSecure' && cookie.value.length > 0);
}

/**
 * Stores only the Steam cookie allowlist, encrypted by Electron's OS-backed
 * safeStorage. On Windows this uses DPAPI for the current Windows user; it does
 * not protect against other applications running as that same user.
 *
 * Call restore() before opening Steam pages, then start(). clear() suspends
 * saving until start() is called again, so logout cannot recreate the vault.
 * stop() detaches automatic saving; an explicit final save() is still allowed.
 * No method returns credentials or propagates credential-bearing error text.
 */
function createSessionVault({ session, safeStorage, filename, onStatus = () => {} }) {
  if (!session?.cookies || !safeStorage || !filename) throw new TypeError('Session vault configuration is incomplete.');
  let queue = Promise.resolve();
  let timer = null;
  let active = false;
  let listenerGeneration = 0;
  let cleared = false;
  let generation = 0;
  let status = { saved: false, available: false };

  function report(next) {
    status = { saved: !!next.saved, available: !!next.available };
    if (next.error) status.error = next.error;
    try { onStatus({ ...status }); } catch { /* UI callbacks must not affect credential storage. */ }
    return { ...status };
  }

  function enqueue(operation) {
    const result = queue.then(operation, operation);
    queue = result.catch(() => {});
    return result;
  }

  async function encryptionMode(preferred) {
    try {
      if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend?.() === 'basic_text') return null;
    } catch { return null; }
    try {
      // Electron 41 exposes the synchronous API; newer versions also support
      // async encryption. A failed optional async probe must not disable DPAPI.
      if (preferred !== 'S' && typeof safeStorage.isAsyncEncryptionAvailable === 'function' &&
          typeof safeStorage.encryptStringAsync === 'function' && typeof safeStorage.decryptStringAsync === 'function' &&
          await safeStorage.isAsyncEncryptionAvailable()) return 'A';
    } catch { /* Fall back only when the file does not require async encryption. */ }
    try {
      if (preferred !== 'A' && safeStorage.isEncryptionAvailable?.() &&
          typeof safeStorage.encryptString === 'function' && typeof safeStorage.decryptString === 'function') return 'S';
    } catch { /* Availability failures are deliberately not logged. */ }
    return null;
  }

  async function getCookies() {
    const groups = await Promise.all(DOMAINS.map(domain => session.cookies.get({ domain })));
    const cookies = new Map();
    for (const raw of groups.flat()) {
      const cookie = approvedCookie(raw);
      if (cookie) cookies.set(cookieKey(cookie), cookie);
    }
    return [...cookies.values()].slice(0, 128);
  }

  function detach() {
    listenerGeneration += 1;
    active = false;
    if (timer) clearTimeout(timer);
    timer = null;
    session.cookies.removeListener('changed', onChanged);
  }

  function onChanged(_event, cookie) {
    if (!active || cleared || !approvedCookie(cookie, true)) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void save();
    }, 300);
    timer.unref?.();
  }

  function save() {
    if (timer) clearTimeout(timer);
    timer = null;
    const revision = generation;
    return enqueue(async () => {
      if (cleared || revision !== generation) return { ...status };
      const mode = await encryptionMode();
      if (cleared || revision !== generation) return { ...status };
      if (!mode) return report({ saved: false, available: false, error: 'Windows 安全加密不可用，无法保留登录状态，请下次重新登录。' });
      let temporary;
      try {
        const cookies = await getCookies();
        if (cleared || revision !== generation) return { ...status };
        const payload = JSON.stringify({ version: 1, cookies });
        if (Buffer.byteLength(payload) > MAX_FILE_SIZE - 1024) throw new Error('Vault too large');
        const encrypted = mode === 'A' ? await safeStorage.encryptStringAsync(payload) : safeStorage.encryptString(payload);
        if (!Buffer.isBuffer(encrypted) || !encrypted.length) throw new Error('Invalid ciphertext');
        if (cleared || revision !== generation) return { ...status };
        await fs.mkdir(path.dirname(filename), { recursive: true });
        temporary = `${filename}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
        const handle = await fs.open(temporary, 'wx', 0o600);
        try {
          await handle.writeFile(Buffer.concat([Buffer.from(`${HEADER}${mode}\n`), encrypted]));
          await handle.sync();
        } finally {
          await handle.close();
        }
        if (cleared || revision !== generation) return { ...status };
        await fs.rename(temporary, filename);
        temporary = null;
        if (cleared || revision !== generation) return { ...status };
        await session.cookies.flushStore();
        if (cleared || revision !== generation) return { ...status };
        return report({ saved: hasLogin(cookies), available: true });
      } catch {
        if (cleared || revision !== generation) return { ...status };
        return report({ saved: false, available: true, error: '登录状态加密保存失败，请检查本机存储空间或重新登录。' });
      } finally {
        if (temporary) await fs.unlink(temporary).catch(() => {});
      }
    });
  }

  function restore() {
    const revision = generation;
    return enqueue(async () => {
      if (cleared || revision !== generation) return { ...status };
      const changed = new Set();
      const trackChanges = (_event, cookie) => {
        const approved = approvedCookie(cookie, true);
        if (approved) changed.add(cookieKey(approved));
      };
      // Track changes before decryption as well: a logout or token refresh while
      // the OS decryptor is pending must never resurrect a saved older cookie.
      session.cookies.on('changed', trackChanges);
      try {
        const available = !!await encryptionMode();
        if (cleared || revision !== generation) return { ...status };
        if (!available) return report({ saved: false, available: false, error: 'Windows 安全加密不可用，无法恢复登录状态，请重新登录。' });
        const stat = await fs.stat(filename);
        if (!stat.isFile() || stat.size > MAX_FILE_SIZE) throw new Error('Invalid vault');
        const data = await fs.readFile(filename);
        if (data.length > MAX_FILE_SIZE) throw new Error('Invalid vault');
        const headerLength = Buffer.byteLength(`${HEADER}S\n`);
        const mode = data.subarray(0, headerLength).toString('ascii') === `${HEADER}A\n` ? 'A' : 'S';
        if (data.subarray(0, headerLength).toString('ascii') !== `${HEADER}${mode}\n`) throw new Error('Invalid vault');
        if (!await encryptionMode(mode)) throw new Error('Encryption provider unavailable');
        const decrypted = mode === 'A'
          ? (await safeStorage.decryptStringAsync(data.subarray(headerLength))).result
          : safeStorage.decryptString(data.subarray(headerLength));
        if (typeof decrypted !== 'string') throw new Error('Invalid plaintext');
        const payload = JSON.parse(decrypted);
        if (payload.version !== 1 || !Array.isArray(payload.cookies) || payload.cookies.length > 128) throw new Error('Invalid vault');
        const cookies = payload.cookies.map(cookie => approvedCookie(cookie)).filter(Boolean);
        let failed = false;
        for (const cookie of cookies) {
          if (cleared || revision !== generation) return { ...status };
          const current = await getCookies();
          const key = cookieKey(cookie);
          // A currently present or concurrently modified cookie wins over the saved copy.
          if (changed.has(key) || current.some(value => cookieKey(value) === key)) continue;
          if (cleared || revision !== generation) return { ...status };
          if (!approvedCookie(cookie)) continue;
          const details = { ...cookie, url: `https://${cookie.domain.replace(/^\./, '')}${cookie.path}` };
          delete details.hostOnly;
          if (cookie.hostOnly) delete details.domain;
          try { await session.cookies.set(details); } catch { failed = true; }
        }
        if (cleared || revision !== generation) return { ...status };
        await session.cookies.flushStore();
        if (cleared || revision !== generation) return { ...status };
        return report({ saved: hasLogin(cookies) && !failed, available: true,
          ...(failed ? { error: '部分 Steam 登录状态未能恢复，如登录失效请重新登录。' } : {}) });
      } catch (error) {
        if (cleared || revision !== generation) return { ...status };
        if (error?.code === 'ENOENT') return report({ saved: false, available: true });
        return report({ saved: false, available: true, error: '本机保存的登录状态无法恢复，请重新登录。' });
      } finally {
        if (trackChanges) session.cookies.removeListener('changed', trackChanges);
      }
    });
  }

  function start() {
    const listenerRevision = listenerGeneration;
    return enqueue(async () => {
      if (listenerRevision !== listenerGeneration) return { ...status };
      cleared = false;
      if (!active) {
        active = true;
        session.cookies.on('changed', onChanged);
      }
      const available = !!await encryptionMode();
      if (listenerRevision !== listenerGeneration) return { ...status };
      return report({ ...status, available,
        ...(!available ? { saved: false, error: 'Windows 安全加密不可用，无法保留登录状态，请下次重新登录。' } : {}) });
    });
  }

  function clear() {
    generation += 1;
    cleared = true;
    detach();
    return enqueue(async () => {
      try {
        await fs.unlink(filename).catch(error => { if (error.code !== 'ENOENT') throw error; });
        return report({ saved: false, available: !!await encryptionMode() });
      } catch {
        return report({ saved: false, available: !!await encryptionMode(), error: '本机登录状态文件未能删除，请检查文件权限。' });
      }
    });
  }

  async function stop() {
    detach();
    await queue;
    return { ...status };
  }

  return { restore, start, save, clear, stop };
}

module.exports = { createSessionVault };
