# 独立 DEM 外观修改：技术验证与实施范围

研究日期：2026-10-02。此文记录后续工作，不代表当前发行版已支持换肤、天气或天空替换。未读取、复制或调用 Insight Pro 的源码、插件、模型或运行时。

## 当前确实完成的基础

`src/valve-package.js` 是本项目独立编写的只读 VPK v1/v2 容器读取器。`readDirectory(filename)` 返回资源条目数组；`readEntry(filename, entry, options)` 合并 preload 与分卷/内嵌 payload，默认校验 CRC32。它校验索引、字符串、资源路径、条目数据范围及分配大小；不修改游戏包。

在本机 CS2 官方安装资源上，读取了 137,440 条资源；成功校验并读取 `resource/overviews/de_mirage.txt` 和 `panorama/images/overheadmaps/de_mirage_radar_psd.vtex_c`。前者提供真实地图坐标原点和比例，后者为 177,297 字节的实际雷达纹理。合成测试覆盖 v1/v2、preload、内嵌编号 32767、编号分卷、CRC 损坏、截断、非法路径及大小限制。

本机包存在 `scripts/items/items_game.txt` 和 30 个 `materials/skybox/*.vmat_c` 条目。读取素材名称只是能力调查，不能当作已完成的换肤/天气功能；同目录也可能包含非天空着色器的辅助材质。此处仅参考 [ValvePak 的容器说明](https://github.com/ValveResourceFormat/ValvePak)，未复制其实现。

## 实施方向：导出修改后的副本

首选离线重写 DEM 并保留原件：界面选择原录像与替换参数，独立进程导出新文件，验证后仍由 Steam 启动 App 730 回放。这样可沿用本项目已完成的 Steam 启动与录像播放流程。

当前 `@laihoe/demoparser2` 对外提供查询与解析 API，未提供 DEM 写入 API；不能把查询结果重新保存就当作有效 DEM。其玩家手套、探员、武器等查询能力可用于导出后的交叉核验。[demoparser 的 API 和字段说明](https://github.com/LaihoE/demoparser/blob/main/README.md)

重写器必须先独立实现以下协议层，并在不修改任何内容时证明读取再写出仍可正常播放：

1. 解析 Source 2 文件封装、命令帧与 tick；处理压缩标志、消息长度及文件信息索引，保留未知帧。每个编辑操作都写到新文件，使用临时文件与原子提交，失败时保留原 DEM。
2. 解码 `CDemoSendTables`、类信息与 flattened serializers，从录像自身建立字段名、类型、编码器、量化参数、数组和多态 serializer 的映射。游戏内存偏移与 DEM bitstream 字段路径不是同一种信息，不能把 schema dump 的偏移直接用于文件修改。
3. 解码 Packet 内的网络消息和 field path；为整数、变长整数、quantized float、向量、句柄、字符串及数组实现对应编码器。重新编码每一层长度与压缩数据，并保留与目标修改无关的字段和 protobuf unknown fields。
4. 维护实体创建、更新、删除、实体序列号、delta 参照与 baseline。处理 `instancebaseline` 字符串表、更新基线和 alternate baseline；同时修改 `DEM_FullPacket` 的字符串表快照与实体状态。否则快进或跳回时会恢复原皮肤，甚至破坏实体状态。
5. 建立“输入 build + serializer 指纹 + 支持字段”的能力报告。未知布局、缺失字段或不支持的编码必须明确拒绝修改，不能产出标为成功的半成品。

这些步骤由记录到的 Source 2 protobuf 布局约束：`CDemoFullPacket` 同时包含 string table 和 packet，`CSVCMsg_PacketEntities` 包含 `entity_data`、baseline 与 delta 信息。它们并不是一张可直接替换文本的皮肤表。[DEM protobuf 定义](https://github.com/SteamTracking/GameTracking-CS2/blob/master/Protobufs/demo.proto)、[网络消息及 serializer 定义](https://github.com/SteamTracking/GameTracking-CS2/blob/master/Protobufs/netmessages.proto)

## 皮肤改写的最小真实目标

首先只支持“现有武器模型不变，替换该武器已有 paint kit、seed、wear 属性”，以缩小可验证范围。通过玩家 Steam ID、当前持有者与原始所有者判定修改对象；必须定义购买、捡枪、丢枪、队伍交换之后的归属行为，不能只靠玩家名称。

本机 `items_game.txt` 中 attribute 6、7、8 分别对应 `set item texture prefab`、`set item texture seed`、`set item texture wear`。读取当前安装的 schema/catalog 校验这些关系以及武器和 paint kit 的兼容性；不能假定所有 paint kit 都适用于所有武器。

需要对录像里的 item definition、`m_AttributeManager`/item attribute list 与 fallback paint/seed/wear 实际发送方式逐项验证。当前游戏 schema 中存在这些 fallback 属性，但“内存中存在”不等于“每份 DEM 都序列化了它”。以该 DEM 的 serializer 和实体数据为准。只改 fallback 而忽略实际 attribute list 可能毫无效果。[当前 C_EconEntity schema](https://s2v.app/SchemaExplorer/cs2/client/C_EconEntity)

刀型、手套、探员和贴纸后续分别验收：除外观属性外，可能涉及 item definition、模型/资源引用、viewmodel、subclass 和动画兼容关系。它们不是初版枪械 paint kit 修改器自动获得的能力。发布前要验证视角内模型、第三人称模型以及捡起后的模型一致。

## 天空、雾与降雨分别处理

天空实体实际包含材质句柄、颜色和亮度等字段。独立 DEM 方案先尝试修改已经记录的天空颜色/亮度，再研究材质句柄与资源注册方式；只找到 `.vmat_c` 路径不能证明 DEM 可以直接写入路径。若目标地图的天空来自静态地图资源而非可改写的录像字段，必须返回不支持。[C_EnvSky schema](https://s2v.app/SchemaExplorer/cs2/client/C_EnvSky)

雾需要分清 gradient fog、cubemap fog 与 volumetric fog；替换天空不代表雾和环境光已同步改变。真正雨雪需要地图或客户端粒子实体、粒子资源及生命周期支持；替换成名称含 `rain` 的天空材质不能算降雨。[Valve 随游戏提供的地图实体定义](https://github.com/SteamTracking/GameTracking-CS2/blob/master/game/csgo/csgo.fgd)

可逆天空覆盖的已知实现路径是独立第三方 HLAE 的 `mirv_sky material`、`color`、clouds 控制，支持 CS2，材质切换在地图变化后需重新应用；可用 `default` 恢复。路径需是实际存在的编译天空材质。这证明外观可在回放渲染时覆盖，但它要求 HLAE 的 AfxHookSource2，不能把 `mirv_sky` 写入普通 CS2 cfg 并宣称有效。目前没有在本项目启用、分发或测试该 hook，也没有修改游戏目录。[HLAE 作者的 CS2 天空接口说明](https://github.com/advancedfx/advancedfx/wiki/Source2%3Amirv_sky)

若以后采用该第三方运行时，必须单独设计与 Steam 730 启动相容的离线回放会话，识别版本兼容性、明确仅用于回放，并恢复会话创建的配置。HLAE 官方要求其启动使用 `-insecure`，且主仓库 MIT 不覆盖所有 submodules。它不能作为普通官匹在线游戏的自动插件。[HLAE 作者的启动与支持说明](https://github.com/advancedfx/advancedfx/wiki/FAQ)、[仓库许可范围](https://github.com/advancedfx/advancedfx)

## 真实验收与交付门槛

| 阶段 | 必须通过的验收 |
| --- | --- |
| 无修改重写 | 官匹、完美、赛事各取真实 DEM；解析事件/玩家/tick 与输入一致，开头、中段、结尾及 seek 可正常回放；原件 SHA-256 不变。 |
| 单把枪换皮肤 | 导出后独立解析确认目标属性改变；Steam 游戏回放截图确认材质实际变化；其他玩家、武器和比赛事件不变。 |
| 时间与实体生命周期 | 冻结期、购买后、丢枪/捡枪、死亡、半场交换及前后 seek 保持正确外观；baseline/full packet 处无恢复或崩溃。 |
| 天空与雾 | 同机同地图同 tick 对照截图；记录被修改实体和字段，验证快进与重新加载；不把全画面调色计为天空替换。 |
| 新增模型/粒子 | 实际录像中检查模型、动画、资源与雨雪生命周期；资源缺失、旧 DEM 或不支持布局有可读错误。 |
| 安装版 | 打包后的独立修改进程隔离崩溃，取消/超时释放资源，异常导出不替换原件；安装包带所采用库的许可证。 |

进度不以“写出了文件”或“解析器未报错”认定完成；必须证明 CS2 实际播放结果。真实样本与截图只保存在本机测试目录，不随 Git 发布个人录像。

## 来源与许可记录

| 来源 | 用途 | 此轮引入/许可处理 |
| --- | --- | --- |
| [ValvePak](https://github.com/ValveResourceFormat/ValvePak) / [LICENSE](https://github.com/ValveResourceFormat/ValvePak/blob/master/LICENSE) | VPK 容器行为的 primary source 参考 | MIT；本项目新 reader 未复制代码，不新增 ValvePak 二进制依赖。若后续采用其代码/库，随包保留原版权和许可。 |
| [Source 2 Viewer](https://github.com/ValveResourceFormat/ValveResourceFormat) / [LICENSE](https://github.com/ValveResourceFormat/ValveResourceFormat/blob/master/LICENSE) | 当前游戏 schema 与通用资源解码工具 | MIT；游戏测试资源不在其 MIT 许可范围内。若分发 CLI，固定版本并附许可和第三方声明，地图资源在用户本机读取。 |
| [LaihoE/demoparser](https://github.com/LaihoE/demoparser) / [LICENSE](https://github.com/LaihoE/demoparser/blob/main/LICENSE) | 现有解析与导出后独立核验 | MIT；项目已依赖其 Node 包并包含许可记录。本轮未修改上游库。 |
| [SteamTracking/GameTracking-CS2](https://github.com/SteamTracking/GameTracking-CS2) | 记录 Valve 发布的 protobuf 与地图 schema | 格式参考；不将跟踪到的 Valve 游戏素材视作 MIT 代码或重新分发。 |
| [advancedfx](https://github.com/advancedfx/advancedfx) | 天空覆盖可行性调查 | 主仓库 MIT，submodule 单独审计；本轮没有分发其二进制或脚本。 |

尚未实施的工作：独立 DEM serializer/field-path 编码器、基线与 full-packet 重写、枪械皮肤实机验证、模型/手套/探员/贴纸扩展、环境与天气实机验证。以上均不能算作当前发行版已完成能力。
