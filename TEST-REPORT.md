# CS2 Demo Desk 1.1 测试报告

测试日期：2026-09-10。环境：Windows 10 x64（10.0.19045），Electron 41.10.7，Node.js 24.16.0。

## 本次新增能力

- 官匹登录后自动获取优先、竞技、搭档记录，默认近 7 天，可刷新或调整 1–365 天。
- Steam 登录凭证使用 Windows safeStorage / DPAPI 在本机加密保存，跨进程恢复，失效需重新登录。
- HLTV 赛事目录自动获取、按赛事分组和筛选，选择下载时自动解析详情页 Demo。
- 日期未知单独标记；分页不完整、登录失效、网站验证与网络失败分别提示，已有数据保留。

## 自动化结果

| 测试组 | 结果 | 内容 |
| --- | --- | --- |
| 基础逻辑、同步引擎、凭证保存、网页解析 | 46 项通过 | 含真实 Electron DOM 和已保存真实 HLTV HTML |
| 原有桌面下载流程回归 | 15 项通过 | 批量下载、重定向、暂停/继续、并发、取消、BZ2/ZIP/RAR/7z 解压、重启记录与剪贴板 |
| 新增自动获取桌面流程 | 9 项通过 | 自动同步、赛事分类、懒解析下载、登录后继续、范围调整、验证提示、实际 Windows 加密、重启恢复和清除凭证 |
| Windows 发布包自动获取回归 | 9 项通过 | 在最终打包程序上重复验证自动获取与凭证恢复 |
| 1.1.0 单文件便携版启动 | 通过 | 自解包、正确版本、中文界面及全新用户资料启动 |

新增自动流程的 9 项验证：

1. 启动自动获取最近 7 天赛事，识别 Steam 需要登录。
2. 对阵和赛事元数据形成分类，赛事筛选真正影响列表。
3. 选中赛事记录后自动查找详情链接，并下载到磁盘。
4. 模拟登录后的页面导航自动继续获取官匹，自动加载更多，以比赛发生日期过滤。
5. 修改界面范围为 30 天后自动获取较早记录。
6. 网站验证不会被绕过，也不会清空已获取记录。
7. 使用真实 Windows safeStorage 加密写盘，文件不包含测试凭证的明文。
8. 关闭并重新启动软件后恢复登录会话和 30 天配置，再次自动获取。
9. 清除登录后删除加密凭证，保留历史比赛和下载。

同时验证了凭证白名单、过期凭证丢弃、不覆盖新的登录状态、清除/保存竞态、缺少加密服务不明文回退，以及三种同步衔接问题：延迟加载的登录后页面、停止后立即刷新、详情验证状态被目录同步覆盖。

原始记录位于 test-results/desktop-report.json、auto-desktop-report.json；发布包回归记录为 auto-packaged-report.json，最终单文件启动检查为 portable-report.json。

## 真实来源检查

最新真实自动获取检查已正确进入以下状态：

- Steam：login_required，跳转到 steamcommunity.com 官方登录页，等待账号本人首次登录。
- HLTV：verification_required，正确识别当前网络的网站验证，提供验证窗口入口。
- 修复了等待全部图片/广告加载导致超时的问题；页面正文准备好后即可识别登录和验证状态。

原始结果：test-results/live-auto-report.json。

已保存的真实 HLTV 比赛 HTML 解析验证通过：BIG vs G2 / FISSURE Playground 3 / 比赛 2397605 / Demo 111176。Steam 真实比赛历史的表格结构和加载更多控件使用公开源码核实，解析测试覆盖这些 DOM 结构。

## 验证边界

桌面自动化使用本地受控比赛网页、独立资料目录及人工传输样本；没有登录用户的真实 Steam 账号，也没有绕过 HLTV 验证。真实个人完整比赛列表和真实赛事包下载仍需账号本人登录及网站允许访问后确认。

微型测试 Demo 用于检查文件传输、解压和保存，不是可播放的实战比赛录像。没有在 CS2 游戏内验证播放；录像过期、未发布与游戏版本兼容性不由此工具决定。

Windows 10 x64 已实测，Windows 11 x64 尚未单独实测。跨进程重试从头下载，不承诺断点续传。自动翻页最多 20 页，达到上限会标记部分结果。

## 参考

[Steam 个人比赛](https://steamcommunity.com/my/gcpd/730/?tab=matchhistorypremier) · [HLTV 真实样例](https://www.hltv.org/matches/2397605/big-vs-g2-fissure-playground-3) · [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage) · [Electron 下载行为](https://www.electronjs.org/docs/latest/api/download-item/)
