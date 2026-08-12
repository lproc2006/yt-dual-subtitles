const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("扩展清单按正确顺序加载 v3 核心", () => {
  const root = path.join(__dirname, "..");
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, "2.3.0");
  assert.match(manifest.description, /1–3 分钟/);
  assert.deepEqual(manifest.content_scripts[0].js, [
    "content/timeline.js",
    "content/renderer.js",
    "content/content.js",
  ]);
  for (const relative of manifest.content_scripts[0].js) {
    assert.equal(fs.existsSync(path.join(root, relative)), true, relative);
  }
});

test("商店版声明自动翻译和本机语音识别所需权限", () => {
  const manifest = require("../manifest.json");
  assert.deepEqual(manifest.permissions, ["storage"]);
  assert.deepEqual(manifest.host_permissions, [
    "https://www.youtube.com/*",
    "https://translate.googleapis.com/*",
    "http://127.0.0.1:8765/*",
  ]);
  assert.equal(manifest.optional_host_permissions, undefined);
  assert.equal(JSON.stringify(manifest).includes("video.google.com"), false);
});

test("运行代码自动在线翻译并恢复本机语音识别兜底", () => {
  const root = path.join(__dirname, "..");
  const files = ["content/content.js", "content/main-world.js", "popup/popup.js"];
  const source = files.map(file => fs.readFileSync(path.join(root, file), "utf8")).join("\n");
  for (const forbidden of ["cookies-from-browser", "ACCESS_TOKEN"]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
  assert.doesNotMatch(source, /AIza[0-9A-Za-z_-]{20,}/);
  assert.doesNotMatch(source, /onlineTranslationAllowed|chrome\.permissions\.request/);
  assert.match(source, /translate\.googleapis\.com/);
  assert.match(source, /127\.0\.0\.1:8765/);
  assert.match(source, /localCaptionSource/);
});
