const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const core = require("../content/timeline.js");

test("重叠、倒序和无效时间段会被规范化", () => {
  const input = [
    { text: "second sentence", start: 2, end: 6 },
    { text: "first sentence", start: 0, end: 4 },
    { text: "invalid", start: 7, end: 6 },
  ];
  const output = core.normalizeSegments(input, "en");
  const result = core.validateTimeline(output);
  assert.equal(result.ok, true, result.errors.join(","));
  assert.equal(output[0].start, 0);
  assert.ok(output.every(cue => cue.end > cue.start));
});

test("滚动自动字幕的重复前缀会被移除", () => {
  const output = core.normalizeSegments([
    { text: "we are building a reliable subtitle", start: 0, end: 4 },
    { text: "a reliable subtitle system for everyone", start: 2, end: 6 },
  ], "en");
  assert.equal(core.validateTimeline(output).ok, true);
  assert.ok(output.some(cue => cue.text.includes("system for everyone")));
  assert.equal(output.filter(cue => cue.text.includes("a reliable subtitle")).length, 1);
});

test("中英文断行最多返回两行", () => {
  const english = core.breakLines("This is a deliberately long English subtitle that should break near a natural word boundary instead of splitting a word.", "en");
  const chinese = core.breakLines("这是一条用于测试专业字幕断行效果的较长中文句子，应当优先在自然语义位置换行。", "zh");
  assert.ok(english.length <= 2);
  assert.ok(chinese.length <= 2);
  assert.equal(english.join(" ").includes("split ting"), false);
});

test("字幕已经可显示时，后续异常不会被归类为加载失败", () => {
  const segments = [
    { text: "first", start: 0, end: 1 },
    { text: "second", start: 1, end: 2 },
  ];
  assert.equal(core.classifySubtitleOutcome([], []).kind, "load-error");
  assert.equal(core.classifySubtitleOutcome(segments, []).kind, "source-only");
  assert.equal(core.classifySubtitleOutcome(segments, ["第一条", ""]).kind, "partial");
  assert.equal(core.classifySubtitleOutcome(segments, ["第一条", "第二条"]).kind, "ready");
});

test("自动和固定翻译方向会得到稳定目标语言", () => {
  assert.equal(core.targetLanguageFor("zh-Hant", "auto"), "en");
  assert.equal(core.targetLanguageFor("en-US", "auto"), "zh");
  assert.equal(core.targetLanguageFor("zh-Hant", "zh-CN"), "zh");
  assert.equal(core.targetLanguageFor("en-US", "en"), "en");
});

test("固定方向找不到预期源语言时仍保留现有字幕", () => {
  const traditionalChinese = { languageCode: "zh-Hant", baseUrl: "https://example.test/zh", kind: "manual" };
  const englishAutomatic = { languageCode: "en-US", baseUrl: "https://example.test/en", kind: "asr" };

  assert.equal(core.selectCaptionTrack([traditionalChinese], "en"), traditionalChinese);
  assert.equal(core.selectCaptionTrack([traditionalChinese], "zh-CN"), traditionalChinese);
  assert.equal(core.selectCaptionTrack([traditionalChinese, englishAutomatic], "zh-CN"), englishAutomatic);
});

test("现有全部源字幕缓存规范化后均生成有效时间轴", () => {
  const cacheDir = path.join(__dirname, "..", "server", "cache");
  const files = fs.readdirSync(cacheDir).filter(file => file.endsWith(".json"));
  assert.ok(files.length >= 20);
  for (const file of files) {
    const data = JSON.parse(fs.readFileSync(path.join(cacheDir, file), "utf8"));
    const normalized = core.normalizeSegments(data.segments, data.lang);
    const result = core.validateTimeline(normalized);
    assert.equal(result.ok, true, `${file}: ${result.errors.slice(0, 5).join(",")}`);
  }
});

test("无 YouTube 字幕的视频可从 Whisper 缓存恢复", () => {
  const cacheFile = path.join(__dirname, "..", "server", "cache", "boW53RZdeNg.json");
  const data = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
  assert.equal(data.source, "whisper");
  assert.ok(data.segments.length > 1000);
  const normalized = core.normalizeSegments(data.segments, data.lang);
  assert.equal(core.validateTimeline(normalized).ok, true);
});
