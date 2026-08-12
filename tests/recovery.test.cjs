const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const content = fs.readFileSync(path.join(root, "content", "content.js"), "utf8");
const server = fs.readFileSync(path.join(root, "server", "server.mjs"), "utf8");

test("字幕来源与翻译目标解耦并支持服务恢复自动重试", () => {
  assert.match(content, /const sourceLanguage = "auto"/);
  assert.match(content, /scheduleSourceRetry\(videoId\)/);
  assert.match(content, /phase === "recovering"/);
  assert.match(content, /sourceLanguage === state\.actualTarget/);
  assert.doesNotMatch(content, /setStatus\(`字幕加载失败/);
});

test("固定语言请求可复用相同真实语言的 auto 字幕缓存", () => {
  assert.match(server, /automatic\?\.schemaVersion === SERVICE_VERSION/);
  assert.match(server, /normalizeLanguage\(automatic\.lang\) === requested/);

  const cache = JSON.parse(fs.readFileSync(path.join(root, "server", "cache-v3", "0-Rr2iho6CI__auto.json"), "utf8"));
  assert.equal(cache.lang, "zh");
  assert.equal(cache.source, "youtube-manual");
  assert.ok(cache.segments.length > 400);
});

test("字幕轨道损坏时会继续使用 Whisper，而不是直接结束", () => {
  assert.match(server, /字幕轨道读取失败，改用本机语音识别/);
  assert.match(server, /if \(!validSegments\(segments\)\)/);
  assert.match(server, /const spokenLanguage = \["zh", "en"\]\.includes\(metadataLanguage\)/);
});
