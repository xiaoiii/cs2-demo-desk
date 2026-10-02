const fs = require('node:fs');
const path = require('node:path');

// Read-only VPK v1/v2 container support. No game package is ever rewritten.
// Format reference: https://github.com/ValveResourceFormat/ValvePak
const SIGNATURE = 0x55aa1234;
const INLINE_ARCHIVE = 0x7fff;
const MAX_TREE_BYTES = 64 * 1024 * 1024;
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const privateEntries = new WeakMap();
const crcTable = Uint32Array.from({length:256}, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = (value & 1) ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  return value >>> 0;
});

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function readRange(filename, offset, length) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) throw new Error('VPK 数据范围无效。');
  const descriptor = fs.openSync(filename, 'r');
  try {
    const size = fs.fstatSync(descriptor).size;
    if (offset > size || length > size - offset) throw new Error('VPK 数据超出文件边界，游戏资源可能已损坏。');
    const buffer = Buffer.alloc(length);
    let done = 0;
    while (done < length) {
      const count = fs.readSync(descriptor, buffer, done, length - done, offset + done);
      if (!count) throw new Error('VPK 数据读取不完整。');
      done += count;
    }
    return buffer;
  } finally { fs.closeSync(descriptor); }
}

function readHeader(filename) {
  const base = readRange(filename, 0, 12);
  if (base.readUInt32LE(0) !== SIGNATURE) throw new Error('文件不是受支持的 Valve VPK。');
  const version = base.readUInt32LE(4), treeSize = base.readUInt32LE(8);
  if (version !== 1 && version !== 2) throw new Error(`不支持 VPK 版本 ${version}。`);
  if (!treeSize || treeSize > MAX_TREE_BYTES) throw new Error('VPK 索引大小无效。');
  const headerSize = version === 2 ? 28 : 12;
  let fileDataSize = fs.statSync(filename).size - headerSize - treeSize;
  if (version === 2) fileDataSize = readRange(filename, 12, 16).readUInt32LE(0);
  if (fileDataSize < 0) throw new Error('VPK 索引超出文件边界。');
  const dataOffset = headerSize + treeSize;
  if (dataOffset > fs.statSync(filename).size || fileDataSize > fs.statSync(filename).size - dataOffset) throw new Error('VPK 内嵌数据范围无效。');
  return {version, treeSize, headerSize, dataOffset, fileDataSize};
}

function packagePath(value) {
  const normalized = value.replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || /[:\x00-\x1f]/.test(normalized) || normalized.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('VPK 中包含无效的资源路径。');
  return normalized;
}

function readDirectory(filename) {
  const directory = path.resolve(filename), header = readHeader(directory);
  const tree = readRange(directory, header.headerSize, header.treeSize);
  let cursor = 0;
  function string() {
    const end = tree.indexOf(0, cursor);
    if (end < 0 || end - cursor > 16384) throw new Error('VPK 索引字符串不完整。');
    const result = tree.toString('utf8', cursor, end);
    cursor = end + 1;
    return result;
  }
  const entries = [], paths = new Set();
  for (;;) {
    const extension = string();
    if (!extension) break;
    if (/[\\/\x00-\x1f:]/.test(extension)) throw new Error('VPK 扩展名无效。');
    for (;;) {
      const folder = string();
      if (!folder) break;
      for (;;) {
        const name = string();
        if (!name) break;
        if (/[\\/]/.test(name)) throw new Error('VPK 文件名无效。');
        if (cursor + 18 > tree.length) throw new Error('VPK 条目信息不完整。');
        const crc = tree.readUInt32LE(cursor), preloadBytes = tree.readUInt16LE(cursor + 4);
        const archiveIndex = tree.readUInt16LE(cursor + 6), offset = tree.readUInt32LE(cursor + 8), length = tree.readUInt32LE(cursor + 12);
        if (tree.readUInt16LE(cursor + 16) !== 0xffff || archiveIndex > INLINE_ARCHIVE) throw new Error('VPK 条目格式无效。');
        cursor += 18;
        if (preloadBytes > tree.length - cursor) throw new Error('VPK 预载数据不完整。');
        const preload = Buffer.from(tree.subarray(cursor, cursor + preloadBytes));
        cursor += preloadBytes;
        const resourcePath = packagePath(`${folder === ' ' ? '' : `${folder}/`}${name}${extension === ' ' ? '' : `.${extension}`}`);
        const key = resourcePath.toLowerCase();
        if (paths.has(key)) throw new Error('VPK 索引存在重复资源路径。');
        paths.add(key);
        if (archiveIndex === INLINE_ARCHIVE && (offset > header.fileDataSize || length > header.fileDataSize - offset)) throw new Error('VPK 内嵌条目超出数据区边界。');
        const entry = Object.freeze({path:resourcePath, extension:extension === ' ' ? '' : extension, crc, preloadBytes, archiveIndex, offset, length, totalLength:preloadBytes + length});
        privateEntries.set(entry, {directory, header, preload});
        entries.push(entry);
        if (entries.length > 1_000_000) throw new Error('VPK 条目数量超过支持范围。');
      }
    }
  }
  if (cursor !== tree.length && tree.subarray(cursor).some(byte => byte !== 0)) throw new Error('VPK 索引尾部数据无效。');
  return entries;
}

function readEntry(filename, entry, options = {}) {
  const directory = path.resolve(filename), privateEntry = privateEntries.get(entry);
  if (!privateEntry || privateEntry.directory !== directory) throw new Error('请使用此 VPK 的 readDirectory 返回的条目。');
  const maxBytes = options.maxBytes ?? MAX_ENTRY_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || entry.totalLength > maxBytes) throw new Error('VPK 资源超过允许读取的大小。');
  let source = directory, offset = entry.offset;
  if (entry.archiveIndex === INLINE_ARCHIVE) offset += privateEntry.header.dataOffset;
  else if (entry.length) {
    if (!/_dir\.vpk$/i.test(directory)) throw new Error('分卷 VPK 必须从 _dir.vpk 索引打开。');
    source = directory.replace(/_dir\.vpk$/i, `_${String(entry.archiveIndex).padStart(3,'0')}.vpk`);
  }
  const payload = entry.length ? readRange(source, offset, entry.length) : Buffer.alloc(0);
  const result = Buffer.concat([privateEntry.preload, payload], entry.totalLength);
  if (options.validateCrc !== false && crc32(result) !== entry.crc) throw new Error('VPK 资源 CRC 校验失败，游戏资源可能已损坏。');
  return result;
}

module.exports = {readDirectory, readEntry, crc32};
