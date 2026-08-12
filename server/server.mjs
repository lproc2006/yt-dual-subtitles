// YouTube 双语字幕本地服务 v3
// 缓存 → yt-dlp 原字幕 → Whisper 兜底；带进度、版本化缓存和请求鉴权。
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVICE_VERSION = 3;
const PORT = 8765;
const ACCESS_TOKEN = "99a56f089a38ced72c3d954927ce6601586c571e6f1e7553";
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.dirname(SCRIPT_DIR);
const CACHE_DIR = path.join(SCRIPT_DIR, "cache-v3");
const LEGACY_CACHE_DIR = path.join(SCRIPT_DIR, "cache");
const AUDIO_DIR = path.join(os.tmpdir(), "ytds-audio-v3");
const WHISPER_SCRIPT = path.join(SCRIPT_DIR, "whisper_transcribe.py");
const USER_HOME = os.homedir();
const YT_DLP = process.env.YTDS_YT_DLP || path.join(USER_HOME, "bin", "yt-dlp");
const BUN_BIN = process.execPath;
const COOKIE_BROWSER_CANDIDATES = (() => {
  const configured = String(process.env.YTDS_COOKIE_BROWSER || "").split(",").map(value => value.trim()).filter(Boolean);
  if (configured.length) return configured;
  const candidates = [];
  if (fs.existsSync(path.join(USER_HOME, "Library", "Application Support", "Microsoft Edge"))) candidates.push("edge");
  if (fs.existsSync(path.join(USER_HOME, "Library", "Application Support", "Google", "Chrome"))) candidates.push("chrome");
  return candidates.length ? candidates : ["edge", "chrome"];
})();
const PYTHON_CANDIDATES = [process.env.YTDS_PYTHON, "/usr/local/bin/python3", "/opt/homebrew/bin/python3", "/usr/bin/python3"].filter(Boolean);
const PYTHON = PYTHON_CANDIDATES.find(candidate => fs.existsSync(candidate)) || "python3";
const memoryCache = new Map();
const inflight = new Map();
const jobStatus = new Map();

fs.mkdirSync(CACHE_DIR, { recursive: true });
fs.mkdirSync(AUDIO_DIR, { recursive: true });

function normalizeLanguage(code) {
  const value = String(code || "").toLowerCase();
  if (value.startsWith("zh") || value === "cmn") return "zh";
  if (value.startsWith("en")) return "en";
  return value.split("-")[0] || "";
}

function validVideoId(videoId) {
  return /^[A-Za-z0-9_-]{11}$/.test(videoId);
}

function cacheRequestLanguage(value) {
  const language = normalizeLanguage(value);
  return language === "en" || language === "zh" ? language : "auto";
}

function cacheKey(videoId, requestedLanguage) {
  return `${videoId}:${cacheRequestLanguage(requestedLanguage)}`;
}

function cachePath(videoId, requestedLanguage) {
  return path.join(CACHE_DIR, `${videoId}__${cacheRequestLanguage(requestedLanguage)}.json`);
}

function validSegments(segments) {
  return Array.isArray(segments)
    && segments.length > 0
    && segments.every(segment => (
      String(segment?.text || "").trim()
      && Number.isFinite(Number(segment?.start))
      && Number.isFinite(Number(segment?.end))
      && Number(segment.end) > Number(segment.start)
    ));
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function writeJsonAtomic(file, data) {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(data));
  fs.renameSync(temporary, file);
}

function saveCache(videoId, requestedLanguage, data) {
  const payload = {
    ...data,
    schemaVersion: SERVICE_VERSION,
    requestedLanguage: cacheRequestLanguage(requestedLanguage),
    savedAt: Date.now(),
  };
  writeJsonAtomic(cachePath(videoId, requestedLanguage), payload);
  memoryCache.set(cacheKey(videoId, requestedLanguage), payload);
  return payload;
}

function loadCache(videoId, requestedLanguage) {
  const key = cacheKey(videoId, requestedLanguage);
  if (memoryCache.has(key)) return memoryCache.get(key);
  const current = readJson(cachePath(videoId, requestedLanguage));
  if (current?.schemaVersion === SERVICE_VERSION && validSegments(current.segments)) {
    memoryCache.set(key, current);
    return current;
  }

  // 固定语言请求可以复用 auto 缓存，只要缓存的真实字幕语言一致。
  // 这避免同一视频仅因“中文→英文 / 英文→中文”设置不同而重复下载或误报无字幕。
  const requested = cacheRequestLanguage(requestedLanguage);
  if (requested !== "auto") {
    const automatic = readJson(cachePath(videoId, "auto"));
    if (
      automatic?.schemaVersion === SERVICE_VERSION
      && validSegments(automatic.segments)
      && normalizeLanguage(automatic.lang) === requested
    ) {
      return saveCache(videoId, requestedLanguage, {
        videoId: automatic.videoId || videoId,
        title: automatic.title || "",
        channel: automatic.channel || "",
        lang: automatic.lang,
        segments: automatic.segments,
        source: automatic.source || "cache-compatible",
        elapsedSeconds: automatic.elapsedSeconds || 0,
      });
    }
  }

  // 旧缓存只在语言匹配时迁移；原文件保持不变。
  const legacy = readJson(path.join(LEGACY_CACHE_DIR, `${videoId}.json`));
  const legacyLanguage = normalizeLanguage(legacy?.lang);
  if (legacy && validSegments(legacy.segments) && (requested === "auto" || requested === legacyLanguage)) {
    return saveCache(videoId, requestedLanguage, {
      videoId,
      title: legacy.title || "",
      channel: legacy.channel || "",
      lang: legacyLanguage || legacy.lang || "",
      segments: legacy.segments,
      source: `${legacy.source || "legacy"}-migrated`,
    });
  }
  return null;
}

function setStatus(videoId, stage, message, extra = {}) {
  jobStatus.set(videoId, { stage, message, updatedAt: Date.now(), ...extra });
}

function proxyEnvironment(useProxy = true) {
  const environment = { ...process.env };
  environment.PATH = [environment.PATH || "", path.dirname(BUN_BIN), path.dirname(YT_DLP)].filter(Boolean).join(":");
  if (!useProxy) {
    for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) delete environment[key];
  }
  return environment;
}

function spawnCapture(program, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { env: options.env || process.env });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", chunk => { stdout += chunk; });
    child.stderr?.on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", code => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error((stderr || stdout || `${path.basename(program)} exit ${code}`).trim().split("\n").slice(-5).join(" | ")));
    });
  });
}

async function runYtDlp(args) {
  if (!fs.existsSync(YT_DLP)) throw new Error(`未找到 yt-dlp：${YT_DLP}`);
  const hasProxy = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"].some(key => process.env[key]);
  try {
    return await spawnCapture(YT_DLP, args, { env: proxyEnvironment(true) });
  } catch (proxyError) {
    if (!hasProxy) throw proxyError;
    console.error(`[yt-ds] 代理链路失败，尝试直连：${proxyError.message}`);
    return spawnCapture(YT_DLP, args, { env: proxyEnvironment(false) });
  }
}

async function runYouTubeYtDlp(args) {
  let lastError;
  for (const browser of COOKIE_BROWSER_CANDIDATES) {
    try {
      return await runYtDlp([...args, "--cookies-from-browser", browser]);
    } catch (error) {
      lastError = error;
      console.error(`[yt-ds] 使用 ${browser} 的 YouTube 会话失败，尝试下一浏览器：${error.message}`);
    }
  }
  throw lastError || new Error("没有可用的浏览器 YouTube 会话");
}

async function fetchVideoInfo(videoId) {
  const { stdout, stderr } = await runYouTubeYtDlp([
    "-J",
    "--skip-download",
    "--js-runtimes", `bun:${BUN_BIN}`,
    `https://www.youtube.com/watch?v=${videoId}`,
  ]);
  if (stderr.trim()) console.error(`[yt-dlp] ${stderr.trim().split("\n").slice(-3).join(" | ")}`);
  try { return JSON.parse(stdout); } catch { throw new Error("yt-dlp 元数据解析失败"); }
}

function stripHtml(value) {
  return String(value || "")
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;|&#39;|&#x27;/g, "'")
    .replace(/&nbsp;/g, " ").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, " ").trim();
}

function parseXml(text) {
  const out = [];
  let match;
  const legacy = /<text\b([^>]*)>([\s\S]*?)<\/text>/g;
  while ((match = legacy.exec(text))) {
    const start = Number(match[1].match(/start="([\d.]+)"/)?.[1]);
    const duration = Number(match[1].match(/dur="([\d.]+)"/)?.[1] || 0);
    const value = stripHtml(match[2]);
    if (Number.isFinite(start) && value) out.push({ text: value, start, end: start + Math.max(0.15, duration) });
  }
  if (out.length) return out;
  const srv = /<p\b([^>]*)>([\s\S]*?)<\/p>/g;
  while ((match = srv.exec(text))) {
    const start = Number(match[1].match(/\bt="(\d+)"/)?.[1]) / 1000;
    const duration = Number(match[1].match(/\bd="(\d+)"/)?.[1] || 0) / 1000;
    const value = stripHtml(match[2]);
    if (Number.isFinite(start) && value) out.push({ text: value, start, end: start + Math.max(0.15, duration) });
  }
  return out;
}

function parseJson3(text) {
  const data = JSON.parse(text);
  return (data.events || []).flatMap(event => {
    if (!event.segs?.length) return [];
    const value = stripHtml(event.segs.map(item => item.utf8 || "").join("").replace(/\n/g, " "));
    const start = Number(event.tStartMs || 0) / 1000;
    const duration = Number(event.dDurationMs || 0) / 1000;
    return value ? [{ text: value, start, end: start + Math.max(0.15, duration) }] : [];
  });
}

function timestampSeconds(value) {
  const parts = String(value).replace(",", ".").split(":").map(Number);
  if (parts.some(number => !Number.isFinite(number))) return NaN;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0];
}

function parseVtt(text) {
  const out = [];
  for (const block of String(text).replace(/\r/g, "").split(/\n{2,}/)) {
    const lines = block.split("\n").filter(Boolean);
    const index = lines.findIndex(line => line.includes("-->"));
    if (index < 0) continue;
    const timing = lines[index].match(/([\d:,\.]+)\s*-->\s*([\d:,\.]+)/);
    if (!timing) continue;
    const start = timestampSeconds(timing[1]);
    const end = timestampSeconds(timing[2]);
    const value = stripHtml(lines.slice(index + 1).join(" "));
    if (Number.isFinite(start) && Number.isFinite(end) && end > start && value) out.push({ text: value, start, end });
  }
  return out;
}

async function fetchText(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error(`字幕 HTTP ${response.status}`);
  return response.text();
}

async function parseHls(playlist, baseUrl) {
  const segmentUrls = playlist
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith("#"))
    .map(line => new URL(line, baseUrl).toString());
  const parts = [];
  for (const url of segmentUrls) {
    try { parts.push(await fetchText(url)); } catch { /* 跳过坏分段 */ }
  }
  return parseVtt(parts.join("\n\n"));
}

async function downloadAndParse(baseUrl) {
  try {
    const probe = await fetchText(baseUrl);
    if (probe.trim().startsWith("#EXTM3U")) {
      const segments = await parseHls(probe, baseUrl);
      if (segments.length) return segments;
    }
  } catch { /* 尝试指定格式 */ }

  const attempts = [
    ["1", parseXml],
    ["json3", parseJson3],
    ["vtt", parseVtt],
  ];
  for (const [format, parser] of attempts) {
    try {
      const url = new URL(baseUrl);
      url.searchParams.set("fmt", format);
      const text = await fetchText(url);
      if (text.trim().startsWith("#EXTM3U")) {
        const segments = await parseHls(text, baseUrl);
        if (segments.length) return segments;
      }
      const segments = parser(text);
      if (segments.length) return segments;
    } catch { /* 下一个格式 */ }
  }
  throw new Error("字幕格式无法解析");
}

function formatUrl(formats) {
  if (!Array.isArray(formats)) return "";
  return formats.find(format => format?.url && ["json3", "vtt", "srv1", "srv2", "srv3"].includes(format.ext))?.url
    || formats.find(format => format?.url)?.url
    || "";
}

function isOriginalAutomatic(formats) {
  const url = formatUrl(formats);
  if (!url) return false;
  try { return !new URL(url).searchParams.get("tlang"); } catch { return true; }
}

function collectTracks(info) {
  const tracks = [];
  for (const [language, formats] of Object.entries(info.subtitles || {})) {
    const url = formatUrl(formats);
    if (url) tracks.push({ language, normalized: normalizeLanguage(language), kind: "manual", original: true, url });
  }
  for (const [language, formats] of Object.entries(info.automatic_captions || {})) {
    const url = formatUrl(formats);
    if (url) tracks.push({ language, normalized: normalizeLanguage(language), kind: "auto", original: isOriginalAutomatic(formats), url });
  }
  return tracks;
}

function chooseTrack(info, requestedLanguage) {
  const tracks = collectTracks(info);
  const requested = cacheRequestLanguage(requestedLanguage);
  const metadataLanguage = normalizeLanguage(info.language || info.audio_language || "");
  const byLanguage = language => tracks.filter(track => track.normalized === language);
  const bestForLanguage = language => {
    const candidates = byLanguage(language);
    return candidates.find(track => track.kind === "manual")
      || candidates.find(track => track.kind === "auto" && track.original)
      || candidates[0]
      || null;
  };
  if (requested !== "auto") return bestForLanguage(requested);
  if (metadataLanguage) {
    const metadataTrack = bestForLanguage(metadataLanguage);
    if (metadataTrack) return metadataTrack;
  }
  return tracks.find(track => track.kind === "auto" && track.original && ["en", "zh"].includes(track.normalized))
    || tracks.find(track => track.kind === "manual" && ["en", "zh"].includes(track.normalized))
    || tracks.find(track => track.kind === "auto" && track.original)
    || tracks.find(track => ["en", "zh"].includes(track.normalized))
    || tracks[0]
    || null;
}

async function downloadAudio(videoId) {
  const output = path.join(AUDIO_DIR, `${videoId}-${Date.now()}.webm`);
  await runYouTubeYtDlp([
    "-f", "bestaudio/best",
    "-o", output,
    "--js-runtimes", `bun:${BUN_BIN}`,
    `https://www.youtube.com/watch?v=${videoId}`,
  ]);
  if (!fs.existsSync(output)) throw new Error("音频下载完成但未找到文件");
  return output;
}

async function transcribeAudio(audioPath, requestedLanguage) {
  const language = requestedLanguage === "en" || requestedLanguage === "zh" ? requestedLanguage : "auto";
  const { stdout, stderr } = await spawnCapture(PYTHON, [WHISPER_SCRIPT, audioPath, language], { env: process.env });
  if (stderr.trim()) console.error(`[whisper] ${stderr.trim().split("\n").slice(-3).join(" | ")}`);
  const line = stdout.trim().split("\n").pop();
  try { return JSON.parse(line); } catch { throw new Error("Whisper 输出解析失败"); }
}

async function transcribeVideo(videoId, requestedLanguage) {
  setStatus(videoId, "audio", "视频没有可用字幕，正在下载音频…");
  const audio = await downloadAudio(videoId);
  try {
    setStatus(videoId, "transcribing", "正在进行本地语音识别，首次可能需要数分钟…");
    return await transcribeAudio(audio, requestedLanguage);
  } finally {
    try { fs.unlinkSync(audio); } catch { /* 系统临时目录仍会自动清理 */ }
  }
}

async function buildSubtitles(videoId, requestedLanguage) {
  const startedAt = Date.now();
  setStatus(videoId, "metadata", "正在检查视频语言和字幕轨道…");
  const info = await fetchVideoInfo(videoId);
  const track = chooseTrack(info, requestedLanguage);
  let segments;
  let language;
  let source;
  if (track) {
    try {
      setStatus(videoId, "captions", `正在读取${track.kind === "manual" ? "作者" : "自动"}字幕…`);
      segments = await downloadAndParse(track.url);
      language = track.normalized || track.language;
      source = track.kind === "manual" ? "youtube-manual" : "youtube-auto";
    } catch (error) {
      console.warn(`[yt-ds] 字幕轨道读取失败，改用本机语音识别：${error.message}`);
    }
  }
  if (!validSegments(segments)) {
    const metadataLanguage = normalizeLanguage(info.language || info.audio_language || "");
    const spokenLanguage = ["zh", "en"].includes(metadataLanguage) ? metadataLanguage : "auto";
    const transcript = await transcribeVideo(videoId, spokenLanguage);
    segments = transcript.segments || [];
    language = normalizeLanguage(transcript.lang) || transcript.lang || "";
    source = "whisper";
  }
  if (!validSegments(segments)) throw new Error("字幕结果为空或时间轴无效");
  const result = saveCache(videoId, requestedLanguage, {
    videoId,
    title: info.title || "",
    channel: info.channel || info.uploader || "",
    lang: language,
    segments,
    source,
    elapsedSeconds: Math.round((Date.now() - startedAt) / 100) / 10,
  });
  setStatus(videoId, "complete", `字幕已准备完成（${segments.length} 条）`, { source, language });
  return result;
}

async function getSubtitles(videoId, requestedLanguage, cacheOnly = false) {
  const cached = loadCache(videoId, requestedLanguage);
  if (cached) {
    setStatus(videoId, "complete", `已从永久缓存读取字幕（${cached.segments.length} 条）`, { source: cached.source, language: cached.lang });
    return cached;
  }
  if (cacheOnly) return null;
  const key = cacheKey(videoId, requestedLanguage);
  if (!inflight.has(key)) {
    const promise = buildSubtitles(videoId, requestedLanguage)
      .catch(error => {
        setStatus(videoId, "error", `字幕处理失败：${error.message}`);
        throw error;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, promise);
  }
  return inflight.get(key);
}

function responseHeaders() {
  return {
    "Content-Type": "application/json;charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "X-YTDS-Token, Content-Type",
    "Cache-Control": "no-store",
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: responseHeaders() });
}

function authorized(request) {
  return request.headers.get("x-ytds-token") === ACCESS_TOKEN;
}

const server = Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  idleTimeout: 255,
  async fetch(request) {
    if (request.method === "OPTIONS") return json({ ok: true });
    const url = new URL(request.url);
    if (url.pathname === "/health") return json({ ok: true, service: "yt-ds-server", version: SERVICE_VERSION });
    if (!authorized(request)) return json({ ok: false, error: "unauthorized" }, 401);

    if (url.pathname === "/status") {
      const videoId = String(url.searchParams.get("videoId") || "").trim();
      if (!validVideoId(videoId)) return json({ ok: false, error: "invalid videoId" }, 400);
      return json({ ok: true, ...(jobStatus.get(videoId) || { stage: "idle", message: "等待处理" }) });
    }

    if (url.pathname === "/captions") {
      const videoId = String(url.searchParams.get("videoId") || "").trim();
      const requestedLanguage = cacheRequestLanguage(url.searchParams.get("lang"));
      const cacheOnly = url.searchParams.get("cacheOnly") === "1";
      if (!validVideoId(videoId)) return json({ ok: false, error: "invalid videoId" }, 400);
      try {
        const result = await getSubtitles(videoId, requestedLanguage, cacheOnly);
        if (!result && cacheOnly) return json({ ok: false, error: "cache miss" }, 404);
        return json({ ok: true, ...result });
      } catch (error) {
        return json({ ok: false, error: error.message || String(error) }, 502);
      }
    }
    return json({ ok: false, error: "not found" }, 404);
  },
});

console.log(`[yt-ds-server] v${SERVICE_VERSION} running at http://127.0.0.1:${server.port}`);
console.log(`[yt-ds-server] project: ${PROJECT_DIR}`);
