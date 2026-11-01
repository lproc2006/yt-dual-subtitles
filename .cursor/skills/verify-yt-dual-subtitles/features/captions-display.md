# 字幕读取与对照显示

On a YouTube watch page the extension reads the video's captions and shows the current source line and its translation together at the bottom of the player.

## Sub-features

- `captions-mount` injects the overlay on a watch URL.
- `captions-source` shows the original cue in `.yt-ds-source` while the video plays.
- `captions-dual` shows the translation in `.yt-ds-translation` when display mode is `原文 + 译文对照`.
- `captions-translated-only` hides the source line when display mode is `仅译文`.
- `captions-progress` shows the first-run wait in the overlay status and in the popup, instead of a load failure, while extraction or translation is still running.

## How to get to it (user POV)

- Load the unpacked extension, open a watch URL such as `https://www.youtube.com/watch?v=v4F1gFy-hqg` (English sample in `store/REVIEW_NOTES.md`) or `https://www.youtube.com/watch?v=0-Rr2iho6CI` (Chinese sample), and leave `启用字幕翻译` checked.
- Open the toolbar popup `双语字幕助手` and read `#status` while the first run finishes.
- Switch `显示模式` between `原文 + 译文对照` and `仅译文`.

## Driving it with verify-ytds

Preconditions:

- `doctor` reports `worthDriving: true` on the disposable profile.
- `open-watch` reaches a YouTube player whose `playability.status` is `OK` and whose caption track list is non-empty.
- Display mode is `dual`.
- A signed-in Google session is not created by the harness. If the page is `LOGIN_REQUIRED`, stop.

- **Open the video.** Leave the enable switch on and open the English sample. Run `node .cursor/skills/verify-yt-dual-subtitles/bin/verify-ytds.mjs open-watch`. `#yt-ds-main-world-v3` and `#yt-ds-overlay` exist inside `.html5-video-player`. The overlay status moves through `正在识别视频和字幕来源…` and `正在读取 YouTube 字幕…`.
- **Wait for both lines.** Keep the watch tab open through the first-run wait. Run `node .cursor/skills/verify-yt-dual-subtitles/bin/verify-ytds.mjs drive captions`. Exit `0` only when `.yt-ds-source` and `.yt-ds-translation` are both non-empty. `artifacts/captions/overlay.json` records both strings, the watch URL, and the title.
- **Popup progress.** While cues are still loading, the popup `#status` contains `首次通常需 1–3 分钟` or `已就绪`. This is the same document as the toolbar popup. The harness reads it from `chrome-extension://<id>/popup/popup.html` after activating the watch tab.
- **Unmet bot wall.** If `playability.status` is not `OK` or `trackCount` is `0`, `drive captions` exits `2` and writes `artifacts/captions/unmet.json`. That run did not verify cue text.

## Gotchas

- The success status `字幕已就绪 ✓` and `字幕翻译完成 ✓` hide after about 2.2 seconds. Cue text is the proof, not the status chip.
- `本机字幕服务暂不可用，N 秒后自动重试…` means YouTube captions were not obtained and `127.0.0.1:8765` is down. That is not dual display.
- `LOGIN_REQUIRED` with reason `Sign in to confirm you’re not a bot` leaves a `.html5-video-player` and an overlay status, but `video.duration` stays null and there are no caption tracks. Do not treat the mounted overlay as caption proof.
- The first successful video takes 1–3 minutes. Later opens of the same video can come from `chrome.storage.local` and the popup then says `本地缓存`. A fresh profile does not have that cache.
- Switching videos is a separate navigation. `open-watch` with a different URL replaces the watch tab. Prove the second video's cue text on its own; do not reuse the first video's screenshot.
- Fullscreen is the YouTube player control. This harness does not click it. A windowed cue proof does not cover fullscreen.
