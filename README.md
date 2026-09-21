# CS2 Demo Desk 1.2.6 — Windows 自动获取版

中文 CS2 比赛录像下载工具。个人官匹和赛事目录自动获取，勾选后下载；无需每场手动导入。独立项目，与 Valve、Steam、HLTV 无隶属关系。

## 完美平台 Demo

“完美平台”页面支持通过 SteamID64 和完美平台 `access_token` 获取近期个人比赛，并将可用 Demo 加入现有下载队列。凭证使用 Windows 本机加密保存，不写入比赛库、下载记录或日志；每次下载时才生成短期签名地址。默认显示最近 7 天，可调整为 1–365 天。

点击“使用 Steam 登录完美平台”，在官方窗口完成 Steam 登录、Steam Guard 和授权。软件自动从本次独立会话中取得 SteamID 和完美平台令牌，捕获密钥并识别账号后由 Windows 加密保存，再刷新最近一周比赛（比赛接口失败不会丢弃凭证）；无需手动找密钥。登录窗口关闭后清理临时会话，不保存 Steam 密码。重新打开软件可继续使用已保存的平台凭证，过期后点击重新登录；也可切换账号或清除凭证。

“手动填写（备用）”保留给已有凭证的用户。完美平台接口变化可能需要升级软件。自动登录的完整流程已通过模拟官方服务的 Windows 测试，真实账号授权及下载仍需在本机实测。

## 运行

从 GitHub Releases 下载 `CS2-Demo-Desk-1.1.0-Windows-x64.exe` 后双击运行，无需安装 Node.js。可用同一 Release 中的 `SHA256-1.1.0.txt` 校验文件。程序尚未购买代码签名证书，Windows 首次运行时可能显示未知发布者提示。支持 Windows 10 / 11 x64；已在 Windows 10 x64 实测。

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

此功能为独立实现的游戏启动入口，尚未嵌入 CS2 Insight Agent 的后端、2D 回放或插件。Insight Agent 当前使用 PolyForm Noncommercial 许可证；本项目没有复制其代码。

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
