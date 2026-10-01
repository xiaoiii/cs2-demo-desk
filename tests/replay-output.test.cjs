const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { isDirectory, gameReplayDirectory, publishDemos } = require('../src/replay-output');
const payload = Buffer.concat([Buffer.from('PBDEMS2\0'), Buffer.alloc(100)]);
test('detect existing CS2 replay directory, never invent missing destinations', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-detect-'));
  const game = path.join(root, 'game/bin/win64/cs2.exe');
  fs.mkdirSync(path.dirname(game), { recursive:true });fs.writeFileSync(game, '');
  assert.equal(gameReplayDirectory(game), '');
  const replays = path.join(root, 'game/csgo/replays');fs.mkdirSync(replays, { recursive:true });
  assert.equal(gameReplayDirectory(game), replays);
  assert.equal(gameReplayDirectory(path.join(root, 'absent.exe')), '');
  assert.equal(isDirectory(game), false);
});
test('concurrent same-name DEM output preserves existing files and gives unique paths', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-output-'));
  const folder = path.join(root, '中文录像');fs.mkdirSync(folder);
  const source = path.join(root, 'match.dem');fs.writeFileSync(source, payload);
  fs.writeFileSync(path.join(folder, 'match.dem'), 'original');
  const results = await Promise.all(Array.from({length:5}, () => publishDemos([source], folder)));
  assert.equal(new Set(results.flat()).size, 5);
  assert.equal(fs.readFileSync(path.join(folder, 'match.dem'), 'utf8'), 'original');
  for (const file of results.flat()) assert.deepEqual(fs.readFileSync(file), payload);
  assert.deepEqual(fs.readFileSync(source), payload);
});
test('invalid multi-file output rolls back this operation, and missing folder errors preserve source', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-failure-'));
  const folder = path.join(root, 'replays');fs.mkdirSync(folder);
  const good = path.join(root, 'no-extension'), bad = path.join(root, 'bad.dem');
  fs.writeFileSync(good, payload);fs.writeFileSync(bad, 'invalid');
  await assert.rejects(publishDemos([good,bad], folder), /原下载文件已保留/);
  assert.deepEqual(fs.readdirSync(folder), []);
  await assert.rejects(publishDemos([good], path.join(root, 'absent')), /不存在/);
  const files = await publishDemos([good], folder);
  assert.equal(path.basename(files[0]), 'no-extension.dem');
});
