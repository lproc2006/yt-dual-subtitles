const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.join(__dirname, "..");
const harnessPath = path.join(root, ".cursor/skills/verify-yt-dual-subtitles/bin/verify-ytds.mjs");

test("doctor 读取清单版本且不钉死版本号", async () => {
  const harness = await import("../.cursor/skills/verify-yt-dual-subtitles/bin/verify-ytds.mjs");
  const source = fs.readFileSync(harnessPath, "utf8");
  assert.equal(source.includes("2.3.0"), false);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  assert.equal(harness.manifestIsDriveable(manifest), true);
  assert.equal(harness.manifestIsDriveable({ ...manifest, version: "9.9.9" }), true);
  assert.equal(harness.manifestIsDriveable({ ...manifest, manifest_version: 2 }), false);
  assert.equal(harness.manifestIsDriveable({ ...manifest, version: "  " }), false);
  assert.equal(harness.manifestIsDriveable({ ...manifest, name: "other" }), false);
  assert.equal(harness.tokenMatch(), true);

  const skill = fs.readFileSync(path.join(root, ".cursor/skills/verify-yt-dual-subtitles/SKILL.md"), "utf8");
  const features = fs.readFileSync(path.join(root, ".cursor/skills/verify-yt-dual-subtitles/features/README.md"), "utf8");
  assert.equal(skill.includes("2.3.0"), false);
  assert.equal(features.includes("2.3.0"), false);
  assert.match(skill, /manifest\.json/);
  const whisperDoc = fs.readFileSync(path.join(root, ".cursor/skills/verify-yt-dual-subtitles/features/whisper.md"), "utf8");
  assert.doesNotMatch(whisperDoc, /ENOENT/);
  assert.match(whisperDoc, /proved: true/);
});

test("drive whisper 仅在识别字幕出现时判定通过", async () => {
  const harness = await import("../.cursor/skills/verify-yt-dual-subtitles/bin/verify-ytds.mjs");
  const source = fs.readFileSync(harnessPath, "utf8");
  assert.match(source, /recognition cues were not shown/);
  assert.doesNotMatch(source, /cue text still has to be confirmed/);
  assert.equal(harness.whisperCueProved({ source: "hello", translation: "", trackCount: 0 }), true);
  assert.equal(harness.whisperCueProved({ source: "", translation: "你好", trackCount: 0 }), true);
  assert.equal(harness.whisperCueProved({
    source: "",
    translation: "",
    trackCount: 0,
    status: "未找到视频字幕，正在启动本机语音识别…",
  }), false);
  assert.equal(harness.whisperCueProved({ source: "hello", trackCount: 2 }), false);
  assert.equal(harness.whisperCueProved({ source: "  ", trackCount: 0 }), false);
  assert.equal(harness.whisperCueProved({}), false);
});

test("发布包脚本拒绝 LOCAL_TOKEN 和固定 X-YTDS-Token 十六进制字面量", () => {
  const script = fs.readFileSync(path.join(root, "scripts/build-store-package.sh"), "utf8");
  assert.match(script, /store-zip-denylist\.regex/);
  const pattern = fs.readFileSync(path.join(root, "scripts/store-zip-denylist.regex"), "utf8").trim();
  assert.match(pattern, /LOCAL_TOKEN/);
  assert.match(pattern, /ACCESS_TOKEN/);
  assert.match(pattern, /X-YTDS-Token/);

  assert.match(script, /unzip -p/);
  if (!fs.existsSync("/usr/bin/zip") || !fs.existsSync("/usr/bin/unzip") || !fs.existsSync("/usr/bin/grep")) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ytds-zip-"));
  fs.writeFileSync(path.join(dir, "bad.js"), [
    'const LOCAL_TOKEN = "0123456789abcdef0123456789abcdef";',
    'const header = { "X-YTDS-Token": "0123456789abcdef0123456789abcdef" };',
    "",
  ].join("\n"));
  fs.writeFileSync(path.join(dir, "good.js"), 'const headers = { "X-YTDS-Token": token };\n');
  const badZip = path.join(dir, "bad.zip");
  const goodZip = path.join(dir, "good.zip");
  assert.equal(spawnSync("zip", ["-q", badZip, "bad.js"], { cwd: dir }).status, 0);
  assert.equal(spawnSync("zip", ["-q", goodZip, "good.js"], { cwd: dir }).status, 0);
  const leakStatus = (zip) => {
    const unzipped = spawnSync("unzip", ["-p", zip]);
    return spawnSync("grep", ["-E", "-q", "-a", "--", pattern], { input: unzipped.stdout }).status;
  };
  assert.equal(leakStatus(badZip), 0);
  assert.equal(leakStatus(goodZip), 1);
});
