# CS2 Demo Desk 1.3.3 — POV 录制修复

## 1.3.3 修复

CS2 自然推进录像后，暂停日志可能比指定结束位置晚几个 Tick。此前正常录到目标片段也可能被标记为未完成。现在仅接受目标前 1 Tick 至目标后 4 Tick 的暂停位置，并保留实际结束 Tick；超出范围仍停止任务并保留未完成素材。按 64 Tick/s 计算，允许的尾部最多为 62.5 毫秒。

录制前通过 `demo_ui_mode 0` 明确关闭回放面板。重复校准玩家视角时也保持关闭，避免 DemoUI 的切换行为重新打开控制条。开始录制前和录制过程中仍检查实际玩家 SteamID。

修复后真实短片重录通过：录制指定玩家约 8.05 秒的两次击杀片段，任务完成，保存素材标记为完整。MP4 为 13.85 秒、1920×1080 / 60fps，含游戏音频；原始素材时长包含开始播放前的准备画面。画面确认指定玩家及关闭的回放控制条，完整视频解码通过。128 项自动测试、16 项桌面下载回归和安装后的真实 DEM 工作室验证通过；整场 POV 尚未实测。详细结果见 TEST-REPORT.md。

下载 [1.3.3 Windows 安装版](https://github.com/xiaoiii/cs2-demo-desk/releases/tag/v1.3.3)。本次改动及验证边界见 [1.3.3 更新说明](docs/release-1.3.3.md)。

## 1.3.2 修复

首次发送游戏控制指令时，Windows PowerShell 需要启动并编译输入辅助程序。现在为这一过程留出最多 60 秒，避免游戏正在加载或电脑较慢时提前中止。失败提示改为具体的中文说明，不再显示完整命令或编码后的输入。

首次控制录像时初始化本次游戏的 Console 日志，让控制指令的执行确认能写入独立日志。切换并验证所选玩家视角后，录制开始前自动隐藏 DemoUI，避免回放面板挡住画面。

切换 POV 时优先使用本次录制经过校验且近期更新的 GSI 玩家列表，按 SteamID 找到观察槽位，避免匿名或重名玩家导致昵称选择失效；同时关闭自动导播并切到第一人称。开始录制及录制过程中继续检查实际玩家 SteamID，不将已发送切换指令视为切换成功。

下载 [1.3.2 Windows 安装版](https://github.com/xiaoiii/cs2-demo-desk/releases/tag/v1.3.2)。本次改动及验证边界见 [1.3.2 更新说明](docs/release-1.3.2.md)；真实 OBS 与 CS2 联录结果以 TEST-REPORT.md 为准。

## 1.3.1 新增

地图回放从本机 CS2 的 VPK 读取官方雷达纹理和坐标定义，支持多层地图选择，并展示玩家朝向。未找到该地图资源时继续使用坐标网格；游戏资源只在本机读取和缓存，不包含在发行包中。

新增“语音活动”页，自行读取 DEM 的真实语音消息，按 Steam 身份展示活动时间轴、跳转和播放预览。可复制透明 HUD 的本机地址，或连接 OBS 后添加浏览器来源。HUD 跟随软件内的预览时间，尚未与游戏中的回放实时同步；开始录制会清空预览提示。当前不解码语音、不转写对话；没有语音包的录像显示为空。

录制现在先等待游戏确认控制指令及起始 Tick，让 OBS 就绪后再推进录像，并按游戏报告的目标 Tick 判断完成。视角变化、GSI 超时、意外跳转和提前暂停会停止并保留未完成素材；缺少确认不会继续录下错误画面。此处为 1.3.1 功能说明，当前实测结果见 TEST-REPORT.md。

纹理解码使用通用工具。Powered by [Source 2 Viewer](https://s2v.app) ([ValveResourceFormat](https://github.com/ValveResourceFormat/ValveResourceFormat)). VPK 格式参考 [ValvePak](https://github.com/ValveResourceFormat/ValvePak)，语音协议来源及验证边界见 [语音说明](docs/studio-voice.md)。

## 安装与升级

运行 `CS2-Demo-Desk-Setup-1.3.3-x64.exe`，选择安装位置，安装后从桌面或开始菜单打开。新版只发布安装程序。卸载入口位于 Windows“已安装的应用”；卸载保留下载文件和本机用户资料。原便携版的比赛记录、登录凭证与目录设置会继续沿用；安装前先退出旧版。新版仍未签名。

原便携版曾启用开机启动时，请在安装版的偏好设置中关闭再开启一次，将 Windows 启动项更新到安装后的程序路径。

## 复盘工作室

本项目独立实现的工作室将下载、复盘、录制与剪辑接在一起，不依赖 CS2 Insight Agent 的源码、程序、Python 服务或私有运行时。

- **玩家复盘**：已下载 DEM 直接点“复盘”，也可扫描录像目录或添加本地文件。按 Steam 身份统计击杀、死亡、助攻、ADR、爆头率，生成完整回合、精彩击杀和死亡片段。
- **地图回放**：选择片段后读取真实玩家坐标，播放、暂停、拖动时间；读取本机 CS2 底图，多层地图可以切换，缺少资源时显示网格。
- **POV 录制**：配置本机 OBS WebSocket，选择玩家及片段，或录制整场 POV。通过 Steam 启动游戏，初始化控制日志，优先按 GSI 中 SteamID 对应的观察槽位切换第一人称并关闭自动导播。确认实际玩家身份后，通过 `demo_ui_mode 0` 关闭 DemoUI 再开始录制。依据游戏日志判断结束，保存素材的实际结束 Tick；最多允许 4 Tick 尾部偏差，超出时标记为未完成。首次控制可能需要等待 PowerShell 启动，最多 60 秒。Steam 启动确认仍需点击确认；控制台应保留默认 ~ 键，游戏和软件使用相同权限。录制时不要手动暂停、切换视角或关闭游戏。
- **视频剪辑**：导入本地视频或录制素材，排序、裁剪、倍速、音量、中文标题、原色/电影/黑白色调、淡入淡出，保存项目并导出 1080p / 60fps MP4。输出保留原始素材，已有输出文件不覆盖。
- **AI 点评与选片**：使用自行配置的兼容接口和模型。仅点击 AI 功能时发送事件摘要；密钥和 OBS 密码由 Windows 本机加密保存。AI 选片顺序可以交给录制队列；已有对应录制素材时，可自动建立剪辑项目。

本次重写覆盖上述工作流。真实 DEM 分析、地图回放、语音活动和实际视频导出已验证，也已取得真实 OBS 与游戏联录的短片样本；当前录制验证结果见 TEST-REPORT.md，整场 POV 尚未实测。DEM 换肤、天空/天气资源修改和语音 HUD 与游戏的实时同步仍需独立实现，不将当前版本宣称为原 Pro 软件的完整等价替代。后续协议工作见 [外观修改技术计划](docs/demo-customization-roadmap.md)。

## 下载后自动保存 DEM 到 CS2 录像目录

官匹、完美和赛事的 BZ2 / ZIP / RAR / 7z 下载完成后自动解压，生成的 .dem 直接放在 CS2 的 game/csgo/replays。直接下载的 DEM 也会保存到这个目录。软件通过 Steam 游戏库查找已有目录；找不到或保存的目录已丢失时弹出选择窗口，可指定其他文件夹，选择会保留到下次启动。

在“偏好设置 → Demo 录像目录”可更改或打开位置；顶部和底部的录像目录按钮也能直接打开。同名文件自动添加序号，不覆盖原有录像。原下载文件保留在“原始下载文件”目录，出错后可重试。

取消目录选择、压缩包损坏或保存失败时保留下载文件，点击“重试保存”继续。自动退出会等待解压和保存成功；失败时保持窗口。升级不搬迁或批量处理历史文件，历史记录仍使用原路径。

## 内置 Steam 网页加速与后台运行

在“偏好设置”开启 **内置 Steam 网页加速**，然后点击“测试 Steam 连接”。无需填写代理地址或另外安装加速器；开启后用于本软件内的 Steam 社区、登录、比赛记录，以及完美平台登录中的 Steam 授权。首次默认关闭，开关会自动保存。切换前请等待获取和下载结束，并关闭来源或登录窗口。

加速模块由软件自行实现：内存中生成临时证书，仅本软件对应会话信任该证书；通过加密 DNS 与兼容 TLS 连接访问 Steam，并校验上游证书链和原始域名。不安装系统根证书、不修改 hosts 或系统代理，不包含 Steamcommunity302 的程序或代码。关闭开关恢复原系统连接方式，退出软件停止内置服务。

它帮助访问 Steam 网页，不是 Steam 客户端或游戏加速器，也不保证所有网络均可用；遇到 IP 封锁或线路不可达时可能仍失败。启用时本软件其他网站直接连接，Steam Demo 下载服务器不在网页加速范围。当前机器已验证社区和登录页可访问；未将其作为所有国内网络的可用性保证。

关闭主窗口会转入 Windows 右下角托盘，下载继续。点击托盘图标恢复窗口；右键可进入下载队列、打开 Demo 库、刷新比赛、暂停当前下载、继续已暂停任务、打开目录或退出。底部快捷栏提供常用入口。需要完全关闭时点击快捷栏“退出”或托盘“退出软件”；已设置的下载完成自动退出仍会真正退出。

## 开机启动与自动下载

“偏好设置”新增三个独立开关，默认关闭：

- **开机自动启动**：登录 Windows 后打开软件。便携版请放在固定位置；更换 EXE 或移动位置后重新开启此开关。
- **启动后自动下载未下载的比赛 Demo**：下次启动先刷新所选来源，再下载当前日期范围内未完成的录像。可选择官匹、完美平台和赛事；默认选中官匹及完美平台。已完成、已取消、日期未知或没有可用下载方式的记录跳过。失败记录每次启动最多尝试一次。
- **下载完成后自动退出**：本次自动或手动下载全部成功，并且获取、解压、播放准备均结束后，倒计时 10 秒退出软件；界面可取消本次退出。自动下载没有新任务时也会退出。暂停、失败、取消、需要登录或获取结果不完整时保留窗口。

自动下载会主动刷新所选来源，不依赖“启动时自动获取比赛”开关。先登录相应来源并检查时间范围，再开启自动下载。只退出 Demo Desk，不关闭 Steam 或 CS2。

“回放按键”标签页支持中文功能选择和直接按键录入：点击“按键录入”后按下想绑定的键，Esc 取消。也可从列表选择鼠标键或滚轮。保存后自动更新 CFG，下次一键播放加载；目前仅支持单键绑定。

中文 CS2 比赛录像下载工具。个人官匹和赛事目录自动获取，勾选后下载；无需每场手动导入。独立项目，与 Valve、Steam、HLTV 无隶属关系。

## 完美平台 Demo

“完美平台”页面支持通过 SteamID64 和完美平台 `access_token` 获取近期个人比赛，并将可用 Demo 加入现有下载队列。凭证使用 Windows 本机加密保存，不写入比赛库、下载记录或日志；每次下载时才生成短期签名地址。默认显示最近 7 天，可调整为 1–365 天。

点击“使用 Steam 登录完美平台”，在官方窗口完成 Steam 登录、Steam Guard 和授权。软件自动从本次独立会话中取得 SteamID 和完美平台令牌，捕获密钥并识别账号后由 Windows 加密保存，再刷新最近一周比赛（比赛接口失败不会丢弃凭证）；无需手动找密钥。登录窗口关闭后清理临时会话，不保存 Steam 密码。重新打开软件可继续使用已保存的平台凭证，过期后点击重新登录；也可切换账号或清除凭证。

“手动填写（备用）”保留给已有凭证的用户。完美平台接口变化可能需要升级软件。自动登录的完整流程已通过模拟官方服务的 Windows 测试，真实账号授权及下载仍需在本机实测。

## 运行

从 [GitHub Release](https://github.com/xiaoiii/cs2-demo-desk/releases/tag/v1.3.3) 下载 `CS2-Demo-Desk-Setup-1.3.3-x64.exe` 后双击运行，无需安装 Node.js。可用同一 Release 中的 `SHA256SUMS.txt` 校验文件。程序尚未签名，Windows 首次运行时可能显示未知发布者提示。支持 Windows 10 / 11 x64；已在 Windows 10 x64 实测。

新版本沿用旧版本机资料目录，保留下载历史、目录设置和浏览器会话。先退出旧版，再启动新版。默认下载位置是系统“下载”目录下的 CS2 Demos。

## 个人官匹：登录一次，自动获取

1. 启动后自动检查 Steam 登录状态。首次使用点击“登录 Steam 并自动获取”。
2. 在来源窗口的 Steam 官方网页登录自己的账号。
3. 登录成功后自动读取优先、竞技、搭档模式比赛历史，必要时自动点击网页“加载更多”。
4. 默认获取最近 **7 天**，可切换 1、7、14、30、90 天，或自定义 **1–365 天**。改变范围后自动重新获取，也可点击“刷新比赛”。
5. 勾选可下载比赛，点击“下载所选”。日期未知的记录单独列出，不冒充本周比赛。

登录 Cookie / 凭证使用 Windows 的本机安全加密保存到 steam-session.bin，软件不保存账号密码、不向界面或日志暴露凭证。下次启动会恢复登录状态并自动获取比赛。Steam 撤销或过期的凭证不能永久保留有效性，届时需重新登录。

“偏好设置 → 清除登录凭证与缓存”会移除本机保存的登录状态。加密与当前 Windows 用户关联，不保证能在另一台电脑或其他 Windows 用户下直接使用。

## 赛事：自动获取，按赛事分类

启动时自动获取最近一周 HLTV 已结束比赛，显示对阵、比赛日期、赛事名称，并按赛事分组。可选择赛事筛选、搜索队伍、调整日期范围或手动刷新。

目录中的“待解析”表示真实比赛已收录，尚未确认该场 Demo 地址。勾选下载后，软件自动打开对应比赛详情查找下载链接并进入队列；未发布录像的比赛会显示暂不可下载，可稍后重查。

HLTV 可能要求网站验证。出现提示时点击“打开验证窗口”，在网站完成验证后自动继续；软件不会绕过网站验证或保证所有网络环境都能访问。网络或验证失败会保留已经获取的记录。

自动获取每种官匹模式或赛事目录最多读取 20 页，达到上限或无法继续分页时会显示“已获取部分记录”，不会把部分结果声称为完整历史。扩大历史范围不代表来源保留了相同时间内的录像。

## 下载、解压与播放

- 1–4 个并发任务，支持多选、搜索、暂停、继续、取消、重试。
- 暂停任务占用下载名额；服务器的续传支持决定继续时是否从头开始。
- 跨进程不承诺断点续传。退出后的未完成下载可以重新下载。
- 重名文件不会覆盖，移除记录保留磁盘文件。
- 支持 DEM、BZ2、ZIP、RAR、7z；下载后可在本地库解压并复制 CS2 的 playdemo 播放命令。
- 本地 Demo 库不受比赛日期范围影响。压缩文件原件会保留。
- 软件检查 Demo / 压缩包文件头，避免把登录页当录像，但不等同于完整游戏回放解析。旧版本 Demo 可能与当前 CS2 不兼容。

补充方式保留在“补充导入与来源浏览器”中：直接下载地址可批量粘贴，分享码可以交给已安装的 Steam / CS2 客户端解析。分享码方式的下载进度和文件由游戏管理。

## 开发与测试

### 一键播放（1.2.0）

本地库点击“一键播放”或“解压并播放”，软件先解压，将录像复制到 CS2 游戏目录下的独立短文件名，再通过 Steam 游戏 730 执行独立播放配置，自动载入录像并打开 DemoUI，无需控制台操作。复制需要游戏盘有足够空间；下一次准备回放时清理本工具上一份临时副本，原始下载文件保留。用户的 autoexec 和游戏配置不改动。未找到 Steam 或游戏时会提示选择安装位置。Steam 可能要求确认启动选项；确认后继续自动播放。若 CS2 已在运行，请先退出再点击播放。

工作室的解析、录制与剪辑为独立实现，采用通用解析及视频工具库，不使用 Insight 源码。

    npm ci
    npm start
    npm test
    npm run test:desktop
    npm run test:auto
    npm run dist

测试使用独立资料目录、本地模拟比赛服务和人工传输样本，不读取用户的真实账号。真实账号登录、过期录像和网站验证的边界见 TEST-REPORT.md。

内置 7-Zip 组件的许可和源代码链接见 THIRD-PARTY-NOTICES.md。

参考来源：[Steam 个人比赛](https://steamcommunity.com/my/gcpd/730/?tab=matchhistorypremier)、[HLTV 比赛列表](https://www.hltv.org/results)、[Electron 本机加密](https://www.electronjs.org/docs/latest/api/safe-storage)。

## Code signing policy

Free code signing provided by [SignPath.io](https://signpath.io/), certificate by [SignPath Foundation](https://signpath.org/).

- Committer and reviewer: [xiaoiii](https://github.com/xiaoiii)
- Approver: [xiaoiii](https://github.com/xiaoiii)

Every release signing request must be approved manually. Release binaries must be produced from this public repository by the configured GitHub Actions workflow.

### Privacy policy

CS2 Demo Desk does not collect analytics, telemetry, advertising identifiers or crash reports. Steam login cookies are encrypted with the current Windows user's operating-system protection and remain on that computer. The program does not store the user's Steam password.

This program will not transfer any information to other networked systems unless specifically requested by the user or the person installing or operating it. When the user refreshes matches, opens a source page or downloads a demo, the program connects to the selected source, including Steam Community, HLTV and the demo download host shown by that source. Those services apply their own privacy policies.
# 回放按键（1.2.6）

左侧打开“回放按键”，选择暂停/继续、播放面板、播放速度、透视或观察视角等指令，并设置按键。点击“保存并更新 CFG”后，软件生成独立的 `demodesk_controls.cfg`，下次一键播放自动安装到游戏 `game/csgo/cfg` 并加载。支持增加、删除操作，冲突检查、预览、恢复默认以及关闭自动加载。

修改不会立即改变正在运行的游戏。绑定会覆盖游戏同名按键，游戏可能持久保存它；取消绑定或关闭加载不等于恢复原键位，原键位可在游戏设置中恢复。工具不修改用户的 autoexec。
