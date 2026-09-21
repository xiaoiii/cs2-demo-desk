const fs = require('node:fs');
const path = require('node:path');

function createSecretStore({ safeStorage, filename }) {
  let value = null;
  function available() { try { return Boolean(safeStorage?.isEncryptionAvailable()); } catch { return false; } }
  function load() {
    value = null;
    if (!fs.existsSync(filename)) return null;
    if (!available()) throw new Error('Windows 本机加密不可用，无法读取完美平台凭证。');
    try { value = JSON.parse(safeStorage.decryptString(fs.readFileSync(filename))); return value; }
    catch { throw new Error('完美平台凭证无法解密，请清除后重新保存。'); }
  }
  function save(next) {
    if (!available()) throw new Error('Windows 本机加密不可用，不能保存完美平台凭证。');
    const encrypted = safeStorage.encryptString(JSON.stringify(next));
    fs.mkdirSync(path.dirname(filename), { recursive:true });
    fs.writeFileSync(`${filename}.tmp`, encrypted); fs.renameSync(`${filename}.tmp`, filename); value = next; return value;
  }
  function clear() { value = null; try { fs.unlinkSync(filename); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  return { available, load, save, clear, get:() => value };
}
module.exports = { createSecretStore };
