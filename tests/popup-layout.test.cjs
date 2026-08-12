const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const css = fs.readFileSync(path.join(__dirname, "..", "popup", "popup.css"), "utf8");
const html = fs.readFileSync(path.join(__dirname, "..", "popup", "popup.html"), "utf8");
const script = fs.readFileSync(path.join(__dirname, "..", "popup", "popup.js"), "utf8");

test("扩展弹窗根页面和内容使用相同固定宽度", () => {
  assert.match(css, /html\s*\{[\s\S]*?width:\s*332px/);
  assert.match(css, /html\s*\{[\s\S]*?max-width:\s*332px/);
  assert.match(css, /body\s*\{[\s\S]*?width:\s*332px/);
  assert.match(css, /body\s*\{[\s\S]*?max-width:\s*332px/);
  assert.match(css, /\*, \*::before, \*::after\s*\{[\s\S]*?box-sizing:\s*border-box/);
});

test("弹窗首屏明确告知首次字幕处理耗时", () => {
  assert.match(html, /首次处理请耐心等待 1–3 分钟/);
  assert.match(html, /一次性提取并翻译整段字幕/);
  assert.match(script, /首次通常需 1–3 分钟/);
});
