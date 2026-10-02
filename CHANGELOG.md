# Changelog

## 1.3.1

- Read local CS2 VPK radar textures and overview coordinates; add map layers and player headings with a coordinate-grid fallback.
- Independently parse real DEM voice messages, including compressed frames, to display activity timelines and transparent OBS HUD previews. Audio decoding, transcription and live game synchronization are not included.
- Require execution acknowledgements and confirmed starting/ending game ticks for recording. Start OBS before advancing playback; preserve partial clips on wrong POV, missing GSI, seeks, early pauses and cancellation.
- Preserve OBS capture ownership after stop failures, clean only unchanged owned GSI files, and pin/verify the generic Source2Viewer texture decoder.

## 1.3.0 — 独立复盘工作室与 Windows 安装版

- 交付改为 NSIS 安装程序，可选择安装目录、建立快捷方式并从 Windows 卸载，沿用现有用户资料。
- 独立实现 DEM 玩家战绩、关键回合分析、坐标回放、OBS POV 录制、剪辑项目与 AI 点评/选片；没有引入 Insight 原源码或运行时。
- 视频剪辑支持排序、裁剪、速度、音量、中文标题、色调与淡入淡出；内置视频工具导出 MP4。
- AI 选片可进入录制队列，并将对应完整录制素材按选片顺序生成剪辑项目。
- 高级 DEM 外观/资源重写尚未实现；真实 OBS 与 CS2 联录未作现场验证。

## 1.2.11

- Automatically extract supported downloads from all sources into CS2 game/csgo/replays; save direct DEM downloads there too.
- Detect existing replay directories through Steam libraries, request a folder when unavailable, and persist the selected destination. Add replay folder settings and shortcuts.
- Preserve source downloads and existing replays, use exclusive collision-safe output names, retain failures for retry, and wait for output saving before automatic exit.

## 1.2.10

- Automatically extract newly downloaded personal BZ2 demos, preserve the original archive and expose the resulting DEM for one-click playback.
- Keep extraction visible as active work and wait for it before completion auto-exit. Preserve failed archives and allow manual extraction retries.
- Coalesce simultaneous extraction requests, reuse valid completed results, isolate retry output from partial files, and handle output scanning failures without crashing.

## 1.2.9

- Add an embedded Steam web accelerator with a saved switch and connectivity test. The app starts its own loopback HTTPS bridge, uses encrypted DNS and compatible TLS handshakes, and validates upstream certificate chains and original hostnames. No external proxy address is required.
- Pin temporary certificates only within the app's source/login sessions. Do not modify Windows trust, hosts or system proxy settings; restore session networking and stop the bridge when disabled or exiting.
- Add the Windows tray, close-to-background behavior, task-aware menu, bottom shortcut bar and taskbar download progress. Explicit exit and completion auto-exit terminate the app even with the tray enabled.
- Verify redirects, Secure HttpOnly cookies and authenticated POST forwarding through the bridge. Preserve the existing Perfect World credential capture and encrypted storage flow.

## 1.2.8

- Add independent settings for Windows login startup, downloading missing demos on app launch, and exiting after successful downloads.
- Register the persistent portable EXE path instead of Electron's temporary extraction path; inspect the named Windows login entry and respect disabled startup items.
- Refresh selected sources before queuing recent undownloaded matches. Skip completed, cancelled and undated records; allow official, Perfect World and tournament sources to be selected independently.
- Wait for sync, downloads, pauses, extraction and playback preparation; retain the window on failures or incomplete source results. Successful completion shows a cancellable ten-second exit countdown.

## 1.2.7

- Make the replay controls tab easier to configure: commands display Chinese function names and each binding has a keyboard capture button.
- Press a key to bind it; detect conflicts immediately, cancel with Escape, and reject unsupported combinations. Keep dropdown selection for mouse buttons and wheel directions.

## 1.2.6

- Add a replay controls editor with common commands, editable action names and key assignments, duplicate-key validation, add/remove, reset, enable switch and CFG preview.
- Saving regenerates demodesk_controls.cfg in the local profile and updates the known CS2 installation; one-click playback installs and loads the saved configuration automatically.
- Preserve editor drafts across navigation and saved settings across restarts. Changes apply on the next replay launch; existing game bindings are not automatically restored.
- Keep the Steam 730 game-local demo/CFG autoplay flow verified in 1.2.5.

## 1.2.5

- Prepare a game-local replay copy with a short ASCII filename and an isolated CFG, then launch Steam AppID 730 with +exec for automatic playback and DemoUI.
- Avoid passing external paths with spaces to playdemo during startup; preserve user autoexec and original downloaded files.
- Clean up only the previous generated replay/config/log when preparing the next playback, and prevent concurrent playback preparation.
- Real CS2 log verification confirmed the generated config executed and demo playback started.

## 1.2.4

- Launch replay playback through steam.exe -applaunch 730 instead of directly executing cs2.exe.
- Pass playdemo and DemoUI launch arguments automatically; remove forced console opening and manual console instructions.
- Detect Steam installation and reject legacy cs2.exe selections. Report an already-running CS2 before issuing a launch that Steam would ignore.

## 1.2.3

- Fixed duplicate case-insensitive Steam ID request headers being combined into invalid comma-separated values, causing Perfect World error 1033 even with valid captured credentials.
- Removed duplicate headers from both match listing and Demo download requests.
- Show sanitized platform error codes instead of incorrectly attributing all rejections to expired tokens.
- Cap recent-match requests at the accepted 20-record limit and recognize the API's date field.

## 1.2.2

- Separate capturing and encrypting official login credentials from fetching match history; a match API outage no longer discards captured credentials.
- Capture mixed query/fragment callbacks and short-lived HTTP redirects, with polling for delayed cookies.
- Add account identification from the same login session's own Steam profile and official page/callback identity; ambiguous account identities remain rejected.
- Show separate capture, identity and save states, and record secret-free diagnostic flags locally.

## 1.2.1

- Added a dedicated official Steam login window for Perfect World Arena, automatically capturing the platform token and Steam identity from the isolated session.
- Validate credentials before saving with Windows encryption, then refresh matches automatically.
- Added login cancellation, temporary session cleanup, account switching, and stale refresh protection after credential changes.
- Moved manual token entry into a collapsed fallback section.

## 1.2.0

- Added one-click CS2 playback with DemoUI, Steam library detection, and individual replay selection inside archives.

- Added a dedicated Perfect World Arena source for recent personal matches.
- Added just-in-time signed PWA Demo downloads with required request headers.
- Added Windows-encrypted storage for SteamID64 and PWA access tokens.
- Added a configurable 1–365 day range for Perfect World Arena records.

## 1.1.0 — 2026-09-10

- Automatically fetch recent Steam Premier, Competitive, and Wingman matches after login.
- Keep the Steam session encrypted on the local Windows account and restore it on restart.
- Default to the last seven days, with refresh and adjustable 1–365 day ranges.
- Automatically fetch recent tournament matches and group them by event.
- Resolve tournament Demo links when selected for download.
- Preserve cached records when login expires, a source requests verification, or the network fails.
- Keep manual URL import, download queue controls, archive extraction, and local Demo playback commands.
