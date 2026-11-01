# 样式与缓存清除

The popup changes how the player overlay looks, and it can delete the on-device translation cache without removing those style settings.

## Sub-features

- `style-preset` switches `影院模式` and `简洁模式`.
- `style-fontsize` changes the overlay scale from the 80–160% slider.
- `style-background` switches `无（描边）`, `半透明黑底`, and `实心黑底`.
- `cache-clear` deletes `chrome.storage.local` and shows `✓ 本地翻译缓存已清除`.

## How to get to it (user POV)

- Open any YouTube watch page so the content script is running. The English sample `https://www.youtube.com/watch?v=v4F1gFy-hqg` is enough even before cue text exists.
- Open the toolbar popup `双语字幕助手`.
- Change `预设`, `字号`, and `背景` under `字幕样式`.
- Choose `清除本地翻译缓存`.

## Driving it with verify-ytds

Preconditions:

- `doctor` reports `worthDriving: true`.
- `open-watch` has mounted `#yt-ds-overlay`. Cue text is not required. A `LOGIN_REQUIRED` player still mounts the overlay; record that in `watch.json` and do not call it caption proof.
- Run this once per fresh launch. A second drive in the same profile still works because the recipe sets the baseline itself.

- **Open the video.** Run `node .cursor/skills/verify-yt-dual-subtitles/bin/verify-ytds.mjs open-watch`. `#yt-ds-overlay` and `#yt-ds-main-world-v3` are present.
- **Baseline style.** Choose 影院模式, 100%, and 无（描边）. Run `node .cursor/skills/verify-yt-dual-subtitles/bin/verify-ytds.mjs popup-set --style cinema --font-size 100 --background none`. The overlay has `data-style=cinema`, `data-bg=none`, and `--font-scale=1.00`.
- **Change style.** Choose 简洁模式, 140%, and 实心黑底. Run `node .cursor/skills/verify-yt-dual-subtitles/bin/verify-ytds.mjs popup-set --style minimal --font-size 140 --background solid`. `#fontsize-label` is `140%`. The overlay has `data-style=minimal`, `data-bg=solid`, and `--font-scale=1.40`. `chrome.storage.sync` `settings` is `{ "style": "minimal", "fontSize": 140, "background": "solid" }`.
- **Clear the cache.** Choose `清除本地翻译缓存`. Run `node .cursor/skills/verify-yt-dual-subtitles/bin/verify-ytds.mjs popup-click clear-cache`. `#status` contains `本地翻译缓存已清除` and `chrome.storage.local` has no keys. Sync settings stay on the minimal/140/solid values.
- **Proof.** Run `node .cursor/skills/verify-yt-dual-subtitles/bin/verify-ytds.mjs drive style-cache`. It performs the four steps above and writes `artifacts/style-cache/`. Exit `0` prints `proved style-cache evidence=.cursor/skills/verify-yt-dual-subtitles/artifacts/style-cache`. `assert.json` has `proved: true`.

## Gotchas

- The popup's 3 second `updateStatus` timer replaces `#status`. Read the clear-cache confirmation within that window. `popup-click clear-cache` polls for 2 seconds inside the popup document.
- If the popup tab is the active tab, `#status` says `请在 YouTube 视频页使用`. Style changes still apply, because they only write `chrome.storage.sync`. The helper activates the watch tab before tab-sensitive clicks.
- `--font-scale` is the inline style with two decimals. Compare `1.40`, not `1.4`.
- Clear cache does not reset style, direction, or the enable switch. Those live in `chrome.storage.sync`.
- An empty cache still shows `✓ 本地翻译缓存已清除`. Pair that string with `localKeys: []`. On a fresh profile the key list was already empty, so the status string is the evidence the button ran, and the key list is the evidence nothing remained.
- Do not use this journey to claim dual cue text. `assert.json` field `captionTextShown` is false when the source and translation lines are empty.
