# Proving run

This run executed the skill's own commands against unpacked `双语字幕助手 for YouTube` 2.3.0 in Google Chrome 156.0.8078.47. The watch URL was `https://www.youtube.com/watch?v=v4F1gFy-hqg`. Evidence is under `artifacts/`. Cleanup ran afterwards. `doctor` then reported `worthDriving: false`, and the artifact files were still present.

## Proven

`launch` printed:

```text
ready extension=mfcnnpgffdelhlegadfaiedfiklhjacl port=9344 profile=/tmp/ytds-verify/profile popup=双语字幕助手 browser=Chrome/156.0.8078.47
```

`doctor` reported `worthDriving: true`, the version read from `manifest.json` (`2.3.0` on this run), `localTokenMatches: true`, and `localServiceUp: false`. Doctor now requires Manifest V3 and that version field. It does not compare the version to a hardcoded string.

`drive style-cache` exited `0`. The local `artifacts/style-cache/assert.json` had `proved: true`. Large screenshots and accessibility dumps from that run are no longer in git. This file is the checked-in summary:

```json
{ "proved": true, "feature": "style-cache", "captionTextShown": false, "failures": [] }
```

- Baseline popup and overlay: 影院模式, `data-bg=none`, `--font-scale=1.00`, label `100%`.
- After the change: 简洁模式, `data-bg=solid`, `--font-scale=1.40`, label `140%`.
- `chrome.storage.sync` `settings` was `{ "style": "minimal", "fontSize": 140, "background": "solid" }`.
- Clear cache set `#status` to `✓ 本地翻译缓存已清除` and left `chrome.storage.local` with no keys.
- The popup accessibility tree contains `双语字幕助手`, `slider 字号 140%`, and `✓ 本地翻译缓存已清除`.
- `popup.png` shows those controls and the cleared-cache status. `youtube.png` shows the live watch page.

`zsh scripts/build-store-package.sh` exited `0` and wrote `release/bilingual-subtitle-for-youtube-2.3.0.zip` (15 files, 36K). `artifacts/package/build.txt` lists the zip entries. The listing has `manifest.json`, `content/`, `popup/`, `privacy/`, and `icons/`, and does not contain `server/`, `tests/`, or caches.

## Not a pass

`drive captions` exited `2`. YouTube's player response was `LOGIN_REQUIRED` / `Sign in to confirm you’re not a bot`, with `trackCount: 0`. The overlay did mount and its status was `正在读取 YouTube 字幕…`. Cue text was empty (`captionTextShown: false`). See `artifacts/captions/unmet.json`.

`drive export` exited `2`. With no cues loaded, `#status` became `✗ 无字幕可导出` and no Markdown file was downloaded. See `artifacts/export/unmet.json`.

`drive whisper` exited `2`. `http://127.0.0.1:8765/health` did not answer. Bun, yt-dlp, and Whisper were not started. See `artifacts/whisper/unmet.json`. A healthy service and a watch URL are not a pass by themselves. `drive whisper` exits `0` only when recognition cue text is visible and `assert.json` has `proved: true`.

`node --test tests/*.test.cjs` previously exited `1` on a clean tree: 13 passed, 3 failed with `ENOENT` because `server/cache/` and `server/cache-v3/` were gitignored and absent. Those tests now read checked-in fixtures under `tests/fixtures/`. A clean checkout must exit `0`. A missing cache directory is not an accepted failure.

## What this environment did that a normal desktop run still has to cover

- Chrome was started with `--no-sandbox`, `--disable-dev-shm-usage`, and `--disable-gpu`. A desktop sandbox launch was not tested.
- Developer mode was written into the disposable profile's `Preferences` before the first start. The extension was installed with CDP `Extensions.loadUnpacked`. Chrome 156 does not load this extension from `--load-extension`. The README click path through `chrome://extensions` was not used.
- The popup was opened as `chrome-extension://<id>/popup/popup.html` in a background tab. The toolbar icon was not clicked. It is the same `popup/popup.html`.
- No Google account was signed in. The live YouTube response was the bot wall above, so caption text, translation engine, direction change, retranslate, fullscreen, and a real Markdown download were not exercised.
- The local service was not started. `bun` is not installed here. Whisper recognition and a captionless video were not exercised.
- Microsoft Edge was not launched.
- `zsh` was installed from apt so `scripts/build-store-package.sh` could run. A machine without zsh fails that script the same way; the script itself is zsh-only.

Style and cache clearing were driven on the real unpacked extension and a real YouTube document. They do not stand in for the caption, translation, export, or Whisper journeys.
