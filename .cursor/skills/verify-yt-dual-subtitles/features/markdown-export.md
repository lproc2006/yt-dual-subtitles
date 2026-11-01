# Markdown 导出

The popup downloads the current video's captions as a Markdown file in one of three shapes: bilingual, translation only, or source only.

## Sub-features

- `export-dual` downloads `中英对照` with the source paragraph, a blank line, and the translation paragraph.
- `export-translated` downloads `仅译文`.
- `export-source` downloads `仅原文`.
- `export-empty` shows `✗ 无字幕可导出` when the watch page has no cues yet.
- `export-wrong-tab` shows `请先在 YouTube 视频页使用` when the active tab is not a YouTube page.

## How to get to it (user POV)

- Open a watch page and wait until cue text is on screen.
- Open the toolbar popup.
- Under `📄 导出字幕（Markdown）`, choose `中英对照`, `仅译文`, or `仅原文`.
- Choose `导出为 .md 文件`. The browser downloads `<title>-中英对照.md`, `<title>-译文.md`, or `<title>-原文.md`.

## Driving it with verify-ytds

Preconditions:

- `drive captions` has already shown non-empty source and translation lines for this watch URL in this profile. If it exited `2`, export is unmet too.
- The watch tab is the active tab. The helper activates it before the click.
- The default format radio `input[name="fmt"][value="dual"]` is checked unless the recipe changes it.

- **Export bilingual Markdown.** With cues visible, run `node .cursor/skills/verify-yt-dual-subtitles/bin/verify-ytds.mjs popup-click export` or `node .cursor/skills/verify-yt-dual-subtitles/bin/verify-ytds.mjs drive export`. Exit `0` requires `#status` containing `已导出` and a `.md` file whose first line starts with `# `. `drive export` copies that file to `artifacts/export/export.md`.
- **Empty track.** If the overlay has no cues, the same command exits `2` and writes `artifacts/export/unmet.json` with status `✗ 无字幕可导出` or `请先在 YouTube 视频页使用`. Do not treat that status as a successful export.
- **Other formats.** Choosing `仅译文` or `仅原文` is a user action on `input[name="fmt"]`. It is not covered by the default `drive export` command, which leaves the default `中英对照` radio selected. A pass for those formats needs their own downloaded file.

## Gotchas

- The file is built in the popup with a blob URL and an `<a download>` click. A status string without a file in the download directory is not proof.
- The filename is the video title slug plus the format label. Assert the Markdown heading and body, not a byte-identical filename, because the title is the YouTube document title.
- Paragraphs are merged across short cues. The file will not contain one line per cue. It must still contain source text and, for `中英对照` and `仅译文`, translation text.
- Export reads the content script's current segments. It does not call YouTube or Google by itself. If captions never loaded, there is nothing to export.
- `重新翻译当前视频` is the button under the export box. It is not the export button.
