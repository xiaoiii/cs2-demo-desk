const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scanDemoVoice, activityAt, createVoiceService, snappyDecode } = require('../src/studio-voice');

// Fixtures use the published CS2 demo/netmessage protobuf and bitstream formats.
function varint(value) {
  const bytes = [];
  do { const byte = value % 128; value = Math.floor(value / 128); bytes.push(byte | (value ? 128 : 0)); } while (value);
  return Buffer.from(bytes);
}
const fieldBytes = (number, bytes) => Buffer.concat([varint(number * 8 + 2), varint(bytes.length), bytes]);
const fieldInt = (number, value) => Buffer.concat([varint(number * 8), varint(value)]);
function steamField(id) { const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(BigInt(id)); return Buffer.concat([Buffer.from([33]), bytes]); }
function voice(id, messageTick, payload = Buffer.from([1, 2, 3])) {
  const level = Buffer.alloc(4); level.writeFloatLE(0.75);
  const audio = Buffer.concat([fieldInt(1, 2), fieldBytes(2, payload), fieldInt(5, 48000), Buffer.from([77]), level]);
  return Buffer.concat([fieldBytes(1, audio), steamField(id), fieldInt(6, messageTick), fieldInt(8, 3)]);
}
function packet(messages) {
  const bits = [];
  const put = (value, count) => { for (let i = 0; i < count; i++) bits.push((Math.floor(value / 2 ** i) % 2)); };
  for (const [type, data, declaredLength] of messages) {
    if (type < 16) put(type, 6);
    else if (type < 256) { put((type % 16) + 16, 6); put(Math.floor(type / 16), 4); }
    else if (type < 4096) { put((type % 16) + 32, 6); put(Math.floor(type / 16), 8); }
    else { put((type % 16) + 48, 6); put(Math.floor(type / 16), 28); }
    for (const byte of varint(declaredLength ?? data.length)) put(byte, 8);
    for (const byte of data) put(byte, 8);
  }
  const buffer = Buffer.alloc(Math.ceil(bits.length / 8));
  bits.forEach((bit, index) => { buffer[index >>> 3] |= bit << (index & 7); });
  return fieldBytes(3, buffer);
}
function literalSnappy(data) {
  if (data.length > 256) throw new Error('fixture literal is too large');
  const tag = data.length <= 60 ? Buffer.from([(data.length - 1) * 4]) : Buffer.from([240, data.length - 1]);
  return Buffer.concat([varint(data.length), tag, data]);
}
const frame = (command, tick, data) => Buffer.concat([varint(command), varint(tick >>> 0), varint(data.length), data]);
function demo(frames, stop = true) {
  const shortHeader = Buffer.alloc(16); shortHeader.write('PBDEMS2\0', 'ascii');
  return Buffer.concat([shortHeader, frame(1, 0xffffffff, fieldBytes(1, Buffer.from('PBDEMS2'))), ...frames, ...(stop ? [frame(0, 1200, Buffer.alloc(0))] : [])]);
}
function fixture(t, bytes) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'demodesk-voice-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const filename = path.join(folder, '语音.dem'); fs.writeFileSync(filename, bytes); return filename;
}

test('independent voice scanner preserves SteamID/ticks through compressed, unaligned and full packets', t => {
  const id = '76561199999999999', other = '76561198888888888';
  const net = packet([[16, Buffer.from([8, 9])], [47, voice(id, 300)], [600, Buffer.from([1])], [50000, Buffer.from([2])]]);
  const filename = fixture(t, demo([
    frame(71, 100, literalSnappy(net)),
    frame(7, 110, packet([[47, voice(id, 310)]])),
    frame(13, 500, fieldBytes(2, packet([[47, voice(other, 700)]])))
  ]));
  const result = scanDemoVoice(filename);
  assert.equal(result.packetCount, 3);
  assert.equal(result.source, 'svc_VoiceData');
  assert.equal(result.audioDecoded, false);
  assert.equal(result.players.length, 2);
  assert.equal(result.players[0].steamid, id);
  assert.equal(result.players[0].segments.length, 1);
  assert.equal(result.packets[0].tick, 100);
  assert.equal(result.packets[0].messageTick, 300);
  assert.equal(result.packets[0].format, 2);
  assert.equal(result.packets[0].sampleRate, 48000);
  assert.equal(result.packets[0].level, 0.75);
  assert.deepEqual(activityAt(result, 105).map(item => item.steamid), [id]);
  assert.deepEqual(activityAt(result, 250), []);
  assert.deepEqual(activityAt(result, 500).map(item => item.steamid), [other]);
});

test('voice scanner returns no speakers when demo has no recorded voice and uses server tick rate', t => {
  const interval = Buffer.alloc(4); interval.writeFloatLE(1 / 128);
  const server = Buffer.concat([Buffer.from([109]), interval]);
  const filename = fixture(t, demo([frame(7, 64, packet([[40, server], [55, Buffer.from([1, 2, 3])]]))]));
  const result = scanDemoVoice(filename);
  assert.equal(result.tickRate, 128);
  assert.equal(result.packetCount, 0);
  assert.deepEqual(result.players, []);
});

test('Snappy decoder handles all backreference forms and overlapping copies with strict bounds', () => {
  // Output length 6, literal ab, offset 2 / len 4 in each supported copy format.
  for (const copy of [[1, 2], [14, 2, 0], [15, 2, 0, 0, 0]]) {
    const encoded = Buffer.from([6, 4, 97, 98, ...copy]);
    assert.equal(snappyDecode(encoded).toString(), 'ababab');
  }
  assert.throws(() => snappyDecode(Buffer.from([5, 4, 97, 98, 1, 2])), /回引用/);
  assert.deepEqual(snappyDecode(literalSnappy(Buffer.alloc(201, 42))), Buffer.alloc(201, 42));
  assert.throws(() => snappyDecode(Buffer.from([6, 4, 97, 98, 1, 0])), /回引用/);
  assert.throws(() => snappyDecode(Buffer.from([3, 4, 97, 98])), /长度不匹配/);
  assert.throws(() => snappyDecode(Buffer.from([128, 128, 128, 128, 1])), /内存限制/);
});

test('voice parser rejects truncation and resource-limit violations before large allocation', t => {
  const id = '76561199999999999';
  const valid = fixture(t, demo([frame(7, 100, packet([[47, voice(id, 100)]]))]));
  for (const limits of [{ fileBytes: 4 }, { frameBytes: 4 }, { voicePackets: 0 }, { voiceBytes: 1 }, { frames: 1 }, { messages: 0 }]) {
    assert.throws(() => scanDemoVoice(valid, { limits }), /限制/);
  }
  assert.throws(() => scanDemoVoice(fixture(t, Buffer.from('PBDEMS2\0'))), /格式无效/);
  assert.throws(() => scanDemoVoice(fixture(t, demo([], false))), /DEM_Stop/);
  assert.throws(() => scanDemoVoice(fixture(t, demo([frame(7, 10, packet([[47, Buffer.alloc(0), 100]]))]))), /消息长度超出帧/);
  assert.throws(() => scanDemoVoice(fixture(t, demo([frame(71, 10, varint(1000000000))]))), /内存限制/);
  assert.throws(() => scanDemoVoice(fixture(t, demo([Buffer.from([7, 1, 255, 255, 255, 255, 15])]))), /限制/);
});

test('voice service isolates errors in a child process and remains usable for the next demo', async t => {
  const service = createVoiceService({ timeoutMs: 10000 }); t.after(() => service.stop());
  const invalid = fixture(t, Buffer.from('broken'));
  await assert.rejects(service.analyze(invalid), /格式无效/);
  assert.equal(service.busy, false);
  const valid = fixture(t, demo([frame(7, 100, packet([[47, voice('76561199999999999', 100)]]))]));
  const result = await service.analyze(valid);
  assert.equal(result.packetCount, 1);
  assert.equal(result.players[0].steamid, '76561199999999999');
  assert.equal(service.busy, false);
  assert.equal(await service.analyze(valid), result);
});

test('real CS2 DEM speech packets are parsed in a child process without original Pro code', { skip: !process.env.DEMODESK_REAL_DEMO }, async t => {
  const service = createVoiceService(); t.after(() => service.stop());
  const result = await service.analyze(path.resolve(process.env.DEMODESK_REAL_DEMO));
  assert.ok(result.frames > 100);
  assert.ok(result.messages > result.frames);
  assert.ok(result.maxTick > 1000);
  assert.ok(result.tickRate >= 16 && result.tickRate <= 256);
  assert.equal(result.audioDecoded, false);
  assert.equal(result.packetCount, result.packets.length);
  for (const packet of result.packets) assert.ok(packet.bytes > 0 && Number.isInteger(packet.tick) && /^\d*$/.test(packet.steamid));
  t.diagnostic(`Frames ${result.frames}; network messages ${result.messages}; voice packets ${result.packetCount}; speakers ${result.players.length}; tick rate ${result.tickRate}.`);
});
