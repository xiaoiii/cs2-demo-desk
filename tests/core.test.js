const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { httpURL, safeFilename, uniquePath, fileKind, inspectFile, parseLinks, sourceOf, shareCode, atomicSave } = require('../src/core');

test('accepts HTTP/HTTPS and rejects credentials, script and local file URLs', () => {
  assert.equal(httpURL(' https://www.hltv.org/download/demo/123 '), 'https://www.hltv.org/download/demo/123');
  for (const url of ['javascript:alert(1)', 'file:///C:/secret', 'ftp://example.com/a.dem', 'https://user:pass@example.com', 'bad']) assert.throws(() => httpURL(url));
});
test('Windows filenames cannot escape the save folder or use reserved device names', () => {
  assert.equal(safeFilename('../../evil.dem'), 'evil.dem');
  assert.equal(safeFilename('C:\\temp\\map.dem'), 'map.dem');
  for (const value of ['CON', 'nul.dem', 'LPT1.dem', 'a:b?.dem', '..']) assert.doesNotMatch(safeFilename(value), /[<>:"/\\|?*]|^(?:CON|nul|LPT1)(?:\.|$)/i);
});
test('deduplicates pasted links and handles signed download URLs', () => {
  assert.equal(parseLinks('https://cdn.example/map.dem?token=a\nhttps://cdn.example/map.dem?token=a').length, 1);
  assert.equal(parseLinks('http://replay123.valve.net/730/test.dem.bz2')[0].category, 'personal');
  assert.equal(sourceOf('https://valve.net.evil.example/a.dem'), 'tournament');
  assert.throws(() => parseLinks('CSGO-aaaaa-bbbbb-ccccc-ddddd-eeeee'), /分享码/);
});
test('recognizes demo/archive signatures, rejects disguised HTML', () => {
  assert.equal(fileKind(Buffer.from('PBDEMS2\0data')), 'dem');
  assert.equal(fileKind(Buffer.from('HL2DEMO\0data')), 'dem');
  assert.equal(fileKind(Buffer.from('BZh9data')), 'bz2');
  assert.equal(fileKind(Buffer.from([80,75,3,4,0,0])), 'zip');
  assert.equal(fileKind(Buffer.from([82,97,114,33,26,7,1,0])), 'rar');
  assert.equal(fileKind(Buffer.from([55,122,188,175,39,28])), '7z');
  assert.equal(fileKind(Buffer.from('<!DOCTYPE html>')), null);
  assert.equal(fileKind(Buffer.from('BZh0bad')), null);
});
test('avoids collisions both on disk and with in-flight tasks', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demodesk-core-'));
  t.after(() => fs.rmSync(dir, { recursive:true, force:true }));
  fs.writeFileSync(path.join(dir, 'map.dem'), 'PBDEMS2\0test');
  assert.equal(uniquePath(dir, 'map.dem', [path.join(dir, 'map (1).dem')]), path.join(dir, 'map (2).dem'));
  assert.equal(inspectFile(path.join(dir, 'map.dem')), 'dem');
});
test('extracts only the exact match code for Steam handoff', () => {
  assert.equal(shareCode('steam://rungame/730/x/+csgo_download_match%20CSGO-aaaaa-bbbbb-ccccc-ddddd-eeeee'), 'CSGO-aaaaa-bbbbb-ccccc-ddddd-eeeee');
  assert.throws(() => shareCode('CSGO-123'), /完整/);
});
test('persists valid JSON atomically', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demodesk-save-'));
  t.after(() => fs.rmSync(dir, { recursive:true, force:true }));
  const file = path.join(dir,'library.json'); atomicSave(file,{items:[1]}); atomicSave(file,{items:[2]});
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), {items:[2]}); assert.equal(fs.existsSync(file+'.tmp'),false);
});
