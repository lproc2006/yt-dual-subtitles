#!/usr/bin/env node
// Verification harness for the unpacked extension 双语字幕助手 for YouTube.
// Speaks Chrome DevTools Protocol to /usr/bin/google-chrome-stable. No npm dependencies.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const skillDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(skillDir, "../../..");
const stateDir = "/tmp/ytds-verify";
const runPath = path.join(stateDir, "run.json");
const profileDir = path.join(stateDir, "profile");
const chromeLogPath = path.join(stateDir, "chrome.log");
const defaultWatchUrl = "https://www.youtube.com/watch?v=v4F1gFy-hqg";
const localHealthUrl = "http://127.0.0.1:8765/health";

const chromeCandidates = ["/usr/bin/google-chrome-stable", "/usr/bin/google-chrome"];

function die(message, code = 1) {
  console.error(message);
  process.exit(code);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function loadRun() {
  if (!fs.existsSync(runPath)) return null;
  return readJson(runPath);
}

function manifestInfo() {
  const manifest = readJson(path.join(repoRoot, "manifest.json"));
  return manifest;
}

export function manifestIsDriveable(manifest) {
  return Boolean(
    manifest
    && manifest.manifest_version === 3
    && manifest.name === "双语字幕助手 for YouTube"
    && typeof manifest.version === "string"
    && manifest.version.trim().length > 0
  );
}

export function tokenMatch() {
  const shippedPaths = ["content/content.js", "content/service-worker.js", "content/main-world.js", "popup/popup.js"];
  const shipped = shippedPaths.map((relative) => fs.readFileSync(path.join(repoRoot, relative), "utf8")).join("\n");
  const server = fs.readFileSync(path.join(repoRoot, "server", "server.mjs"), "utf8");
  const fixedLiteral = /(?:LOCAL_TOKEN|ACCESS_TOKEN)\s*=\s*["'][0-9a-fA-F]{16,}["']/;
  const fixedHeader = /X-YTDS-Token["']?\s*[:=]\s*["'][0-9a-fA-F]{16,}["']/;
  if (fixedLiteral.test(shipped) || fixedLiteral.test(server) || fixedHeader.test(shipped) || fixedHeader.test(server)) {
    return false;
  }
  const content = fs.readFileSync(path.join(repoRoot, "content", "content.js"), "utf8");
  const worker = fs.readFileSync(path.join(repoRoot, "content", "service-worker.js"), "utf8");
  const contentOk = content.includes("ytdsLocalServiceToken")
    && content.includes("X-YTDS-Token")
    && content.includes("yt-ds-pair")
    && content.includes("chrome.storage.local");
  const workerOk = worker.includes("/pair") && worker.includes("yt-ds-pair");
  const serverOk = server.includes("/pair")
    && server.includes("loadOrCreateAccessToken")
    && server.includes("x-ytds-token")
    && server.includes(".local-token");
  return contentOk && workerOk && serverOk;
}

export function whisperCueProved(overlay) {
  const source = String(overlay?.source || "").trim();
  const translation = String(overlay?.translation || "").trim();
  return Number(overlay?.trackCount || 0) === 0 && Boolean(source || translation);
}

function resolveChromeBin() {
  return chromeCandidates.find((candidate) => fs.existsSync(candidate)) || "";
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const state = stat.split(") ")[1]?.[0];
    return state && state !== "Z";
  } catch {
    return false;
  }
}

function cmdlineOf(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`).toString("utf8").replaceAll("\0", " ");
  } catch {
    return "";
  }
}

async function fetchJson(url, timeoutMs = 3000) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`${url} HTTP ${response.status}`);
  return response.json();
}

async function localService() {
  try {
    const body = await fetchJson(localHealthUrl, 1500);
    const up = body?.ok === true && body?.service === "yt-ds-server" && body?.version === 3;
    return { up, body };
  } catch (error) {
    return { up: false, error: error.message };
  }
}

class Session {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        this.pending.get(message.id)(message);
        this.pending.delete(message.id);
      }
    });
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CDP open timed out for ${url}`)), 8000);
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error(`CDP open failed for ${url}`));
      });
    });
    return new Session(ws);
  }

  send(method, params = {}, timeoutMs = 20000) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CDP timeout ${method}`)), timeoutMs);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        if (message.error) reject(new Error(`${method}: ${message.error.message}`));
        else resolve(message.result || {});
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.ws.close();
  }
}

async function evaluate(session, expression) {
  const payload = await session.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (payload.exceptionDetails) {
    const details = payload.exceptionDetails;
    throw new Error(details.exception?.description || details.text || "Runtime.evaluate failed");
  }
  return payload.result?.value;
}

async function browserSession(run) {
  const version = await fetchJson(`http://127.0.0.1:${run.port}/json/version`);
  return { version, session: await Session.connect(version.webSocketDebuggerUrl) };
}

async function listTargets(run) {
  return fetchJson(`http://127.0.0.1:${run.port}/json/list`);
}

function requireRun() {
  const run = loadRun();
  if (!run) die("no verification instance. Run launch first.");
  if (!pidAlive(run.pid)) die(`verification Chrome pid ${run.pid} is not running. Run cleanup, then launch.`);
  const cmdline = cmdlineOf(run.pid);
  if (!cmdline.includes(run.profile) || !cmdline.includes(String(run.port))) {
    die(`pid ${run.pid} is not the verification Chrome for ${run.profile}. Refusing to drive it.`);
  }
  return run;
}

const overlayExpression = `(() => {
  const root = document.querySelector("#yt-ds-overlay");
  const video = document.querySelector("video");
  const player = window.ytInitialPlayerResponse;
  const tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  return {
    href: location.href,
    title: document.title,
    mainWorld: !!document.getElementById("yt-ds-main-world-v3"),
    overlay: !!root,
    status: document.querySelector("#yt-ds-overlay .yt-ds-status")?.textContent || "",
    source: document.querySelector("#yt-ds-overlay .yt-ds-source")?.innerText || "",
    translation: document.querySelector("#yt-ds-overlay .yt-ds-translation")?.innerText || "",
    style: root?.dataset?.style || "",
    background: root?.dataset?.bg || "",
    fontScale: root?.style?.getPropertyValue("--font-scale")?.trim() || "",
    playability: player?.playabilityStatus
      ? { status: player.playabilityStatus.status, reason: player.playabilityStatus.reason || "" }
      : null,
    trackCount: tracks.length,
    tracks: tracks.slice(0, 6).map((track) => ({
      language: track.languageCode || "",
      kind: track.kind || "",
      name: track.name?.simpleText || track.name?.runs?.map((part) => part.text).join("") || "",
    })),
    videoDuration: Number.isFinite(video?.duration) ? video.duration : null,
    videoTime: Number.isFinite(video?.currentTime) ? video.currentTime : null,
  };
})()`;

async function connectTarget(run, predicate, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const targets = await listTargets(run);
    const target = targets.find(predicate);
    if (target?.webSocketDebuggerUrl) {
      const session = await Session.connect(target.webSocketDebuggerUrl);
      return { target, session, targets };
    }
    await delay(200);
  }
  throw new Error("CDP target did not appear");
}

async function openWatch(run, url = process.env.YTDS_WATCH_URL || defaultWatchUrl) {
  const targets = await listTargets(run);
  const existing = targets.find((target) => target.type === "page" && target.url.startsWith(url));
  if (!existing) {
    const blank = targets.find((target) => target.type === "page" && target.url.startsWith("about:"));
    const { session: browser } = await browserSession(run);
    try {
      if (blank) {
        const page = await Session.connect(blank.webSocketDebuggerUrl);
        try {
          await page.send("Page.enable");
          await page.send("Page.navigate", { url });
        } finally {
          page.close();
        }
      } else {
        await browser.send("Target.createTarget", { url });
      }
    } finally {
      browser.close();
    }
  }
  const { target, session } = await connectTarget(
    run,
    (candidate) => candidate.type === "page" && candidate.url.startsWith(url),
  );
  try {
    const started = Date.now();
    let last = null;
    while (Date.now() - started < 45000) {
      last = await evaluate(session, overlayExpression);
      if (last?.overlay && last?.mainWorld) {
        last.targetId = target.id;
        return last;
      }
      await delay(300);
    }
    throw new Error(`YouTube overlay did not mount within 45s: ${JSON.stringify(last)}`);
  } finally {
    session.close();
  }
}

async function readOverlay(run) {
  const { session } = await connectTarget(
    run,
    (candidate) => candidate.type === "page" && candidate.url.includes("youtube.com/watch"),
    8000,
  );
  try {
    return await evaluate(session, overlayExpression);
  } finally {
    session.close();
  }
}

async function ensurePopup(run) {
  const popupUrl = `chrome-extension://${run.extensionId}/popup/popup.html`;
  let targets = await listTargets(run);
  let popup = targets.find((target) => target.type === "page" && target.url.startsWith(popupUrl));
  if (!popup) {
    const { session: browser } = await browserSession(run);
    try {
      try {
        await browser.send("Target.createTarget", { url: popupUrl, background: true });
      } catch {
        await browser.send("Target.createTarget", { url: popupUrl });
      }
    } finally {
      browser.close();
    }
  }
  const connected = await connectTarget(
    run,
    (candidate) => candidate.type === "page" && candidate.url.startsWith(popupUrl),
  );
  const started = Date.now();
  let text = "";
  while (Date.now() - started < 10000) {
    text = await evaluate(
      connected.session,
      `document.body ? document.body.innerText.slice(0, 500) : ""`,
    );
    if (String(text).includes("双语字幕助手") && String(text).includes("首次处理请耐心等待 1–3 分钟")) {
      return connected;
    }
    if (String(text).includes("blocked") || String(text).includes("ERR_BLOCKED_BY_CLIENT")) {
      connected.session.close();
      throw new Error(`extension popup blocked: ${String(text).slice(0, 240)}`);
    }
    await delay(200);
  }
  connected.session.close();
  throw new Error(`popup did not render: ${String(text).slice(0, 240)}`);
}

async function activateWatch(run) {
  const targets = await listTargets(run);
  const watch = targets.find((target) => target.type === "page" && target.url.includes("youtube.com/watch"));
  if (!watch) throw new Error("no YouTube watch tab to activate");
  const { session: browser } = await browserSession(run);
  try {
    await browser.send("Target.activateTarget", { targetId: watch.id });
  } finally {
    browser.close();
  }
  return watch;
}

function fontScaleFor(fontSize) {
  return (Number(fontSize) / 100).toFixed(2);
}

async function popupSet(run, { style, fontSize, background }) {
  const popup = await ensurePopup(run);
  try {
    const controls = await evaluate(popup.session, `(() => {
      const style = document.querySelector("#style");
      const background = document.querySelector("#background");
      const fontsize = document.querySelector("#fontsize");
      style.value = ${JSON.stringify(style)};
      style.dispatchEvent(new Event("change", { bubbles: true }));
      background.value = ${JSON.stringify(background)};
      background.dispatchEvent(new Event("change", { bubbles: true }));
      fontsize.value = ${JSON.stringify(String(fontSize))};
      fontsize.dispatchEvent(new Event("input", { bubbles: true }));
      return {
        style: style.value,
        background: background.value,
        fontSize: fontsize.value,
        label: document.querySelector("#fontsize-label").textContent,
        mode: document.querySelector("#mode").value,
      };
    })()`);
    const expectedScale = fontScaleFor(fontSize);
    const started = Date.now();
    let overlay = null;
    while (Date.now() - started < 8000) {
      overlay = await readOverlay(run);
      if (
        overlay.style === style
        && overlay.background === background
        && overlay.fontScale === expectedScale
      ) break;
      await delay(150);
    }
    const stored = await evaluate(popup.session, `new Promise((resolve) => chrome.storage.sync.get(["settings", "mode"], resolve))`);
    return { controls, overlay, stored, expectedScale };
  } finally {
    popup.session.close();
  }
}

async function popupClick(run, which) {
  await activateWatch(run);
  const popup = await ensurePopup(run);
  try {
    if (which === "clear-cache") {
      return await evaluate(popup.session, `(() => {
        document.querySelector("#clear-cache-btn").click();
        return new Promise(async (resolve) => {
          const started = Date.now();
          let status = "";
          while (Date.now() - started < 2000) {
            status = document.querySelector("#status").textContent || "";
            if (status.includes("本地翻译缓存已清除")) break;
            await new Promise((r) => setTimeout(r, 50));
          }
          const local = await new Promise((resolveLocal) => chrome.storage.local.get(null, resolveLocal));
          resolve({ status, localKeys: Object.keys(local || {}) });
        });
      })()`);
    }
    if (which === "export") {
      const downloadDir = path.join(stateDir, "downloads");
      fs.mkdirSync(downloadDir, { recursive: true });
      for (const entry of fs.readdirSync(downloadDir)) fs.unlinkSync(path.join(downloadDir, entry));
      const { session: browser } = await browserSession(run);
      try {
        await browser.send("Browser.setDownloadBehavior", {
          behavior: "allow",
          downloadPath: downloadDir,
          eventsEnabled: true,
        });
      } catch (error) {
        console.error(`download behavior unavailable: ${error.message}`);
      } finally {
        browser.close();
      }
      const clicked = await evaluate(popup.session, `(() => {
        const before = document.querySelector("#status").textContent || "";
        document.querySelector("#export-btn").click();
        return new Promise(async (resolve) => {
          const started = Date.now();
          let status = before;
          const settled = (value) => ["已导出", "无字幕可导出", "导出失败", "请先在 YouTube"].some((part) => value.includes(part));
          while (Date.now() - started < 4000) {
            status = document.querySelector("#status").textContent || "";
            if (status !== before && settled(status)) break;
            await new Promise((r) => setTimeout(r, 50));
          }
          const format = document.querySelector('input[name="fmt"]:checked')?.value || "";
          resolve({ status, format, before });
        });
      })()`);
      await delay(500);
      const files = fs.readdirSync(downloadDir).filter((name) => name.endsWith(".md"));
      return { ...clicked, downloadDir, files };
    }
    throw new Error(`unknown popup control ${which}`);
  } finally {
    popup.session.close();
  }
}

async function accessibilityText(run, predicate) {
  const { session } = await connectTarget(run, predicate, 8000);
  try {
    await session.send("Accessibility.enable");
    const tree = await session.send("Accessibility.getFullAXTree");
    const lines = [];
    for (const node of tree.nodes || []) {
      const role = node.role?.value || "";
      const name = String(node.name?.value || "").replace(/\s+/g, " ").trim();
      if (!name) continue;
      lines.push(`${role}\t${name.slice(0, 200)}`);
    }
    return lines.join("\n");
  } finally {
    session.close();
  }
}

async function screenshot(run, predicate, file) {
  const { session } = await connectTarget(run, predicate, 8000);
  try {
    const shot = await session.send("Page.captureScreenshot", { format: "png" });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(shot.data, "base64"));
  } finally {
    session.close();
  }
}

function evidenceDir(feature) {
  const dir = path.join(skillDir, "artifacts", feature);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function unmet(feature, payload) {
  const dir = evidenceDir(feature);
  writeJson(path.join(dir, "unmet.json"), payload);
  console.error(JSON.stringify(payload));
  process.exit(2);
}

async function driveStyleCache(run) {
  const watch = await openWatch(run);
  const baseline = await popupSet(run, { style: "cinema", fontSize: 100, background: "none" });
  const changed = await popupSet(run, { style: "minimal", fontSize: 140, background: "solid" });
  const cleared = await popupClick(run, "clear-cache");
  const dir = evidenceDir("style-cache");
  writeJson(path.join(dir, "watch.json"), watch);
  writeJson(path.join(dir, "baseline.json"), baseline);
  writeJson(path.join(dir, "changed.json"), changed);
  writeJson(path.join(dir, "cache-clear.json"), cleared);
  const popupUrl = `chrome-extension://${run.extensionId}/popup/popup.html`;
  const axPopup = await accessibilityText(run, (target) => target.url.startsWith(popupUrl));
  const axWatch = await accessibilityText(run, (target) => target.type === "page" && target.url.includes("youtube.com/watch"));
  fs.writeFileSync(path.join(dir, "ax-popup.txt"), `${axPopup}\n`);
  fs.writeFileSync(path.join(dir, "ax-youtube.txt"), `${axWatch}\n`);
  await screenshot(run, (target) => target.url.startsWith(popupUrl), path.join(dir, "popup.png"));
  await screenshot(
    run,
    (target) => target.type === "page" && target.url.includes("youtube.com/watch"),
    path.join(dir, "youtube.png"),
  );
  const failures = [];
  const expect = (ok, message) => { if (!ok) failures.push(message); };
  expect(watch.overlay === true && watch.mainWorld === true, "content script did not mount #yt-ds-overlay and #yt-ds-main-world-v3");
  expect(baseline.overlay?.style === "cinema" && baseline.overlay?.background === "none" && baseline.overlay?.fontScale === "1.00", `baseline overlay was ${baseline.overlay?.style}/${baseline.overlay?.background}/${baseline.overlay?.fontScale}`);
  expect(changed.controls?.style === "minimal" && changed.controls?.label === "140%" && changed.controls?.background === "solid", `popup controls were ${JSON.stringify(changed.controls)}`);
  expect(changed.overlay?.style === "minimal" && changed.overlay?.background === "solid" && changed.overlay?.fontScale === "1.40", `changed overlay was ${changed.overlay?.style}/${changed.overlay?.background}/${changed.overlay?.fontScale}`);
  expect(changed.stored?.settings?.style === "minimal" && changed.stored?.settings?.fontSize === 140 && changed.stored?.settings?.background === "solid", `storage.sync settings were ${JSON.stringify(changed.stored?.settings)}`);
  expect(String(cleared.status || "").includes("本地翻译缓存已清除"), `cache status was ${cleared.status}`);
  expect(Array.isArray(cleared.localKeys) && cleared.localKeys.length === 0, `storage.local keys were ${JSON.stringify(cleared.localKeys)}`);
  expect(axPopup.includes("双语字幕助手"), "popup accessibility tree missing 双语字幕助手");
  expect(fs.statSync(path.join(dir, "popup.png")).size > 1000, "popup screenshot missing");
  expect(fs.statSync(path.join(dir, "youtube.png")).size > 1000, "youtube screenshot missing");
  const report = {
    proved: failures.length === 0,
    feature: "style-cache",
    extensionId: run.extensionId,
    watchUrl: watch.href,
    playability: watch.playability,
    captionTextShown: Boolean(watch.source || watch.translation || changed.overlay?.source || changed.overlay?.translation),
    failures,
  };
  writeJson(path.join(dir, "assert.json"), report);
  if (failures.length) die(failures.join("\n"));
  console.log(`proved style-cache evidence=${path.relative(repoRoot, dir)}`);
}

async function driveCaptions(run) {
  const watch = await openWatch(run);
  const blocked = !watch.playability || watch.playability.status !== "OK" || !watch.trackCount;
  if (blocked) {
    unmet("captions", {
      feature: "captions",
      reason: "YouTube did not return a playable caption track",
      playability: watch.playability,
      trackCount: watch.trackCount,
      overlayStatus: watch.status,
      href: watch.href,
    });
  }
  const started = Date.now();
  let last = watch;
  while (Date.now() - started < 180000) {
    last = await readOverlay(run);
    if (last.source && last.translation) break;
    if (String(last.status).includes("失败") || String(last.status).includes("暂不可用")) break;
    await delay(2000);
  }
  const dir = evidenceDir("captions");
  writeJson(path.join(dir, "overlay.json"), last);
  if (!(last.source && last.translation)) {
    unmet("captions", {
      feature: "captions",
      reason: "source and translation lines were not both visible",
      overlay: last,
    });
  }
  console.log("proved captions");
}

async function driveExport(run) {
  await openWatch(run);
  const result = await popupClick(run, "export");
  const success = String(result.status || "").includes("已导出");
  const file = result.files?.[0] ? path.join(result.downloadDir, result.files[0]) : "";
  const markdown = file && fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  if (!success || !markdown.startsWith("# ")) {
    unmet("export", {
      feature: "export",
      reason: "Markdown download was not produced",
      status: result.status,
      files: result.files,
    });
  }
  const dir = evidenceDir("export");
  fs.writeFileSync(path.join(dir, "export.md"), markdown);
  writeJson(path.join(dir, "export.json"), result);
  console.log(`proved export evidence=${path.relative(repoRoot, dir)}`);
}

function whisperFailedStatus(status) {
  const text = String(status || "");
  return text.includes("失败") || text.includes("暂不可用") || text.includes("未能生成");
}

function writeWhisperAssert(dir, overlay, proved) {
  writeJson(path.join(dir, "assert.json"), {
    proved,
    feature: "whisper",
    cueTextShown: Boolean(String(overlay?.source || "").trim() || String(overlay?.translation || "").trim()),
    source: overlay?.source || "",
    translation: overlay?.translation || "",
    status: overlay?.status || "",
    trackCount: overlay?.trackCount ?? null,
  });
}

async function driveWhisper(run) {
  const health = await localService();
  if (!health.up) {
    unmet("whisper", {
      feature: "whisper",
      reason: "local caption service is not answering /health",
      health,
      start: "bun server/server.mjs",
    });
  }
  const videoUrl = process.env.YTDS_WHISPER_VIDEO_URL || "";
  if (!videoUrl) {
    unmet("whisper", {
      feature: "whisper",
      reason: "YTDS_WHISPER_VIDEO_URL is unset. Set it to a watch URL with no YouTube captions.",
      health,
    });
  }
  const previous = process.env.YTDS_WATCH_URL;
  process.env.YTDS_WATCH_URL = videoUrl;
  let watch;
  try {
    watch = await openWatch(run, videoUrl);
  } finally {
    if (previous === undefined) delete process.env.YTDS_WATCH_URL;
    else process.env.YTDS_WATCH_URL = previous;
  }
  const dir = evidenceDir("whisper");
  const timeoutMs = Number(process.env.YTDS_WHISPER_CUE_TIMEOUT_MS) || 8 * 60 * 1000;
  const started = Date.now();
  let last = watch;
  while (Date.now() - started < timeoutMs) {
    if (whisperCueProved(last) || Number(last?.trackCount || 0) > 0 || whisperFailedStatus(last?.status)) break;
    await delay(2000);
    last = await readOverlay(run);
  }
  writeJson(path.join(dir, "watch.json"), last);
  const proved = whisperCueProved(last);
  writeWhisperAssert(dir, last, proved);
  if (!proved) {
    unmet("whisper", {
      feature: "whisper",
      reason: Number(last?.trackCount || 0) > 0
        ? "video still exposed YouTube caption tracks, so Whisper was not the path taken"
        : "recognition cues were not shown",
      watch: last,
    });
  }
  console.log(`proved whisper evidence=${path.relative(repoRoot, dir)}`);
}

function parsePopupSetArgs(argv) {
  const options = { style: "", fontSize: "", background: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === "--style") options.style = value;
    else if (key === "--font-size") options.fontSize = value;
    else if (key === "--background") options.background = value;
    else die(`unknown popup-set argument ${key}`);
    index += 1;
  }
  if (!["cinema", "minimal"].includes(options.style)) die("--style must be cinema or minimal");
  if (!["none", "translucent", "solid"].includes(options.background)) die("--background must be none, translucent, or solid");
  const fontSize = Number(options.fontSize);
  if (!Number.isInteger(fontSize) || fontSize < 80 || fontSize > 160 || fontSize % 10 !== 0) {
    die("--font-size must be an integer from 80 to 160 in steps of 10");
  }
  return { style: options.style, fontSize, background: options.background };
}

async function commandDoctor() {
  const manifest = manifestInfo();
  const chromeBin = resolveChromeBin();
  let browserVersion = "";
  if (chromeBin) {
    const version = spawnSync(chromeBin, ["--version"], { encoding: "utf8" });
    browserVersion = (version.stdout || version.stderr || "").trim();
  }
  const run = loadRun();
  const alive = Boolean(run && pidAlive(run.pid));
  const cmdline = alive ? cmdlineOf(run.pid) : "";
  const ownsProfile = alive && cmdline.includes(run.profile) && cmdline.includes(String(run.port));
  let popupHeading = "";
  let cdpBrowser = "";
  if (ownsProfile) {
    try {
      const version = await fetchJson(`http://127.0.0.1:${run.port}/json/version`);
      cdpBrowser = version.Browser || "";
      const popup = await ensurePopup(run);
      popupHeading = await evaluate(popup.session, `document.querySelector("h1")?.textContent || ""`);
      popup.session.close();
    } catch (error) {
      popupHeading = `error: ${error.message}`;
    }
  }
  const service = await localService();
  const required = [
    "manifest.json",
    "content/content.js",
    "content/renderer.js",
    "content/timeline.js",
    "content/main-world.js",
    "content/service-worker.js",
    "content/overlay.css",
    "popup/popup.html",
    "popup/popup.js",
    "icons/icon128.png",
  ];
  const missing = required.filter((relative) => !fs.existsSync(path.join(repoRoot, relative)));
  const worthDriving = Boolean(
    chromeBin
    && ownsProfile
    && popupHeading === "双语字幕助手"
    && manifestIsDriveable(manifest)
    && missing.length === 0
    && tokenMatch()
  );
  const report = {
    worthDriving,
    manifestVersion: manifest.version,
    manifestName: manifest.name,
    chromeBin,
    browserVersion,
    cdpBrowser,
    display: process.env.DISPLAY || "",
    pid: run?.pid || null,
    port: run?.port || null,
    profile: run?.profile || null,
    extensionId: run?.extensionId || null,
    popupHeading,
    ownsProfile,
    missing,
    localTokenMatches: tokenMatch(),
    localServiceUp: service.up,
    localService: service.up ? service.body : service.error,
  };
  console.log(JSON.stringify(report, null, 2));
  if (!worthDriving) process.exit(1);
}

async function commandLaunch() {
  if (!process.env.DISPLAY) die("DISPLAY is unset. Headed Chrome cannot open the YouTube window.");
  const existing = loadRun();
  if (existing && pidAlive(existing.pid)) {
    die(`verification Chrome already running as pid ${existing.pid}. Refusing to start a second instance. Run cleanup first.`, 2);
  }
  const chromeBin = resolveChromeBin();
  if (!chromeBin) die("Neither /usr/bin/google-chrome-stable nor /usr/bin/google-chrome exists. Refusing /usr/local/bin/google-chrome because it pins a shared profile.");
  fs.rmSync(profileDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(profileDir, "Default"), { recursive: true });
  fs.writeFileSync(
    path.join(profileDir, "Default", "Preferences"),
    JSON.stringify({
      extensions: { ui: { developer_mode: true } },
      browser: { has_seen_welcome_page: true },
    }),
  );
  let port = 9344;
  for (; port < 9360; port += 1) {
    try {
      await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(400) });
    } catch {
      break;
    }
  }
  const args = [
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${port}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--window-size=1280,800",
    "about:blank",
  ];
  fs.mkdirSync(stateDir, { recursive: true });
  const logFd = fs.openSync(chromeLogPath, "w");
  const child = spawn(chromeBin, args, { detached: true, stdio: ["ignore", logFd, logFd] });
  child.unref();
  fs.closeSync(logFd);
  const run = {
    pid: child.pid,
    port,
    profile: profileDir,
    extensionPath: repoRoot,
    chromeBin,
    startedAt: new Date().toISOString(),
    log: chromeLogPath,
  };
  try {
    const version = await (async () => {
      const started = Date.now();
      let lastError = null;
      while (Date.now() - started < 20000) {
        try {
          return await fetchJson(`http://127.0.0.1:${port}/json/version`);
        } catch (error) {
          lastError = error;
          if (!pidAlive(child.pid)) break;
          await delay(200);
        }
      }
      throw new Error(`CDP did not open on ${port}: ${lastError?.message || "timeout"}`);
    })();
    run.browser = version.Browser || "";
    const { session } = await browserSession(run);
    let loaded;
    try {
      loaded = await session.send("Extensions.loadUnpacked", { path: repoRoot });
    } finally {
      session.close();
    }
    run.extensionId = loaded.id || loaded.extensionId;
    if (!run.extensionId) throw new Error(`Extensions.loadUnpacked returned no id: ${JSON.stringify(loaded)}`);
    writeJson(runPath, run);
    const popup = await ensurePopup(run);
    const heading = await evaluate(popup.session, `document.querySelector("h1")?.textContent || ""`);
    popup.session.close();
    if (heading !== "双语字幕助手") throw new Error(`popup heading was ${JSON.stringify(heading)}`);
    console.log(`ready extension=${run.extensionId} port=${port} profile=${profileDir} popup=${heading} browser=${run.browser}`);
  } catch (error) {
    writeJson(runPath, run);
    console.error(error.message);
    if (fs.existsSync(chromeLogPath)) console.error(fs.readFileSync(chromeLogPath, "utf8").slice(-2000));
    await commandCleanup();
    process.exit(1);
  }
}

async function commandCleanup() {
  const run = loadRun();
  if (run?.pid && pidAlive(run.pid)) {
    try {
      process.kill(-run.pid, "SIGTERM");
    } catch {
      try { process.kill(run.pid, "SIGTERM"); } catch { /* already gone */ }
    }
    const started = Date.now();
    while (pidAlive(run.pid) && Date.now() - started < 5000) await delay(100);
    if (pidAlive(run.pid)) {
      try { process.kill(-run.pid, "SIGKILL"); } catch { /* ignore */ }
      try { process.kill(run.pid, "SIGKILL"); } catch { /* ignore */ }
    }
  }
  if (fs.existsSync(profileDir)) {
    const resolved = path.resolve(profileDir);
    if (!resolved.startsWith("/tmp/ytds-verify/")) die(`refusing to delete ${resolved}`);
    fs.rmSync(resolved, { recursive: true, force: true });
  }
  fs.rmSync(runPath, { force: true });
  fs.rmSync(chromeLogPath, { force: true });
  fs.rmSync(path.join(stateDir, "downloads"), { recursive: true, force: true });
  console.log("cleaned verification Chrome, profile, downloads, and run.json; artifacts kept");
}

function commandUnit() {
  const output = spawnSync("bash", ["-lc", "node --test tests/*.test.cjs"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  const text = `${output.stdout || ""}${output.stderr || ""}`;
  const dir = evidenceDir("unit");
  fs.writeFileSync(path.join(dir, "node-test.txt"), text);
  process.stdout.write(text);
  process.exit(output.status ?? 1);
}

function commandPackage() {
  const zsh = "/usr/bin/zsh";
  if (!fs.existsSync(zsh)) die("zsh is required to run scripts/build-store-package.sh", 2);
  const output = spawnSync(zsh, ["scripts/build-store-package.sh"], { cwd: repoRoot, encoding: "utf8" });
  const text = `${output.stdout || ""}${output.stderr || ""}`;
  const dir = evidenceDir("package");
  let listing = "";
  const zip = path.join(repoRoot, "release", `bilingual-subtitle-for-youtube-${manifestInfo().version}.zip`);
  if (fs.existsSync(zip)) {
    const unzip = spawnSync("unzip", ["-Z1", zip], { encoding: "utf8" });
    listing = unzip.stdout || "";
  }
  fs.writeFileSync(path.join(dir, "build.txt"), `${text}\n--- unzip -Z1 ---\n${listing}`);
  process.stdout.write(text);
  process.exit(output.status ?? 1);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "launch") return commandLaunch();
  if (command === "doctor") return commandDoctor();
  if (command === "cleanup") return commandCleanup();
  if (command === "unit") return commandUnit();
  if (command === "package") return commandPackage();
  if (command === "open-watch") {
    const run = requireRun();
    const state = await openWatch(run, rest[0] || process.env.YTDS_WATCH_URL || defaultWatchUrl);
    console.log(JSON.stringify(state, null, 2));
    return;
  }
  if (command === "popup-set") {
    const run = requireRun();
    const options = parsePopupSetArgs(rest);
    console.log(JSON.stringify(await popupSet(run, options), null, 2));
    return;
  }
  if (command === "popup-click") {
    const run = requireRun();
    const which = rest[0];
    if (!["clear-cache", "export"].includes(which)) die("popup-click expects clear-cache or export");
    console.log(JSON.stringify(await popupClick(run, which), null, 2));
    return;
  }
  if (command === "drive") {
    const run = requireRun();
    const feature = rest[0];
    if (feature === "style-cache") return driveStyleCache(run);
    if (feature === "captions") return driveCaptions(run);
    if (feature === "export") return driveExport(run);
    if (feature === "whisper") return driveWhisper(run);
    die("drive expects style-cache, captions, export, or whisper");
  }
  die(`usage: verify-ytds.mjs launch|doctor|open-watch|popup-set|popup-click|drive|unit|package|cleanup`);
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}
