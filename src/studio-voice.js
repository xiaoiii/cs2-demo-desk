const fs = require('node:fs');
const path = require('node:path');
const { fork } = require('node:child_process');

// Independently implemented protocol reader. This reads svc_VoiceData, never
// infers microphone activity from gameplay events. See docs/studio-voice.md.
const DEFAULT_LIMITS = Object.freeze({ fileBytes: 8 * 1024 ** 3, frameBytes: 64 * 1024 ** 2, decodedBytes: 64 * 1024 ** 2, voiceBytes: 256 * 1024, frames: 2000000, messages: 10000000, voicePackets: 250000 });
const malformed = detail => new Error(`DEM 语音数据不完整或格式无效：${detail}`);

class FileReader {
  constructor(filename, limits) {
    this.fd = fs.openSync(filename, 'r');
    try {
      const stat = fs.fstatSync(this.fd);
      if (!stat.isFile() || stat.size > limits.fileBytes) throw new Error('DEM 文件超过语音分析大小限制。');
      this.size = stat.size;
      this.position = 0;
      this.buffer = Buffer.alloc(65536);
      this.offset = 0;
      this.available = 0;
    } catch (error) { fs.closeSync(this.fd); throw error; }
  }
  remaining() { return this.size - this.position; }
  byte() {
    if (!this.remaining()) throw malformed('意外到达文件结尾');
    if (this.offset === this.available) {
      this.available = fs.readSync(this.fd, this.buffer, 0, Math.min(this.buffer.length, this.remaining()), this.position);
      this.offset = 0;
      if (!this.available) throw malformed('无法读取文件');
    }
    this.position++;
    return this.buffer[this.offset++];
  }
  read(count) {
    if (!Number.isSafeInteger(count) || count < 0 || count > this.remaining()) throw malformed('帧长度超出文件');
    const data = Buffer.allocUnsafe(count);
    let copied = Math.min(count, this.available - this.offset);
    this.buffer.copy(data, 0, this.offset, this.offset + copied);
    this.offset += copied;
    this.position += copied;
    while (copied < count) {
      const read = fs.readSync(this.fd, data, copied, count - copied, this.position);
      if (!read) throw malformed('无法读取完整帧');
      copied += read;
      this.position += read;
    }
    return data;
  }
  skip(count) {
    if (count > this.remaining()) throw malformed('帧长度超出文件');
    const buffered = Math.min(count, this.available - this.offset);
    this.offset += buffered;
    this.position += count;
  }
  close() { fs.closeSync(this.fd); }
}

class Bytes {
  constructor(data) { this.data = data; this.position = 0; }
  remaining() { return this.data.length - this.position; }
  byte() { if (!this.remaining()) throw malformed('字段被截断'); return this.data[this.position++]; }
  read(count) {
    if (count > this.remaining()) throw malformed('字段长度超出消息');
    const value = this.data.subarray(this.position, this.position + count);
    this.position += count;
    return value;
  }
}

function varint32(reader) {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    const byte = reader.byte();
    if (i === 4 && (byte & 0xf0)) throw malformed('整数超限');
    value += (byte & 127) * 2 ** (7 * i);
    if (!(byte & 128)) return value;
  }
  throw malformed('整数超限');
}

function snappyDecode(data, maximum = DEFAULT_LIMITS.decodedBytes) {
  const reader = new Bytes(data), length = varint32(reader);
  if (length > maximum) throw new Error('DEM 解压帧超过语音分析内存限制。');
  const output = Buffer.allocUnsafe(length);
  let written = 0;
  while (reader.remaining()) {
    const tag = reader.byte(), kind = tag & 3;
    let count, offset;
    if (!kind) {
      const prefix = tag >>> 2;
      if (prefix < 60) count = prefix + 1;
      else {
        const bytes = prefix - 59;
        count = 1;
        for (let i = 0; i < bytes; i++) count += reader.byte() * 2 ** (i * 8);
      }
      if (count > length - written) throw malformed('Snappy literal 超限');
      reader.read(count).copy(output, written);
      written += count;
      continue;
    }
    if (kind === 1) { count = 4 + ((tag >>> 2) & 7); offset = ((tag & 224) << 3) + reader.byte(); }
    else {
      count = 1 + (tag >>> 2);
      offset = reader.byte() + reader.byte() * 256;
      if (kind === 3) offset += reader.byte() * 65536 + reader.byte() * 16777216;
    }
    if (!offset || offset > written || count > length - written) throw malformed('Snappy 回引用无效');
    for (let i = 0; i < count; i++) output[written + i] = output[written + i - offset];
    written += count;
  }
  if (written !== length) throw malformed('Snappy 长度不匹配');
  return output;
}

function fields(data) {
  const reader = new Bytes(data), output = new Map();
  while (reader.remaining()) {
    const tag = varint32(reader), field = Math.floor(tag / 8), wire = tag & 7;
    if (!field) throw malformed('protobuf 字段编号为零');
    let value;
    if (wire === 0) {
      let integer = 0n, done = false;
      for (let i = 0; i < 10; i++) {
        const byte = reader.byte();
        if (i === 9 && byte > 1) throw malformed('protobuf 整数超限');
        integer |= BigInt(byte & 127) << BigInt(7 * i);
        if (!(byte & 128)) { done = true; break; }
      }
      if (!done) throw malformed('protobuf 整数超限');
      value = integer <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(integer) : integer;
    } else if (wire === 1) value = reader.read(8);
    else if (wire === 2) value = reader.read(varint32(reader));
    else if (wire === 5) value = reader.read(4);
    else throw malformed('不支持的 protobuf wire 类型');
    output.set(field, value);
  }
  return output;
}

class Bits {
  constructor(data) { this.data = data; this.position = 0; }
  remaining() { return this.data.length * 8 - this.position; }
  read(count) {
    if (count > this.remaining()) throw malformed('网络消息位流被截断');
    let value = 0, written = 0;
    while (written < count) {
      const shift = this.position & 7, take = Math.min(8 - shift, count - written);
      value += ((this.data[this.position >>> 3] >>> shift) & ((1 << take) - 1)) * 2 ** written;
      written += take;
      this.position += take;
    }
    return value;
  }
  byte() { return this.read(8); }
  messageType() {
    const first = this.read(6), extended = first >>> 4;
    return extended ? (first & 15) + this.read([0, 4, 8, 28][extended]) * 16 : first;
  }
  bytes(count) {
    if (count * 8 > this.remaining()) throw malformed('网络消息长度超出帧');
    if (!(this.position & 7)) {
      const value = this.data.subarray(this.position >>> 3, (this.position >>> 3) + count);
      this.position += count * 8;
      return value;
    }
    const value = Buffer.allocUnsafe(count), shift = this.position & 7, start = this.position >>> 3;
    for (let i = 0; i < count; i++) value[i] = (this.data[start + i] >>> shift) | (this.data[start + i + 1] << (8 - shift));
    this.position += count * 8;
    return value;
  }
  skip(count) { if (count * 8 > this.remaining()) throw malformed('网络消息长度超出帧'); this.position += count * 8; }
}

function voicePacket(message, demoTick, limits) {
  const outer = fields(message), audioBytes = outer.get(1);
  if (!Buffer.isBuffer(audioBytes)) return null;
  const audio = fields(audioBytes), payload = audio.get(2);
  if (!Buffer.isBuffer(payload) || !payload.length) return null;
  if (payload.length > limits.voiceBytes) throw new Error('单个语音包超过大小限制。');
  const xuid = outer.get(4);
  const steamid = Buffer.isBuffer(xuid) ? xuid.readBigUInt64LE().toString() : '';
  const level = audio.get(9), rawLevel = Buffer.isBuffer(level) ? level.readFloatLE() : null;
  return {
    tick: demoTick,
    messageTick: typeof outer.get(6) === 'number' ? outer.get(6) : null,
    steamid: steamid === '0' ? '' : steamid,
    entity: typeof outer.get(8) === 'number' ? outer.get(8) : null,
    format: typeof audio.get(1) === 'number' ? audio.get(1) : 0,
    bytes: payload.length,
    sampleRate: typeof audio.get(5) === 'number' ? audio.get(5) : null,
    level: Number.isFinite(rawLevel) ? Math.max(0, Math.min(1, rawLevel)) : null
  };
}

function summarizeVoice(packets, tickRate = 64, options = {}) {
  const gap = Math.max(1, Math.round((options.gapSeconds ?? 0.3) * tickRate));
  const hold = Math.max(1, Math.round((options.holdSeconds ?? 0.18) * tickRate));
  const grouped = new Map();
  for (const packet of [...packets].sort((a, b) => a.tick - b.tick)) {
    const key = packet.steamid || `entity:${packet.entity ?? 'unknown'}`;
    let player = grouped.get(key);
    if (!player) { player = { steamid: packet.steamid, entity: packet.entity, packets: 0, bytes: 0, segments: [] }; grouped.set(key, player); }
    player.packets++;
    player.bytes += packet.bytes;
    let segment = player.segments.at(-1);
    if (!segment || packet.tick - segment.lastPacketTick > gap) {
      segment = { startTick: packet.tick, endTick: packet.tick + hold, lastPacketTick: packet.tick, packets: 0, bytes: 0, level: null };
      player.segments.push(segment);
    }
    segment.endTick = Math.max(segment.endTick, packet.tick + hold);
    segment.lastPacketTick = packet.tick;
    segment.packets++;
    segment.bytes += packet.bytes;
    if (packet.level != null) segment.level = Math.max(segment.level ?? 0, packet.level);
  }
  const players = [...grouped.values()].map(player => ({ ...player, activitySeconds: player.segments.reduce((sum, segment) => sum + (segment.endTick - segment.startTick) / tickRate, 0) }));
  return { source: 'svc_VoiceData', audioDecoded: false, tickRate, packetCount: packets.length, players, packets };
}

function scanDemoVoice(filename, options = {}) {
  if (!path.isAbsolute(filename)) throw new Error('语音分析需要 DEM 的完整路径。');
  const limits = { ...DEFAULT_LIMITS, ...options.limits }, reader = new FileReader(filename, limits);
  try {
    if (reader.read(16).subarray(0, 8).toString('ascii') !== 'PBDEMS2\0') throw new Error('请选择有效的 CS2 DEM 文件。');
    let stopped = false, frameCount = 0, messageCount = 0, tickRate = 64, maxTick = 0;
    const packets = [];
    while (reader.remaining()) {
      if (++frameCount > limits.frames) throw new Error('DEM 帧数量超过语音分析限制。');
      const command = varint32(reader), tick = varint32(reader) | 0, size = varint32(reader), type = command & ~64;
      if (size > limits.frameBytes) throw new Error('DEM 帧超过语音分析大小限制。');
      if (type < 0 || type > 18) throw malformed('未知 DEM 命令');
      if (frameCount === 1 && type !== 1) throw malformed('缺少 DEM_FileHeader');
      if (type === 0) { reader.skip(size); stopped = true; break; }
      if (type === 1) {
        const fileHeader = reader.read(size), header = fields(command & 64 ? snappyDecode(fileHeader, limits.decodedBytes) : fileHeader);
        const stamp = header.get(1);
        if (!Buffer.isBuffer(stamp) || !stamp.toString('ascii').startsWith('PBDEMS2')) throw malformed('DEM 文件标记无效');
        continue;
      }
      if (![7, 8, 13].includes(type)) { reader.skip(size); continue; }
      let data = reader.read(size);
      if (command & 64) data = snappyDecode(data, limits.decodedBytes);
      if (type === 13) data = fields(data).get(2);
      if (!Buffer.isBuffer(data)) throw malformed('完整帧缺少 packet');
      const packetData = fields(data).get(3);
      if (!Buffer.isBuffer(packetData)) continue;
      const bitstream = new Bits(packetData);
      maxTick = Math.max(maxTick, tick);
      while (bitstream.remaining() > 8) {
        if (++messageCount > limits.messages) throw new Error('DEM 网络消息数量超过语音分析限制。');
        const message = bitstream.messageType(), length = varint32(bitstream);
        if (length > limits.decodedBytes) throw new Error('网络消息超过语音分析大小限制。');
        if (message === 47) {
          const packet = voicePacket(bitstream.bytes(length), tick, limits);
          if (packet && tick >= 0) {
            if (packets.length >= limits.voicePackets) throw new Error('语音包数量超过分析限制。');
            packets.push(packet);
          }
        } else if (message === 40) {
          const interval = fields(bitstream.bytes(length)).get(13);
          const seconds = Buffer.isBuffer(interval) ? interval.readFloatLE() : 0;
          if (Number.isFinite(seconds) && seconds >= 1 / 256 && seconds <= 1 / 16) tickRate = Math.round(1 / seconds);
        } else bitstream.skip(length);
      }
    }
    if (!stopped) throw malformed('缺少 DEM_Stop，录像可能未下载完整');
    return { ...summarizeVoice(packets, tickRate, options), maxTick, frames: frameCount, messages: messageCount };
  } finally { reader.close(); }
}

function activityAt(analysis, tick) {
  const time = Number(tick);
  if (!Number.isFinite(time)) return [];
  return (analysis.players || []).flatMap(player => {
    const segment = player.segments.find(item => item.startTick <= time && item.endTick >= time);
    return segment ? [{ steamid: player.steamid, entity: player.entity, level: segment.level, startTick: segment.startTick, endTick: segment.endTick }] : [];
  });
}

function createVoiceService({ workerFactory, timeoutMs = 120000 } = {}) {
  const workers = new Set(), cache = new Map(), pending = new Map();
  const factory = workerFactory || ((file, options) => {
    const child = fork(file, [], { silent: true, windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
    child.once('spawn', () => child.send(options.workerData));
    child.terminate = () => child.kill();
    return child;
  });
  async function analyze(filename) {
    const real = fs.realpathSync(filename), stat = fs.statSync(real), key = `${real}:${stat.size}:${stat.mtimeMs}`;
    if (cache.has(key)) return cache.get(key);
    if (pending.has(key)) return pending.get(key);
    const operation = new Promise((resolve, reject) => {
      const child = factory(path.join(__dirname, 'studio-voice-worker.js'), { workerData: { path: real } });
      workers.add(child);
      let finished = false;
      const finish = (error, value) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        workers.delete(child);
        child.terminate();
        if (error) reject(error); else { cache.clear(); cache.set(key, value); resolve(value); }
      };
      const timer = setTimeout(() => finish(new Error('DEM 语音分析超时。')), timeoutMs);
      child.once('message', reply => reply.ok ? finish(null, reply.value) : finish(new Error(reply.error || 'DEM 语音分析失败。')));
      child.once('error', error => finish(error));
      child.once('exit', () => finish(new Error('DEM 语音分析进程已退出。')));
    });
    pending.set(key, operation);
    try { return await operation; } finally { pending.delete(key); }
  }
  async function stop() { await Promise.allSettled([...workers].map(worker => worker.terminate())); }
  return { analyze, stop, get busy() { return workers.size > 0; } };
}

module.exports = { scanDemoVoice, summarizeVoice, activityAt, createVoiceService, snappyDecode, DEFAULT_LIMITS };
