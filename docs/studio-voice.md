# 独立 DEM 语音活动分析

本功能是 CS2 Demo Desk 自行实现的 Source 2 DEM 协议读取器，未读取、复制或调用 Insight 的源码和运行时。它扫描真正的 `svc_VoiceData` 网络消息。没有语音消息时返回空列表，不从击杀、聊天、GSI 或玩家状态猜测有人说话。

当前 Windows `@laihoe/demoparser2@0.42.0` 包虽然在类型声明中列出 `parseVoice`，安装的 MSVC 原生库中该导出实际为 `undefined`。因此本功能独立读取协议，不依赖该不可用接口，也不引入 Python。

## 已实现与边界

- 从 DEM_Packet、DEM_SignonPacket 和 DEM_FullPacket 读取语音包，支持 Snappy 压缩帧和非字节对齐的网络位流。
- 保存原始 DEM Tick、消息内 Tick、SteamID64 字符串、包字节数、格式编号、采样率，以及协议提供的 voice_level。
- 语音活动分段以 DEM Tick 对齐复盘：同一身份的相邻语音包间隔小于 0.3 秒时合并；末尾延长 0.18 秒供 HUD 显示。它是语音包活动区间，不代表精确的音频时长或检测后的每一句人声。
- 如果 voice_level 未提供则保持 null，不伪造振幅。无 SteamID 的消息使用 entity 作为临时分组，不能假称已识别具体玩家。
- 当前不解码音频、不输出 WAV、不做语音转文字。返回 `audioDecoded: false`。各 DEM 是否保存队内语音由录制源决定，空结果应提示“该录像没有保存可用语音包”。
- 从 ServerInfo 的 tick_interval 读取 Tick 频率，未提供时以 64 Tick/s 展示。
- 必须存在 DEM_Stop，损坏、截断、非法长度或过大的数据都会明确报错。

## 接口

```js
const { createVoiceService, activityAt } = require('./studio-voice');
const voice = createVoiceService({ workerFactory });
const analysis = await voice.analyze(validatedDemoPath);
// analysis: {source, audioDecoded, tickRate, packetCount, maxTick,
//   players:[{steamid, entity, packets, bytes, activitySeconds,
//     segments:[{startTick,endTick,lastPacketTick,packets,bytes,level}]}],
//   packets:[{tick,messageTick,steamid,entity,format,bytes,sampleRate,level}]}
const active = activityAt(analysis, currentDemoTick);
await voice.stop();
```

独立子进程运行语音扫描；默认 factory 用 Node child_process.fork。Electron 主进程应传入 `utilityProcess` factory，与现有解析服务保持一致：进程 spawn 后将 `options.workerData` 发出，`terminate` 调用 kill。入口为 `src/studio-voice-worker.js`，支持 Electron `process.parentPort` 和 Node IPC。如果使用解包路径，应把此入口及 `src/studio-voice.js` 一同解包，或保证入口可以读取 asar 中的 module。

`analyze` 使用文件实际路径、大小和 mtime 缓存最近一次结果，并合并相同文件的并行请求。超时默认 120 秒，关闭服务终止所有任务。`busy` 可用于自动退出判定。仅 UI 需要保存经过验证的复盘库 DEM 引用，无需把绝对路径、个人语音或数据上传到服务器。

低层 `scanDemoVoice(path, options)` 只用于子进程和协议测试。默认限制：8 GiB 文件、64 MiB 单帧及解压帧、256 KiB 单语音包、200 万 DEM 帧、1000 万网络消息和 25 万语音包。预先检查解压声明长度，避免压缩炸弹分配超大内存。

## 验证

```powershell
node --test tests/studio-voice.test.cjs
$env:DEMODESK_REAL_DEMO='完整路径到真实DEM'
node --test tests/studio-voice.test.cjs
```

实际读取本机 105,461,036 字节的 CS2 DEM：154,328 帧、417,460 网络消息、36,202 个语音包、7 个语音身份、64 Tick/s。独立子进程处理约 0.7 秒。真实个人 DEM 不进入 Git。测试同时覆盖 SteamID 精度、非对齐消息、三种 Snappy 回引用与重叠、压缩帧、完整帧、无语音、损坏数据、截断、长度与数量超限及子进程错误后的再次使用。

协议依据为通用公开定义，实现代码独立编写：

- [CS2 demo.proto（SteamTracking 从游戏公开定义同步）](https://github.com/SteamTracking/Protobufs/blob/master/csgo/demo.proto)
- [CS2 netmessages.proto](https://github.com/SteamTracking/Protobufs/blob/master/csgo/netmessages.proto)
- [Google Snappy 格式说明](https://github.com/google/snappy/blob/main/format_description.txt)
- [demoparser 通用 Source 2 包读取行为](https://github.com/LaihoE/demoparser/blob/main/src/parser/src/second_pass/parser.rs)

后续完整音频解码需要分别处理 Steam/Engine/Opus 格式，核实每种分帧及 codec 参数，再利用独立通用解码器输出 PCM。活动时间轴不等同于已经完成这一步。
