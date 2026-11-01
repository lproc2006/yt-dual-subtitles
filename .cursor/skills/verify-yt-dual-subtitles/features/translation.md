# 本地与在线翻译

The extension translates the whole caption track, trying the browser's local translator first and sending the cue text to Google Translate only when local translation is unavailable. The popup names the engine that produced the current text.

## Sub-features

- `translate-auto-direction` picks 中文 for English cues and English for Chinese cues when direction is `自动识别（推荐）`.
- `translate-fixed-direction` follows `英文 → 中文` (`zh-CN`) or `中文 → 英文` (`en`) from `#direction`.
- `translate-local` uses the in-browser translator and the popup says `浏览器本地`.
- `translate-google` falls back to `translate.googleapis.com` and the popup says `Google 在线`.
- `translate-cache` reloads a finished track and the popup says `本地缓存`.
- `translate-same-language` leaves the source untranslated when it already matches the target, with status `原文已是中文，无需翻译 ✓` or `原文已是英文，无需翻译 ✓`.

## How to get to it (user POV)

- Open a watch page with captions and wait for the first translation to finish.
- Open the toolbar popup and read `#status` for the engine name.
- Change `翻译方向` in `#direction`. The popup says `已切换方向，正在重新加载字幕…` and the overlay reloads.
- Choose `🔄 重新翻译当前视频` (`#retranslate-btn`) to drop the current video's translation cache and translate again.

## Driving it with verify-ytds

Preconditions:

- The captions journey can reach non-empty `.yt-ds-source` and `.yt-ds-translation`. If `drive captions` exits `2`, this feature is unmet for the same reason.
- Direction starts at `auto`.
- Doctor reports `localTokenMatches: true` before anyone starts the local caption service. Translation itself does not need that service when YouTube captions exist.

- **Finish a first translation.** Run `node .cursor/skills/verify-yt-dual-subtitles/bin/verify-ytds.mjs drive captions`. After both cue lines are visible, activate the watch tab and read popup `#status`. The status contains one of `浏览器本地`, `Google 在线`, or `本地缓存`, and it contains `已就绪` once translation has finished.
- **Confirm the network side effect for Google.** If the status says `Google 在线`, a request to `translate.googleapis.com` occurred for this video's cue text. If the status says `浏览器本地`, that request is not required. Record which string was shown in `artifacts/captions/overlay.json` alongside the cue text. Do not claim the other engine.
- **Fixed direction and retranslate.** These stay user actions on `#direction` and `#retranslate-btn`. They are not a passing `drive` until cue text reloads after the change. Do not mark them verified from the style-cache run.

## Gotchas

- Local translation depends on the browser Translator API. This Chrome build often reports it unavailable, and the extension then uses Google without asking for an extra permission. The popup copy says that directly.
- A partial result uses the status `字幕已显示，部分译文暂未完成`. That is not `已就绪`.
- `#direction` writes `chrome.storage.sync` `targetLang`. The content script forces a reload only when the value is `en` or `zh-CN`; `auto` is the default.
- `重新翻译当前视频` removes one `ytds:v3:<videoId>:<source>:<target>` local key and reloads. `清除本地翻译缓存` removes every local key. They are different buttons.
- Same-language videos hide the translation line and copy the source into the export. Do not require a second language in `.yt-ds-translation` when the status says `无需翻译`.
- The 1–3 minute wait is one-shot for the whole track. Poll the cue text or the popup status. Do not fail the run at a fixed 10 second sleep.
