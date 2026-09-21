# Changelog

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
