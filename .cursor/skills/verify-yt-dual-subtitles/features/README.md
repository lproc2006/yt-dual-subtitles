# 双语字幕助手 verification map

This directory is the maintained source for verifying the user-facing behavior of the unpacked Chrome extension 双语字幕助手 for YouTube. Read the index before driving the app, then use the matching feature file as the recipe.

## Baseline preconditions

- Launch with `node .cursor/skills/verify-yt-dual-subtitles/bin/verify-ytds.mjs launch` and require the `ready extension=` line.
- Run `node .cursor/skills/verify-yt-dual-subtitles/bin/verify-ytds.mjs doctor` and require `worthDriving: true`, Manifest V3 with the version read from `manifest.json`, and the disposable profile `/tmp/ytds-verify/profile`.
- The profile starts empty. There is no Google account and no translation cache.
- Default watch URL is `https://www.youtube.com/watch?v=v4F1gFy-hqg` unless `YTDS_WATCH_URL` is set.
- Never drive an instance that was not started by this verification run. Never use `/usr/local/bin/google-chrome` or `/home/ubuntu/.config/google-chrome`.
- One Chrome profile and one debugging port per run. One process on `127.0.0.1:8765` if Whisper is under test.

## Driving conventions

- Start every recipe from the baseline state unless its preconditions say otherwise.
- Drive the popup through `popup-set` and `popup-click`, and the watch page through `open-watch`.
- Prefer the ids and accessible names in each feature file over coordinates.
- Treat every command as literal. Keep quoted UI strings unchanged.
- Restore a fresh profile with cleanup plus launch after a run that changes settings or cache. Cleanup leaves local proof artifacts on disk. Those files are gitignored and are not required in the checkout.

## Proof and skip reporting

- Capture the user action and the resulting state, not only the final screen.
- UI proof includes the overlay dataset or cue text, the popup status string, an accessibility snapshot, and a screenshot.
- Mutation proof for settings includes `chrome.storage.sync` read back from the popup. Mutation proof for cache clear includes `chrome.storage.local` key list `[]`.
- Export proof includes the downloaded Markdown file, not only the status string.
- Record the feature id and entry point with every artifact.
- Exit code `2` and `artifacts/<feature>/unmet.json` mean the path was not verified. Do not report that path as verified through style changes or unit tests.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with verify-ytds` starts with `Preconditions:` and uses labeled bullets that pair each user action with an exact command and observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

## Features

- [字幕读取与对照显示](./captions-display.md) covers loading a watch page, mounting the overlay, and showing source plus translation together.
- [本地与在线翻译](./translation.md) covers the local translator, Google fallback, direction, and the engine named in the popup.
- [无字幕时的本机 Whisper 识别](./whisper.md) covers the local service on `127.0.0.1:8765` when YouTube has no captions.
- [样式与缓存清除](./style-cache.md) covers cinema/minimal, font size, background, and clearing the local translation cache.
- [Markdown 导出](./markdown-export.md) covers bilingual, translation-only, and source-only Markdown downloads.
