# 双语字幕助手 for YouTube 2.3

在 YouTube 视频页读取视频字幕，优先使用浏览器本地翻译，必要时自动使用 Google 在线翻译；视频没有字幕时，可调用本机 Whisper 语音识别。

> **首次处理请耐心等待 1–3 分钟。** 扩展会一次性提取并翻译整段字幕，处理完成后，同一视频会优先复用本地缓存。视频长度、字幕数量、网络状况和本机性能会影响实际时间。

本项目不是 YouTube、Google 或 Microsoft 的官方产品，也未获得这些公司的认可或背书。

## 核心功能

- 优先读取作者字幕或 YouTube 自动字幕。
- 自动判断中英文，也可手动指定英译中或中译英。
- 优先在浏览器本地翻译；本地能力不可用时自动使用 Google 在线翻译。
- 视频没有字幕时，连接本机字幕服务下载音频并使用 Whisper 识别。
- 支持原文与译文对照、仅译文、字号、背景和显示预设。
- 支持把当前字幕导出为 Markdown 原文、译文或双语稿。
- 翻译结果仅缓存在用户本机，可从扩展面板一键清除。
- 首次打开视频时明确显示处理进度和 1–3 分钟等待提示，避免把正常缓冲误认为加载失败。

## 隐私设计

- 扩展没有账号系统、广告、分析统计或开发者服务器。
- 浏览器本地翻译不可用时，当前视频字幕文本会自动发送给 Google 翻译。
- 没有字幕时，扩展只向本机 `127.0.0.1` 服务发送视频 ID；本机服务可能使用本机浏览器的 YouTube Cookie 请求视频信息和音频，并在本机运行 Whisper。
- 本机服务会自动尝试 Edge 和 Chrome 的 YouTube 会话；可用 `YTDS_COOKIE_BROWSER=edge` 或 `YTDS_COOKIE_BROWSER=chrome` 明确指定。
- 完整说明见 `privacy/privacy.html` 和 `PRIVACY.md`。

## 开发环境安装

1. 在 Chrome 打开 `chrome://extensions`，或在 Edge 打开 `edge://extensions`。
2. 开启“开发者模式”。
3. 选择“加载已解压的扩展程序”，并选择本项目目录。
4. 打开带有英文或中文字幕的 YouTube 视频进行验证。

## 发布包

运行：

```sh
./scripts/build-store-package.sh
```

脚本会在 `release/` 生成只包含扩展运行文件的 ZIP，并检查发布包中是否混入本地服务源码、Cookie 文件、缓存或测试文件。本机语音识别服务需作为独立配套程序安装。

商店文案、权限说明、审核步骤及素材清单位于 `store/`。公开产品主页、隐私政策和支持页位于 `docs/`，通过 GitHub Pages 发布。

## 支持与隐私

- 产品主页：https://lproc2006.github.io/yt-dual-subtitles/
- 隐私政策：https://lproc2006.github.io/yt-dual-subtitles/privacy.html
- 问题反馈：https://github.com/lproc2006/yt-dual-subtitles/issues

## 测试

```sh
node --test tests/*.test.cjs
```

自动测试之外，还应分别在最新版 Chrome 和 Edge 中验证：字幕读取、本地翻译、在线翻译授权与撤销、缓存清除、全屏显示、切换视频和 Markdown 导出。
