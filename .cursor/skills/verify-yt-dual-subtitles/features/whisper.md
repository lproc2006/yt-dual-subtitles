# 无字幕时的本机 Whisper 识别

When a watch page has no YouTube captions, the extension asks the local service at `127.0.0.1:8765` to recognize speech with Whisper. The audio and the recognition stay on the machine. The extension sends the video id, not the media bytes.

## Sub-features

- `whisper-health` shows the local service is up before a captionless video is opened.
- `whisper-fallback` shows `未找到视频字幕，正在启动本机语音识别…` and then cue text from the recognition.
- `whisper-retry` shows `本机字幕服务暂不可用，N 秒后自动重试…` when the service is down, and keeps retrying instead of a hard load failure.
- `whisper-cache` reuses `server/cache-v3/<videoId>__auto.json` on a later request for the same video.

## How to get to it (user POV)

- Install and start the separate local program with `bun server/server.mjs` from the repository root. Optional environment: `YTDS_COOKIE_BROWSER`, `YTDS_YT_DLP`, `YTDS_PYTHON`.
- Open a YouTube watch URL that has no author captions and no auto captions.
- Read the overlay status, then the cue line after recognition finishes. The first recognition of a long video can take more than 3 minutes.

## Driving it with verify-ytds

Preconditions:

- `curl -sf http://127.0.0.1:8765/health` returns `{"ok":true,"service":"yt-ds-server","version":3}`.
- `YTDS_WHISPER_VIDEO_URL` is a watch URL the operator knows has no YouTube caption tracks.
- Doctor may report `localServiceUp: false`. That does not make the extension unhealthy, and it does make this feature unmet.
- Do not start a second server. Port `8765` is single-tenant. Cleanup does not kill this server, because the harness does not start it.

- **Check the service.** Run `node .cursor/skills/verify-yt-dual-subtitles/bin/verify-ytds.mjs drive whisper`. If `/health` is down, the command exits `2` and writes `artifacts/whisper/unmet.json` with the connection error. That is the required stop. The extension overlay then shows `本机字幕服务暂不可用，N 秒后自动重试…` after a captionless or unreachable YouTube track, which only proves the retry copy, not recognition.
- **Recognize a captionless video.** With the service healthy and `YTDS_WHISPER_VIDEO_URL` set, run the same command. The watch JSON must show overlay status containing `语音识别` or cue text whose source is the local service, and `trackCount` must be `0`. A video that still has YouTube tracks is the captions feature, not this one.

## Gotchas

- `bun`, `yt-dlp`, and the Whisper Python environment are not in a fresh checkout. The extension still loads without them. Absence of the service is not a failed extension install.
- The service reads YouTube with a local browser cookie jar when the video is restricted. The disposable verification profile has no YouTube login, so a cookie-backed run needs `YTDS_COOKIE_BROWSER` pointed at a real Edge or Chrome profile. Do not point the extension's own user-data-dir at that profile.
- `server/cache/` and `server/cache-v3/` are gitignored. Unit tests that open `server/cache/boW53RZdeNg.json` and `server/cache-v3/0-Rr2iho6CI__auto.json` fail with `ENOENT` on a clean tree. Those failures do not prove Whisper works.
- `/health` is unauthenticated. `/captions` and `/status` require header `X-YTDS-Token` equal to `LOCAL_TOKEN` / `ACCESS_TOKEN`. Doctor checks that the two constants match and does not print them.
- A cache hit skips Whisper. Delete only the verification video's `server/cache-v3/<id>__*.json` when the point of the run is to prove a fresh recognition. Do not delete proof artifacts.
