// YouTube 双语字幕翻译 - 任务控制器 v3
// 字幕源竞速 → 时间轴规范化 → 原文立即显示 → 分批翻译 → 可恢复渲染
(() => {
  "use strict";

  const core = globalThis.YTDSCore;
  const RendererClass = globalThis.YTDSRenderer?.SubtitleRenderer;
  if (!core || !RendererClass) {
    console.error("[yt-ds] 核心模块未加载");
    return;
  }

  const CACHE_VERSION = 3;
  const LOCAL_SERVICE = "http://127.0.0.1:8765";
  const LOCAL_TOKEN = "99a56f089a38ced72c3d954927ce6601586c571e6f1e7553";
  const MAX_BATCH_CHARS = 1100;
  const TRANSLATION_CONCURRENCY = 2;
  const GOOGLE_RETRIES = 2;
  const SOURCE_RETRY_DELAYS = [3000, 8000, 15000, 30000, 60000];

  const state = {
    enabled: true,
    mode: "dual",
    targetSetting: "auto",
    settings: { style: "cinema", fontSize: 100, background: "none" },
    videoId: null,
    title: "",
    sourceLang: "",
    actualTarget: "zh",
    segments: [],
    translations: [],
    translatedCount: 0,
    translating: false,
    phase: "idle",
    engine: "",
    error: "",
    source: "",
    sameLanguage: false,
  };

  const renderer = new RendererClass(core);
  let activeJob = null;
  let jobSequence = 0;
  let observedVideoId = null;
  let statusHideTimer = 0;
  let sourceRetryTimer = 0;
  let sourceRetryAttempt = 0;

  function snapshot() {
    return {
      ...state,
      segments: state.segments,
      translations: state.translations,
      settings: state.settings,
    };
  }

  function getVideoId() {
    try {
      const id = new URL(location.href).searchParams.get("v");
      return /^[A-Za-z0-9_-]{11}$/.test(id || "") ? id : null;
    } catch {
      return null;
    }
  }

  function setStatus(message, phase = state.phase) {
    state.phase = phase;
    clearTimeout(statusHideTimer);
    renderer.setStatus(message || "");
  }

  function hideStatusAfter(ms = 2200) {
    clearTimeout(statusHideTimer);
    statusHideTimer = setTimeout(() => renderer.setStatus(""), ms);
  }

  function abortError() {
    return new DOMException("任务已取消", "AbortError");
  }

  function throwIfAborted(signal) {
    if (signal?.aborted) throw abortError();
  }

  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(abortError());
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(abortError());
      }, { once: true });
    });
  }

  function timeout(promise, ms, label, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(abortError());
      const timer = setTimeout(() => reject(new Error(label || "操作超时")), ms);
      const onAbort = () => reject(abortError());
      signal?.addEventListener("abort", onAbort, { once: true });
      promise.then(resolve, reject).finally(() => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      });
    });
  }

  function newJob(videoId) {
    activeJob?.controller.abort();
    const controller = new AbortController();
    const job = {
      id: ++jobSequence,
      videoId,
      controller,
      signal: controller.signal,
      isActive: () => activeJob === job && !controller.signal.aborted && state.videoId === videoId,
    };
    activeJob = job;
    return job;
  }

  function cancelJob() {
    activeJob?.controller.abort();
    activeJob = null;
    state.translating = false;
  }

  function clearSourceRetry({ resetAttempt = false } = {}) {
    clearTimeout(sourceRetryTimer);
    sourceRetryTimer = 0;
    if (resetAttempt) sourceRetryAttempt = 0;
  }

  function scheduleSourceRetry(videoId) {
    if (!state.enabled || getVideoId() !== videoId || state.segments.length) return;
    clearSourceRetry();
    const delay = SOURCE_RETRY_DELAYS[Math.min(sourceRetryAttempt, SOURCE_RETRY_DELAYS.length - 1)];
    sourceRetryAttempt++;
    state.error = "";
    state.phase = "recovering";
    setStatus(`本机字幕服务暂不可用，${Math.round(delay / 1000)} 秒后自动重试…`, "recovering");
    sourceRetryTimer = setTimeout(() => {
      sourceRetryTimer = 0;
      if (state.enabled && getVideoId() === videoId && !state.segments.length) {
        loadVideo(videoId, { retrying: true });
      }
    }, delay);
  }

  // ---------- MAIN world 桥 ----------
  const bridgePending = new Map();
  let bridgeId = 0;

  function injectMainWorld() {
    if (document.getElementById("yt-ds-main-world-v3")) return;
    const script = document.createElement("script");
    script.id = "yt-ds-main-world-v3";
    script.src = `${chrome.runtime.getURL("content/main-world.js")}?v=3`;
    (document.head || document.documentElement).appendChild(script);
  }

  window.addEventListener("message", event => {
    const message = event.data;
    if (event.source !== window || message?.namespace !== "YTDS3") return;
    if (message.type === "progress") {
      const pending = bridgePending.get(message.id);
      pending?.onProgress?.(message.data);
      return;
    }
    if (message.type !== "result") return;
    const pending = bridgePending.get(message.id);
    if (!pending) return;
    bridgePending.delete(message.id);
    clearTimeout(pending.timer);
    pending.signal?.removeEventListener("abort", pending.onAbort);
    if (message.ok) pending.resolve(message.data);
    else pending.reject(new Error(message.error || "页面桥请求失败"));
  });

  function bridge(action, payload = {}, options = {}) {
    const { timeoutMs = 10000, signal, onProgress } = options;
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(abortError());
      const id = `b${++bridgeId}`;
      const onAbort = () => {
        const pending = bridgePending.get(id);
        if (!pending) return;
        bridgePending.delete(id);
        clearTimeout(pending.timer);
        reject(abortError());
      };
      const timer = setTimeout(() => {
        bridgePending.delete(id);
        signal?.removeEventListener("abort", onAbort);
        reject(new Error(`${action} 超时`));
      }, timeoutMs);
      bridgePending.set(id, { resolve, reject, timer, signal, onAbort, onProgress });
      signal?.addEventListener("abort", onAbort, { once: true });
      window.postMessage({ namespace: "YTDS3", type: "request", id, action, payload }, "*");
    });
  }

  // ---------- 字幕解析 ----------
  function parseXml(text) {
    const out = [];
    const legacy = /<text\b([^>]*)>([\s\S]*?)<\/text>/g;
    let match;
    while ((match = legacy.exec(text))) {
      const attrs = match[1] || "";
      const start = Number(attrs.match(/start="([\d.]+)"/)?.[1]);
      const duration = Number(attrs.match(/dur="([\d.]+)"/)?.[1] || 0);
      const value = core.cleanText(match[2]);
      if (Number.isFinite(start) && value) out.push({ text: value, start, end: start + Math.max(0.15, duration) });
    }
    if (out.length) return out;
    const srv = /<p\b([^>]*)>([\s\S]*?)<\/p>/g;
    while ((match = srv.exec(text))) {
      const attrs = match[1] || "";
      const start = Number(attrs.match(/\bt="(\d+)"/)?.[1]) / 1000;
      const duration = Number(attrs.match(/\bd="(\d+)"/)?.[1] || 0) / 1000;
      const value = core.cleanText(match[2]);
      if (Number.isFinite(start) && value) out.push({ text: value, start, end: start + Math.max(0.15, duration) });
    }
    return out;
  }

  function parseJson3(text) {
    const data = JSON.parse(text);
    return (data.events || []).flatMap(event => {
      if (!event.segs?.length) return [];
      const value = core.cleanText(event.segs.map(item => item.utf8 || "").join("").replace(/\n/g, " "));
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
    const blocks = String(text).replace(/\r/g, "").split(/\n{2,}/);
    for (const block of blocks) {
      const lines = block.split("\n").filter(Boolean);
      const timingIndex = lines.findIndex(line => line.includes("-->"));
      if (timingIndex < 0) continue;
      const timing = lines[timingIndex].match(/([\d:,\.]+)\s*-->\s*([\d:,\.]+)/);
      if (!timing) continue;
      const start = timestampSeconds(timing[1]);
      const end = timestampSeconds(timing[2]);
      const value = core.cleanText(lines.slice(timingIndex + 1).join(" "));
      if (Number.isFinite(start) && Number.isFinite(end) && value) out.push({ text: value, start, end });
    }
    return out;
  }

  async function fetchText(url, signal, label) {
    try {
      const response = await timeout(fetch(url, { credentials: "include", signal }), 9000, `${label}超时`, signal);
      if (response.ok) return await response.text();
    } catch (error) {
      if (error.name === "AbortError") throw error;
    }
    const result = await bridge("FETCH", { url }, { timeoutMs: 10000, signal });
    if (result?.status !== 200) throw new Error(`${label}请求失败`);
    return result.text || "";
  }

  function formatUrl(baseUrl, format) {
    const url = new URL(baseUrl);
    url.searchParams.set("fmt", format);
    return url.toString();
  }

  async function parseHls(playlist, baseUrl, signal) {
    const urls = playlist
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line && !line.startsWith("#"))
      .map(line => new URL(line, baseUrl).toString());
    if (!urls.length) return [];
    const parts = [];
    for (const url of urls) {
      throwIfAborted(signal);
      try { parts.push(await fetchText(url, signal, "HLS 字幕分段")); } catch { /* 跳过坏分段 */ }
    }
    return parseVtt(parts.join("\n\n"));
  }

  async function downloadCaptionTrack(track, signal) {
    const baseUrl = track?.baseUrl;
    if (!baseUrl) throw new Error("字幕轨道缺少下载地址");
    try {
      const probe = await fetchText(baseUrl, signal, "字幕探测");
      if (probe.trim().startsWith("#EXTM3U")) {
        const hls = await parseHls(probe, baseUrl, signal);
        if (hls.length) return hls;
      }
    } catch (error) {
      if (error.name === "AbortError") throw error;
    }

    const attempts = [
      ["1", parseXml],
      ["json3", parseJson3],
      ["vtt", parseVtt],
    ];
    for (const [format, parser] of attempts) {
      throwIfAborted(signal);
      try {
        const text = await fetchText(formatUrl(baseUrl, format), signal, `字幕 ${format}`);
        if (text.trim().startsWith("#EXTM3U")) {
          const hls = await parseHls(text, baseUrl, signal);
          if (hls.length) return hls;
        }
        const segments = parser(text);
        if (segments.length) return segments;
      } catch (error) {
        if (error.name === "AbortError") throw error;
      }
    }
    throw new Error("浏览器字幕格式无法解析");
  }

  async function browserCaptionSource(videoId, targetSetting, signal) {
    setStatus("正在读取 YouTube 字幕…", "source");
    let tracks = [];
    try {
      const player = await bridge("GET_PLAYER", { videoId }, { timeoutMs: 2500, signal });
      if (player?.videoDetails?.videoId === videoId) {
        tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
      }
    } catch (error) {
      if (error.name === "AbortError") throw error;
    }
    if (!tracks.length) {
      try {
        tracks = await bridge("GET_CAPTIONS", { videoId }, { timeoutMs: 9000, signal }) || [];
      } catch (error) {
        if (error.name === "AbortError") throw error;
      }
    }
    const track = core.selectCaptionTrack(tracks, targetSetting);
    if (!track) return null;
    const raw = await downloadCaptionTrack(track, signal);
    if (!raw.length) return null;
    return {
      videoId,
      title: document.title.replace(/\s*-\s*YouTube\s*$/, "").trim(),
      lang: track.languageCode || "",
      source: track.kind === "asr" ? "youtube-auto" : "youtube-manual",
      segments: raw,
    };
  }

  async function obtainCaptionSource(videoId, targetSetting, job) {
    const channelController = new AbortController();
    const signal = AbortSignal.any([job.signal, channelController.signal]);
    const cache = localCaptionSource(videoId, targetSetting, true, job, signal);
    const browser = browserCaptionSource(videoId, targetSetting, signal).catch(error => {
      if (error.name === "AbortError") throw error;
      return null;
    });
    const available = await firstValid([cache, browser], signal);
    if (available) {
      channelController.abort();
      return available;
    }
    if (!job.isActive()) return null;
    setStatus("未找到视频字幕，正在启动本机语音识别…", "source");
    const recognized = await localCaptionSource(videoId, targetSetting, false, job, signal);
    channelController.abort();
    return recognized;
  }

  // ---------- 本机字幕缓存与语音识别 ----------
  function localHeaders() {
    return { "X-YTDS-Token": LOCAL_TOKEN };
  }

  async function fetchLocalSource(videoId, sourceLanguage, cacheOnly, signal) {
    const query = new URLSearchParams({
      videoId,
      lang: sourceLanguage || "auto",
      cacheOnly: cacheOnly ? "1" : "0",
    });
    let response;
    try {
      response = await fetch(`${LOCAL_SERVICE}/captions?${query}`, {
        headers: localHeaders(),
        signal,
      });
    } catch (error) {
      if (error.name === "AbortError") throw error;
      const unavailable = new Error("本机字幕服务未启动或连接失败");
      unavailable.code = "LOCAL_SERVICE_UNAVAILABLE";
      throw unavailable;
    }
    if (response.status === 404 && cacheOnly) return null;
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.ok || !data.segments?.length) {
      if (cacheOnly) return null;
      const failure = new Error(data?.error || `本机字幕处理失败（HTTP ${response.status}）`);
      failure.code = "LOCAL_SOURCE_FAILED";
      throw failure;
    }
    return data;
  }

  async function pollLocalStatus(videoId, job, signal) {
    while (!signal.aborted && job.isActive()) {
      try {
        const response = await fetch(`${LOCAL_SERVICE}/status?videoId=${videoId}`, {
          headers: localHeaders(),
          signal,
        });
        const data = await response.json();
        if (data?.message) setStatus(data.message, "source");
        if (["complete", "error"].includes(data?.stage)) return;
      } catch (error) {
        if (error.name === "AbortError") return;
      }
      try { await sleep(1800, signal); } catch { return; }
    }
  }

  async function localCaptionSource(videoId, targetSetting, cacheOnly, job, signal) {
    // 字幕来源与翻译目标解耦：始终读取视频原声/原字幕，避免同语言视频被错误排除，
    // 也让 auto 缓存可在所有翻译方向之间复用。
    const sourceLanguage = "auto";
    if (!cacheOnly) pollLocalStatus(videoId, job, signal);
    try {
      return await fetchLocalSource(videoId, sourceLanguage, cacheOnly, signal);
    } catch (error) {
      if (error.name === "AbortError") throw error;
      if (!cacheOnly) throw error;
      return null;
    }
  }

  function firstValid(promises, signal) {
    return new Promise(resolve => {
      let finished = 0;
      let settled = false;
      for (const promise of promises) {
        Promise.resolve(promise).then(value => {
          if (!settled && value?.segments?.length) {
            settled = true;
            resolve(value);
          }
        }).catch(() => {}).finally(() => {
          finished++;
          if (!settled && finished === promises.length) resolve(null);
        });
      }
      signal.addEventListener("abort", () => resolve(null), { once: true });
    });
  }

  // ---------- 翻译与缓存 ----------
  const localPairStatus = new Map();

  function cacheKey(videoId, sourceLanguage, targetLanguage) {
    return `ytds:v${CACHE_VERSION}:${videoId}:${sourceLanguage}:${targetLanguage}`;
  }

  function cacheCoverage(translations) {
    if (!translations?.length) return 0;
    return translations.filter(value => String(value || "").trim()).length / translations.length;
  }

  async function loadTranslationCache(videoId, sourceLanguage, targetLanguage, segments) {
    const key = cacheKey(videoId, sourceLanguage, targetLanguage);
    const fingerprint = core.fingerprintSegments(segments);
    try {
      const data = (await chrome.storage.local.get(key))[key];
      if (
        data?.version === CACHE_VERSION &&
        data.fingerprint === fingerprint &&
        data.translations?.length === segments.length &&
        cacheCoverage(data.translations) >= 0.9
      ) return data.translations;

      // 严格迁移旧缓存；不合格的旧数据保留但不再使用。
      const oldKey = `ytds_tr_${videoId}_${targetLanguage === "zh" ? "zh-CN" : targetLanguage}`;
      const legacy = (await chrome.storage.local.get(oldKey))[oldKey];
      if (
        legacy?.segments?.length === segments.length &&
        legacy.translations?.length === segments.length &&
        core.validateTimeline(legacy.segments).ok &&
        core.fingerprintSegments(legacy.segments) === fingerprint &&
        cacheCoverage(legacy.translations) >= 0.9
      ) {
        await saveTranslationCache(videoId, sourceLanguage, targetLanguage, segments, legacy.translations);
        return legacy.translations;
      }
    } catch { /* 缓存不可用时重新翻译 */ }
    return null;
  }

  async function saveTranslationCache(videoId, sourceLanguage, targetLanguage, segments, translations) {
    if (cacheCoverage(translations) < 0.9) return;
    const key = cacheKey(videoId, sourceLanguage, targetLanguage);
    await chrome.storage.local.set({
      [key]: {
        version: CACHE_VERSION,
        fingerprint: core.fingerprintSegments(segments),
        sourceLanguage,
        targetLanguage,
        translations,
        savedAt: Date.now(),
      },
    });
    cleanupTranslationCache().catch(() => {});
  }

  async function cleanupTranslationCache() {
    const limit = 8 * 1024 * 1024;
    let total = await chrome.storage.local.getBytesInUse(null);
    if (total <= limit) return;
    const all = await chrome.storage.local.get(null);
    const entries = Object.entries(all)
      .filter(([key]) => key.startsWith("ytds:v3:"))
      .map(([key, value]) => ({ key, savedAt: Number(value?.savedAt || 0), size: JSON.stringify(value).length }))
      .sort((a, b) => a.savedAt - b.savedAt);
    for (const entry of entries) {
      if (total <= limit) break;
      await chrome.storage.local.remove(entry.key);
      total -= entry.size;
    }
  }

  async function localAvailability(sourceLanguage, targetLanguage, signal) {
    const pair = `${sourceLanguage}->${targetLanguage}`;
    if (localPairStatus.has(pair)) return localPairStatus.get(pair);
    try {
      const result = await bridge("TRANSLATOR_STATUS", {
        source: sourceLanguage,
        target: targetLanguage,
      }, { timeoutMs: 3000, signal });
      const status = result?.availability || "unavailable";
      localPairStatus.set(pair, status);
      return status;
    } catch {
      localPairStatus.set(pair, "unavailable");
      return "unavailable";
    }
  }

  async function localTranslate(lines, sourceLanguage, targetLanguage, signal) {
    return bridge("TRANSLATE", { texts: lines, source: sourceLanguage, target: targetLanguage }, {
      timeoutMs: 25000,
      signal,
      onProgress: progress => {
        if (Number.isFinite(progress?.loaded) && Number.isFinite(progress?.total) && progress.total > 0) {
          const pct = Math.round(progress.loaded / progress.total * 100);
          setStatus(`正在准备浏览器本地翻译模型 ${pct}%…`, "translate");
        }
      },
    });
  }

  async function googleRequest(lines, targetLanguage, signal) {
    const query = lines.join("\n");
    const target = targetLanguage === "zh" ? "zh-CN" : "en";
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${target}&dt=t&q=${encodeURIComponent(query)}`;
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`Google 翻译 HTTP ${response.status}`);
    const data = await response.json();
    return (data[0] || []).map(item => item[0] || "").join("").split("\n");
  }

  async function googleTranslate(lines, targetLanguage, signal) {
    for (let attempt = 0; attempt <= GOOGLE_RETRIES; attempt++) {
      try {
        const output = await googleRequest(lines, targetLanguage, signal);
        if (output.length === lines.length) return output;
        const singles = [];
        for (const line of lines) {
          throwIfAborted(signal);
          const result = await googleRequest([line], targetLanguage, signal);
          singles.push(result[0] || "");
        }
        return singles;
      } catch (error) {
        if (error.name === "AbortError" || attempt === GOOGLE_RETRIES) throw error;
        await sleep(600 * (attempt + 1), signal);
      }
    }
    return [];
  }

  async function translateBatch(lines, sourceLanguage, targetLanguage, signal) {
    const availability = await localAvailability(sourceLanguage, targetLanguage, signal);
    if (availability !== "unavailable" && availability !== "failed") {
      try {
        const output = await localTranslate(lines, sourceLanguage, targetLanguage, signal);
        if (Array.isArray(output?.texts) && output.texts.length === lines.length) {
          state.engine = "local";
          return output.texts;
        }
      } catch (error) {
        if (error.name === "AbortError") throw error;
        localPairStatus.set(`${sourceLanguage}->${targetLanguage}`, "failed");
      }
    }
    state.engine = "google";
    return googleTranslate(lines, targetLanguage, signal);
  }

  function makeBatches(segments) {
    const batches = [];
    let current = [];
    let length = 0;
    segments.forEach((cue, index) => {
      if (current.length && length + cue.text.length > MAX_BATCH_CHARS) {
        batches.push(current);
        current = [];
        length = 0;
      }
      current.push({ index, text: cue.text });
      length += cue.text.length;
    });
    if (current.length) batches.push(current);
    const time = document.querySelector("video")?.currentTime || 0;
    const activeIndex = Math.max(0, core.cueIndexAt(segments, time));
    return batches.sort((a, b) => Math.abs(a[0].index - activeIndex) - Math.abs(b[0].index - activeIndex));
  }

  async function translateIncrementally(job) {
    const segments = state.segments;
    const sourceLanguage = state.sourceLang;
    const targetLanguage = state.actualTarget;
    const batches = makeBatches(segments);
    state.translating = true;
    state.translatedCount = 0;
    state.translations = new Array(segments.length).fill("");
    let nextBatch = 0;
    let failures = 0;

    const worker = async () => {
      while (job.isActive()) {
        const batchIndex = nextBatch++;
        if (batchIndex >= batches.length) return;
        const batch = batches[batchIndex];
        try {
          const output = await translateBatch(batch.map(item => item.text), sourceLanguage, targetLanguage, job.signal);
          if (!job.isActive()) return;
          batch.forEach((item, index) => {
            state.translations[item.index] = String(output[index] || "").trim();
            state.translatedCount++;
          });
        } catch (error) {
          if (error.name === "AbortError") return;
          failures += batch.length;
          state.translatedCount += batch.length;
        }
        if (job.isActive()) {
          const pct = Math.round(state.translatedCount / segments.length * 100);
          const engine = state.engine === "local" ? "浏览器本地" : "Google 在线";
          setStatus(`正在翻译 ${state.translatedCount}/${segments.length}（${pct}% · ${engine}）`, "translate");
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(TRANSLATION_CONCURRENCY, batches.length || 1) }, worker));
    if (!job.isActive()) return;
    state.translating = false;
    const coverage = cacheCoverage(state.translations);
    if (coverage >= 0.9) {
      try {
        await saveTranslationCache(job.videoId, sourceLanguage, targetLanguage, segments, state.translations);
      } catch (error) {
        // 缓存写入失败不能把已经正常显示的字幕降级成“加载失败”。
        console.warn("[yt-ds] 翻译已完成，但缓存保存失败：", error);
      }
      if (!job.isActive()) return;
      state.error = "";
      setStatus("字幕翻译完成 ✓", "ready");
      hideStatusAfter();
    } else {
      state.error = "";
      setStatus(`字幕已显示，部分译文暂未完成（${Math.round(coverage * 100)}%）`, "partial");
      hideStatusAfter(4000);
    }
  }

  // ---------- 主任务 ----------
  function resetVideoState(videoId) {
    state.videoId = videoId;
    state.title = "";
    state.sourceLang = "";
    state.actualTarget = "zh";
    state.segments = [];
    state.translations = [];
    state.translatedCount = 0;
    state.translating = false;
    state.phase = "source";
    state.engine = "";
    state.error = "";
    state.source = "";
    state.sameLanguage = false;
    renderer.clear();
  }

  async function loadVideo(videoId, { retrying = false } = {}) {
    if (!state.enabled || !videoId) return;
    clearSourceRetry({ resetAttempt: !retrying });
    const job = newJob(videoId);
    resetVideoState(videoId);
    renderer.start(snapshot);
    setStatus("正在识别视频和字幕来源…", "source");
    try {
      const source = await obtainCaptionSource(videoId, state.targetSetting, job);
      if (!job.isActive()) return;
      if (!source?.segments?.length) throw new Error("此视频没有可读取的 YouTube 字幕，且本机语音识别服务未能生成字幕");

      const sample = source.segments.slice(0, 12).map(cue => cue.text).join(" ");
      let sourceLanguage = core.detectTextLanguage(sample, source.lang);
      if (!sourceLanguage || !["zh", "en"].includes(sourceLanguage)) {
        try {
          const detected = await bridge("DETECT", { text: sample }, { timeoutMs: 8000, signal: job.signal });
          sourceLanguage = core.normalizeLanguage(detected?.language) || "en";
        } catch { sourceLanguage = "en"; }
      }
      const normalized = core.normalizeSegments(source.segments, sourceLanguage);
      const validation = core.validateTimeline(normalized);
      if (!validation.ok) throw new Error(`字幕时间轴无效：${validation.errors.slice(0, 3).join(", ")}`);

      state.title = source.title || document.title.replace(/\s*-\s*YouTube\s*$/, "").trim();
      state.sourceLang = sourceLanguage;
      state.actualTarget = core.targetLanguageFor(sourceLanguage, state.targetSetting);
      state.segments = normalized;
      state.translations = new Array(normalized.length).fill("");
      state.source = source.source || "unknown";
      state.sameLanguage = sourceLanguage === state.actualTarget;
      clearSourceRetry({ resetAttempt: true });

      if (state.sameLanguage) {
        state.translating = false;
        state.phase = "ready";
        state.engine = "same-language";
        state.error = "";
        setStatus(`原文已是${sourceLanguage === "zh" ? "中文" : "英文"}，无需翻译 ✓`, "ready");
        hideStatusAfter(2400);
        return;
      }

      state.phase = "translate";
      setStatus(`已加载原文字幕 ${normalized.length} 条，正在准备翻译…`, "translate");

      const cached = await loadTranslationCache(videoId, sourceLanguage, state.actualTarget, normalized);
      if (!job.isActive()) return;
      if (cached) {
        state.translations = cached;
        state.translatedCount = cached.length;
        state.translating = false;
        state.phase = "ready";
        state.engine = "cache";
        setStatus("已从永久缓存加载 ✓", "ready");
        hideStatusAfter(1600);
        return;
      }
      await translateIncrementally(job);
    } catch (error) {
      if (error.name === "AbortError" || !job.isActive()) return;
      state.translating = false;
      const outcome = core.classifySubtitleOutcome(state.segments, state.translations);
      if (outcome.kind !== "load-error") {
        // 字幕源已经可用时，后续翻译或缓存异常不属于“字幕加载失败”。
        state.error = "";
        if (outcome.kind === "ready") {
          setStatus("字幕已就绪 ✓", "ready");
        } else if (outcome.kind === "partial") {
          setStatus(`字幕已显示，部分译文暂未完成（${Math.round(outcome.coverage * 100)}%）`, "partial");
        } else {
          setStatus("原文字幕已显示，译文暂不可用", "partial");
        }
        hideStatusAfter(4000);
        console.warn("[yt-ds] 字幕已显示，后续处理异常：", error);
        return;
      }
      state.phase = "error";
      if (error.code === "LOCAL_SERVICE_UNAVAILABLE") {
        scheduleSourceRetry(videoId);
        return;
      }
      state.error = error.message || String(error);
      setStatus(`字幕处理失败：${state.error}`, "error");
    }
  }

  // ---------- YouTube 导航与设置 ----------
  function clearForNavigation() {
    clearSourceRetry({ resetAttempt: true });
    cancelJob();
    state.segments = [];
    state.translations = [];
    state.translatedCount = 0;
    state.error = "";
    renderer.clear();
  }

  function applyEnabled(enabled) {
    const nextEnabled = enabled !== false;
    if (state.enabled === nextEnabled) return;
    state.enabled = nextEnabled;
    if (state.enabled) {
      renderer.start(snapshot);
      handleNavigation({ force: true });
    } else {
      clearForNavigation();
      renderer.stop({ remove: true });
      state.phase = "disabled";
    }
  }

  function handleNavigation({ force = false } = {}) {
    const videoId = getVideoId();
    if (!force && videoId === observedVideoId) return;
    clearForNavigation();
    observedVideoId = videoId;
    state.videoId = videoId;
    if (state.enabled && videoId) loadVideo(videoId);
  }

  document.addEventListener("yt-navigate-start", () => {
    if (getVideoId() !== observedVideoId || state.segments.length) clearForNavigation();
  }, true);
  document.addEventListener("yt-navigate-finish", () => handleNavigation(), true);
  window.addEventListener("popstate", () => queueMicrotask(() => handleNavigation()));
  window.addEventListener("online", () => {
    if (state.phase === "recovering" && state.enabled && getVideoId()) {
      clearSourceRetry();
      loadVideo(getVideoId(), { retrying: true });
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && state.phase === "recovering" && state.enabled && getVideoId()) {
      clearSourceRetry();
      loadVideo(getVideoId(), { retrying: true });
    }
  });
  setInterval(() => handleNavigation(), 750);

  injectMainWorld();
  renderer.start(snapshot);

  chrome.storage.sync.get(["enabled", "mode", "targetLang", "settings"]).then(preferences => {
    state.enabled = preferences.enabled !== false;
    state.mode = preferences.mode === "translated" || preferences.mode === "zh" ? "translated" : "dual";
    state.targetSetting = ["en", "zh-CN"].includes(preferences.targetLang) ? preferences.targetLang : "auto";
    state.settings = { ...state.settings, ...(preferences.settings || {}) };
    renderer.applySettings(state.settings);
    observedVideoId = getVideoId();
    state.videoId = observedVideoId;
    if (state.enabled && observedVideoId) loadVideo(observedVideoId);
    else if (!state.enabled) renderer.stop({ remove: true });
  }).catch(() => {
    observedVideoId = getVideoId();
    if (observedVideoId) loadVideo(observedVideoId);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    if (changes.enabled) {
      applyEnabled(changes.enabled.newValue);
    }
    if (changes.mode) {
      state.mode = changes.mode.newValue === "translated" || changes.mode.newValue === "zh" ? "translated" : "dual";
      renderer.clear({ keepStatus: true });
    }
    if (changes.settings) {
      state.settings = { ...state.settings, ...(changes.settings.newValue || {}) };
      renderer.applySettings(state.settings);
    }
    if (changes.targetLang) {
      state.targetSetting = ["en", "zh-CN"].includes(changes.targetLang.newValue) ? changes.targetLang.newValue : "auto";
      if (state.enabled && getVideoId()) handleNavigation({ force: true });
    }
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "yt-ds-get-state") {
      sendResponse({
        videoId: state.videoId,
        total: state.segments.length,
        done: state.translatedCount,
        translating: state.translating,
        enabled: state.enabled,
        mode: state.mode,
        error: state.error,
        phase: state.phase,
        targetLang: state.targetSetting,
        sourceLang: state.sourceLang,
        engine: state.engine,
        source: state.source,
      });
    } else if (message?.type === "yt-ds-set-enabled") {
      applyEnabled(message.enabled);
      sendResponse({ ok: true, enabled: state.enabled });
    } else if (message?.type === "yt-ds-retranslate") {
      const videoId = getVideoId();
      if (videoId && state.sourceLang && state.actualTarget) {
        chrome.storage.local.remove(cacheKey(videoId, state.sourceLang, state.actualTarget)).finally(() => {
          if (state.enabled) handleNavigation({ force: true });
        });
      }
      sendResponse({ ok: true });
    } else if (message?.type === "yt-ds-export") {
      sendResponse({
        videoId: state.videoId,
        title: state.title,
        url: location.href,
        sourceLang: state.sourceLang,
        targetLang: state.actualTarget,
        segments: state.segments,
        translations: state.translations,
      });
    }
    return true;
  });
})();
