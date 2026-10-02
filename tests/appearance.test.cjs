const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {readDirectory, readEntry, crc32} = require('../src/valve-package');

function fixture(t, {version = 2, archiveIndex = 32767, preload = 'HEAD', payload = 'BODY', folder = 'resource/overviews', badCrc = false} = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'demodesk-vpk-'));
  t.after(() => fs.rmSync(directory, {recursive:true, force:true}));
  const filename = path.join(directory, 'pak01_dir.vpk');
  const name = Buffer.from('txt\0' + folder + '\0de_test\0');
  const metadata = Buffer.alloc(18);
  metadata.writeUInt32LE(badCrc ? 0 : crc32(Buffer.from(preload + payload)), 0);
  metadata.writeUInt16LE(Buffer.byteLength(preload), 4);
  metadata.writeUInt16LE(archiveIndex, 6);
  metadata.writeUInt32LE(0, 8);
  metadata.writeUInt32LE(Buffer.byteLength(payload), 12);
  metadata.writeUInt16LE(65535, 16);
  const tree = Buffer.concat([name, metadata, Buffer.from(preload), Buffer.alloc(3)]);
  const header = Buffer.alloc(version === 2 ? 28 : 12);
  header.writeUInt32LE(0x55aa1234, 0); header.writeUInt32LE(version, 4); header.writeUInt32LE(tree.length, 8);
  const body = archiveIndex === 32767 ? Buffer.from(payload) : Buffer.alloc(0);
  if (version === 2) header.writeUInt32LE(body.length, 12);
  fs.writeFileSync(filename, Buffer.concat([header, tree, body]));
  if (archiveIndex !== 32767) fs.writeFileSync(path.join(directory, `pak01_${String(archiveIndex).padStart(3,'0')}.vpk`), payload);
  return {filename, directory, tree, header};
}

test('VPK v1/v2 inline data preserves preload bytes and verifies CRC', t => {
  for (const version of [1,2]) {
    const {filename} = fixture(t, {version});
    const entries = readDirectory(filename);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].path, 'resource/overviews/de_test.txt');
    assert.equal(entries[0].preloadBytes, 4);
    assert.equal(readEntry(filename, entries[0]).toString(), 'HEADBODY');
  }
});

test('VPK reads numbered chunks, including chunk IDs above 999', t => {
  for (const archiveIndex of [0,42,1050]) {
    const {filename} = fixture(t, {archiveIndex});
    assert.equal(readEntry(filename, readDirectory(filename)[0]).toString(), 'HEADBODY');
  }
});

test('VPK refuses corrupt data, truncated chunks and oversized allocations', t => {
  const corrupt = fixture(t, {badCrc:true});
  assert.throws(() => readEntry(corrupt.filename, readDirectory(corrupt.filename)[0]), /CRC/);
  const truncated = fixture(t, {archiveIndex:0});
  fs.writeFileSync(path.join(truncated.directory, 'pak01_000.vpk'), 'B');
  const entry = readDirectory(truncated.filename)[0];
  assert.throws(() => readEntry(truncated.filename, entry), /边界/);
  assert.throws(() => readEntry(truncated.filename, entry, {maxBytes:1}), /大小/);
  assert.throws(() => readEntry(truncated.filename, {...entry}), /readDirectory/);
});

test('VPK rejects unsafe paths, truncated metadata and invalid inline offsets', t => {
  const unsafe = fixture(t, {folder:'../outside'});
  assert.throws(() => readDirectory(unsafe.filename), /路径/);
  const truncated = fixture(t);
  fs.truncateSync(truncated.filename, 15);
  assert.throws(() => readDirectory(truncated.filename), /边界/);
  const wrongOffset = fixture(t);
  const data = fs.readFileSync(wrongOffset.filename);
  const metadataOffset = 28 + Buffer.byteLength('txt\0resource/overviews\0de_test\0');
  data.writeUInt32LE(1000, metadataOffset + 8);
  fs.writeFileSync(wrongOffset.filename, data);
  assert.throws(() => readDirectory(wrongOffset.filename), /边界/);
});
