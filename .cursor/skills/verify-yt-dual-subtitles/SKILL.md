---
name: verify-yt-dual-subtitles
description: "Drive the unpacked Chrome extension 双语字幕助手 for YouTube on a YouTube watch page and its popup, then capture proof. Use when changing content/, popup/, manifest.json, server/, or store packaging and a change must be shown on the real surface. The fast unit gate is node --test tests/*.test.cjs."
---

# Verify 双语字幕助手 for YouTube

Primary surface: Manifest V3 unpacked extension `双语字幕助手 for YouTube` (version read from `manifest.json`) loaded into Google Chrome and driven on `https://www.youtube.com/watch`. The popup is `popup/popup.html`. Secondary surfaces are the local caption service `server/server.mjs` on `127.0.0.1:8765` and the store zip from `scripts/build-store-package.sh`. There is no package.json and no Playwright suite. The harness is `.cursor/skills/verify-yt-dual-subtitles/bin/verify-ytds.mjs`. It talks to system Chrome over the DevTools Protocol. Run every command from the repository root.

Chrome 156 does not honor `--load-extension` (`DisableLoadExtensionCommandLineSwitch` is not in the binary). Launch uses `Extensions.loadUnpacked` after writing `extensions.ui.developer_mode` into a disposable profile. Do not use `/usr/local/bin/google-chrome`. That wrapper always prepends `--user-data-dir=/home/ubuntu/.config/google-chrome` and `--remote-debugging-port=9222`.

## Launch

Preconditions: `DISPLAY` is set, `/usr/bin/google-chrome-stable` exists, and no verification instance is already running.

```sh
node .cursor/skills/verify-yt-dual-subtitles/bin/verify-ytds.mjs launch
```

The helper starts `/usr/bin/google-chrome-stable` with a new profile at `/tmp/ytds-verify/profile` and a free debugging port beginning at `9344`:

```text
--user-data-dir=/tmp/ytds-verify/profile
--remote-debugging-port=<port>
--no-first-run
--no-default-browser-check
--disable-sync
--no-sandbox
--disable-dev-shm-usage
--disable-gpu
--window-size=1280,800
about:blank
```

It then calls `Extensions.loadUnpacked` with the repository root and opens `chrome-extension://<id>/popup/popup.html` in the background. Ready is this stdout line, and the popup document contains the heading `双语字幕助手` plus the note `首次处理请耐心等待 1–3 分钟`:

```text
ready extension=<id> port=<port> profile=/tmp/ytds-verify/profile popup=双语字幕助手 browser=Chrome/<version>
```

A process that only answers on the debugging port is not ready. The extension id comes from `Extensions.loadUnpacked`. It is a hash of the checkout path, so do not hard-code it. State is `/tmp/ytds-verify/run.json`. Chrome's log is `/tmp/ytds-verify/chrome.log`.

One launch at a time. A second `launch` exits `2` while that pid is alive. The profile is disposable and starts empty: no Google sign-in, no translation cache, default popup settings (`启用字幕翻译` on, direction `自动识别（推荐）`, mode `原文 + 译文对照`, style `影院模式`, font `100%`, background `无（描边）`).

`--no-sandbox` is required in this container. A desktop Chrome that starts with the sandbox can drop that flag only after a headed launch without it actually stays up. Do not point the profile at the operator's daily Chrome data.

Teardown is `cleanup` below. Launch failure runs cleanup itself so a half-started Chrome is not left behind.

The local Whisper service is not part of launch. Start it only for the Whisper feature, and only one process may bind `127.0.0.1:8765`:

```sh
bun server/server.mjs
```

Ready for that process is the log line `[yt-ds-server] v3 running at http://127.0.0.1:8765` and `curl -sf http://127.0.0.1:8765/health` returning `{"ok":true,"service":"yt-ds-server","version":3}`. It needs Bun, `yt-dlp` (`YTDS_YT_DLP` or `~/bin/yt-dlp`), and Python (`YTDS_PYTHON`). Optional cookie source: `YTDS_COOKIE_BROWSER=edge` or `YTDS_COOKIE_BROWSER=chrome`.

## Doctor

Read-only. Run this first whenever the instance looks wrong. Exit `0` means worth driving. Exit `1` means do not drive.

```sh
node .cursor/skills/verify-yt-dual-subtitles/bin/verify-ytds.mjs doctor
```

Stdout is one JSON object. `worthDriving` is true only when all of these hold:

- `run.json` exists, its pid is alive and not a zombie, and `/proc/<pid>/cmdline` contains both `/tmp/ytds-verify/profile` and that debugging port.
- The debugging port answers `/json/version`.
- The popup heading is exactly `双语字幕助手`.
- `manifest.json` is Manifest V3, `name` is `双语字幕助手 for YouTube`, and `version` is the non-empty version read from that file. Doctor does not compare the version to a hardcoded string.
- These files exist: `content/content.js`, `content/renderer.js`, `content/timeline.js`, `content/main-world.js`, `content/service-worker.js`, `content/overlay.css`, `popup/popup.html`, `popup/popup.js`, `icons/icon128.png`.
- The extension and local service pair at runtime. The server writes `server/.local-token` on first start. `content/service-worker.js` calls `GET /pair`, and the content script stores the token in `chrome.storage.local` as `ytdsLocalServiceToken`. Later requests send `X-YTDS-Token`. `localTokenMatches` is true only when that handshake is present and no fixed token literal ships in the extension or the server. Doctor does not print the token.

`localServiceUp` is informational. A down service still leaves the extension worth driving. It blocks only `drive whisper`. Doctor does not click, navigate, or kill processes.

## Drive

User-visible handles:

| Surface | Handle |
| --- | --- |
| Popup heading | `双语字幕助手` |
| Enable | `#enabled` (`启用字幕翻译`) |
| Direction | `#direction` values `auto`, `zh-CN`, `en` |
| Mode | `#mode` values `dual`, `translated` |
| Style | `#style` values `cinema`, `minimal` |
| Font | `#fontsize` range 80–160 step 10, label `#fontsize-label` |
| Background | `#background` values `none`, `translucent`, `solid` |
| Status | `#status` |
| Export format | `input[name="fmt"]` values `dual`, `translated`, `source` |
| Export | `#export-btn` |
| Retranslate | `#retranslate-btn` |
| Clear cache | `#clear-cache-btn` |
| Watch overlay | `#yt-ds-overlay` inside `.html5-video-player` |
| Cue lines | `#yt-ds-overlay .yt-ds-source`, `#yt-ds-overlay .yt-ds-translation` |
| Overlay status | `#yt-ds-overlay .yt-ds-status` |
| Injected bridge | `#yt-ds-main-world-v3` |

The overlay carries `data-style` (`cinema` or `minimal`), `data-bg` (`none`, `translucent`, or `solid`), and inline `--font-scale` (`1.00` at 100%, `1.40` at 140%). Content-script messages `yt-ds-get-state`, `yt-ds-set-enabled`, `yt-ds-retranslate`, and `yt-ds-export` exist, but proof goes through the popup controls and the overlay, not those messages.

Default watch URL, from `store/REVIEW_NOTES.md`: `https://www.youtube.com/watch?v=v4F1gFy-hqg`. Override with `YTDS_WATCH_URL`. The Chinese sample in that note is `https://www.youtube.com/watch?v=0-Rr2iho6CI`.

Open the watch page and wait until `#yt-ds-overlay` and `#yt-ds-main-world-v3` exist (up to 45s):

```sh
node .cursor/skills/verify-yt-dual-subtitles/bin/verify-ytds.mjs open-watch
```

Apply popup style. The command waits until the overlay dataset and `--font-scale` match, then prints the controls, the overlay, and `chrome.storage.sync`:

```sh
node .cursor/skills/verify-yt-dual-subtitles/bin/verify-ytds.mjs popup-set --style cinema --font-size 100 --background none
node .cursor/skills/verify-yt-dual-subtitles/bin/verify-ytds.mjs popup-set --style minimal --font-size 140 --background solid
```

`--style` is `cinema` or `minimal`. `--background` is `none`, `translucent`, or `solid`. `--font-size` is an integer from 80 to 160 in steps of 10.

Activate the watch tab, then click a popup button. Tab-sensitive buttons (`#export-btn`, `#retranslate-btn`, `#status`) read `chrome.tabs.query({ active: true })`. The helper opens the popup as a background tab and activates the watch tab before the click, because a real toolbar popup does not become the active tab. Clicking the puzzle-piece toolbar icon is browser chrome and is not scripted.

```sh
node .cursor/skills/verify-yt-dual-subtitles/bin/verify-ytds.mjs popup-click clear-cache
node .cursor/skills/verify-yt-dual-subtitles/bin/verify-ytds.mjs popup-click export
```

Mapped drives:

```sh
node .cursor/skills/verify-yt-dual-subtitles/bin/verify-ytds.mjs drive style-cache
node .cursor/skills/verify-yt-dual-subtitles/bin/verify-ytds.mjs drive captions
node .cursor/skills/verify-yt-dual-subtitles/bin/verify-ytds.mjs drive export
node .cursor/skills/verify-yt-dual-subtitles/bin/verify-ytds.mjs drive whisper
```

`drive style-cache` is the journey that sets 影院/100%/无, then 简洁/140%/实心, then clears the local translation cache, and writes evidence. Exit `0` only when the overlay, `chrome.storage.sync`, the clear-cache status, and an empty `chrome.storage.local` all match. Exit `2` from the other drives means an unmet precondition (bot wall, no caption file, local service down). That is not a pass. Do not weaken the expected cue text or the downloaded Markdown to make them pass.

Fast unit gate, from a clean checkout. Exit status is the test runner's status. `server/cache/` and `server/cache-v3/` stay gitignored. Tests that need caption JSON read `tests/fixtures/` instead, so `node --test` passes without those caches.

```sh
node --test tests/*.test.cjs
node .cursor/skills/verify-yt-dual-subtitles/bin/verify-ytds.mjs unit
```

Store package gate. Requires `/usr/bin/zsh` because `scripts/build-store-package.sh` uses zsh parameter expansion. The script reads the version from `manifest.json` and writes `release/bilingual-subtitle-for-youtube-<version>.zip`. It fails if the zip contains `server/`, `tests/`, caches, `LOCAL_TOKEN`, `ACCESS_TOKEN`, a fixed `X-YTDS-Token` hex literal, or another cookie/token marker, or if it lacks `manifest.json`, `content/content.js`, `content/service-worker.js`, `content/main-world.js`, `popup/popup.html`, `privacy/privacy.html`, or `icons/icon128.png`.

```sh
zsh scripts/build-store-package.sh
node .cursor/skills/verify-yt-dual-subtitles/bin/verify-ytds.mjs package
```

## Evidence

Proof artifacts are written under `.cursor/skills/verify-yt-dual-subtitles/artifacts/<feature>/` when a drive runs. That directory is gitignored. Cleanup does not delete it on disk. A clean checkout does not contain it, and the files are not required in git. `PROOF.md` is the checked-in summary. Screenshots and accessibility dumps are local evidence only.

`drive style-cache` writes:

- `watch.json` — watch URL, playability, caption track count, overlay status, whether the main-world script and overlay mounted.
- `baseline.json` — popup controls and overlay after 影院 / 100% / 无（描边）. Expect `data-style=cinema`, `data-bg=none`, `--font-scale=1.00`.
- `changed.json` — the same after 简洁 / 140% / 实心黑底. Expect `data-style=minimal`, `data-bg=solid`, `--font-scale=1.40`, and `chrome.storage.sync` `settings` `{ style: "minimal", fontSize: 140, background: "solid" }`.
- `cache-clear.json` — `#status` containing `本地翻译缓存已清除` and `localKeys: []`.
- `ax-popup.txt`, `ax-youtube.txt` — accessibility role and name lines. The popup tree includes `双语字幕助手`.
- `popup.png`, `youtube.png` — screenshots of the popup document and the watch page after the change.
- `assert.json` — `proved: true` only when every check above passed. `captionTextShown` records whether cue text was visible. Style proof does not require cue text.

A pass requires the user action and the resulting state: the overlay dataset, the sync storage read back from the popup, and the local storage key list after clear. The popup control value alone is not proof. Screenshots alone are not proof.

`drive captions` passes only when `.yt-ds-source` and `.yt-ds-translation` are both non-empty. It writes `overlay.json` or, on a bot wall, `unmet.json` with `playability.status`. `LOGIN_REQUIRED` / `Sign in to confirm you’re not a bot` is an unmet precondition. Do not borrow cookies from `/home/ubuntu/.config/google-chrome`.

`drive export` passes only when `#status` contains `已导出` and a downloaded `.md` file starts with `# `. Otherwise it writes `artifacts/export/unmet.json`. The real toolbar download is a blob save named from the video title plus `中英对照`, `译文`, or `原文`.

`drive whisper` exits `0` only when recognition cue text is visible (`.yt-ds-source` or `.yt-ds-translation` is non-empty), `trackCount` is `0`, and `artifacts/whisper/assert.json` has `proved: true`. `/health`, `YTDS_WHISPER_VIDEO_URL`, and a status string that only contains `语音识别` are not a pass. If the service is down, the URL is unset, YouTube caption tracks are still present, or no cue appears before the wait ends, the command exits `2` and writes `artifacts/whisper/unmet.json`. The wait is 8 minutes unless `YTDS_WHISPER_CUE_TIMEOUT_MS` is set.

`unit` writes `artifacts/unit/node-test.txt`. `package` writes `artifacts/package/build.txt` (script stdout plus `unzip -Z1`).

Mocks: do not stub `chrome.storage` or the overlay. Google Translate and YouTube are the real sites. The only isolated external system is the optional local service on `127.0.0.1:8765`, and only a real process counts. A fresh profile has no translation cache, so a successful caption run is a first-run 1–3 minute wait, not a cache hit.

The first proving run's report is `PROOF.md` next to this file. Read it before treating captions, translation, export, or Whisper as already covered.

## Cleanup

```sh
node .cursor/skills/verify-yt-dual-subtitles/bin/verify-ytds.mjs cleanup
```

This SIGTERMs the pid in `run.json` (the process group, then the pid), SIGKILLs it if it is still alive after 5 seconds, and deletes `/tmp/ytds-verify/profile`, `/tmp/ytds-verify/downloads`, `/tmp/ytds-verify/run.json`, and `/tmp/ytds-verify/chrome.log`. It deletes the profile only when the path is under `/tmp/ytds-verify/`. It does not kill Chrome by name, does not touch `/home/ubuntu/.config/google-chrome`, does not stop whatever is on port `8765` (this helper never starts it), and does not delete `.cursor/skills/verify-yt-dual-subtitles/artifacts/`. After cleanup, `doctor` exits `1` because no instance is running. Local artifact files, if a drive already wrote them, remain on disk. They are gitignored and are not required in the checkout.

Run cleanup after every failed launch or drive so the next launch is not blocked by a leftover pid or profile.

## Helpers

The only helper is the executable `bin/verify-ytds.mjs`. Invoke it with `node` so the shebang is irrelevant:

```sh
node .cursor/skills/verify-yt-dual-subtitles/bin/verify-ytds.mjs launch
node .cursor/skills/verify-yt-dual-subtitles/bin/verify-ytds.mjs doctor
node .cursor/skills/verify-yt-dual-subtitles/bin/verify-ytds.mjs open-watch
node .cursor/skills/verify-yt-dual-subtitles/bin/verify-ytds.mjs popup-set --style minimal --font-size 140 --background solid
node .cursor/skills/verify-yt-dual-subtitles/bin/verify-ytds.mjs popup-click clear-cache
node .cursor/skills/verify-yt-dual-subtitles/bin/verify-ytds.mjs drive style-cache
node .cursor/skills/verify-yt-dual-subtitles/bin/verify-ytds.mjs drive captions
node .cursor/skills/verify-yt-dual-subtitles/bin/verify-ytds.mjs drive export
node .cursor/skills/verify-yt-dual-subtitles/bin/verify-ytds.mjs drive whisper
node .cursor/skills/verify-yt-dual-subtitles/bin/verify-ytds.mjs unit
node .cursor/skills/verify-yt-dual-subtitles/bin/verify-ytds.mjs package
node .cursor/skills/verify-yt-dual-subtitles/bin/verify-ytds.mjs cleanup
```

`open-watch` prints the overlay JSON. `popup-set` prints controls, overlay, and `chrome.storage.sync`. `popup-click` prints `#status` and, for clear-cache, the local storage keys. `drive style-cache` prints `proved style-cache evidence=.cursor/skills/verify-yt-dual-subtitles/artifacts/style-cache` on success.

## Maintenance

When the popup, overlay, or manifest changes, update this skill and the feature map with `/maintain-verification-skill`. Re-run `drive style-cache` after a harness change. Re-run `drive captions` on a signed-in Chrome profile before claiming cue text, translation, or Markdown export.
