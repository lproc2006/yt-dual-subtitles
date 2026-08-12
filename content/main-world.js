// YouTube 双语字幕 - MAIN world 桥 v3
(() => {
  "use strict";
  if (window.__ytDsMainWorldVersion === 3) return;
  window.__ytDsMainWorldVersion = 3;

  const WATCH_URL = "https://www.youtube.com/watch?v=";
  const INNERTUBE_URL = "https://www.youtube.com/youtubei/v1/player";
  const DEFAULT_WEB_VERSION = "2.20260801.00.00";
  const translators = new Map();
  let detectorPromise = null;

  const clients = [
    { name: "WEB", header: "1", version: null, context: {} },
    {
      name: "ANDROID",
      header: "3",
      version: "20.10.38",
      context: { clientFormFactor: "SMALL_FORM_FACTOR", androidSdkVersion: 34, osName: "Android", osVersion: "14", platform: "MOBILE" },
    },
    {
      name: "IOS",
      header: "5",
      version: "20.10.4",
      context: { deviceMake: "Apple", deviceModel: "iPhone16,2", osName: "iPhone", osVersion: "18.3.0.22D5054f", platform: "MOBILE" },
    },
  ];

  function result(id, ok, data, error = "") {
    window.postMessage({ namespace: "YTDS3", type: "result", id, ok, data, error }, "*");
  }

  function progress(id, data) {
    window.postMessage({ namespace: "YTDS3", type: "progress", id, data }, "*");
  }

  function tracksFromPlayer(data) {
    const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    return Array.isArray(tracks) ? tracks : [];
  }

  function currentPlayerResponse() {
    try {
      const player = document.querySelector("#movie_player");
      const fromPlayer = player?.getPlayerResponse?.();
      if (fromPlayer?.videoDetails?.videoId) return fromPlayer;
    } catch { /* 使用全局变量 */ }
    return window.ytInitialPlayerResponse || null;
  }

  function currentSession() {
    try {
      return {
        apiKey: window.ytcfg?.get?.("INNERTUBE_API_KEY") || "",
        clientVersion: window.ytcfg?.get?.("INNERTUBE_CLIENT_VERSION") || DEFAULT_WEB_VERSION,
        visitorData: window.ytcfg?.get?.("VISITOR_DATA") || "",
      };
    } catch {
      return { apiKey: "", clientVersion: DEFAULT_WEB_VERSION, visitorData: "" };
    }
  }

  function parseSession(html, fallback = currentSession()) {
    const apiKey = html.match(/"INNERTUBE_API_KEY":\s*"([\w-]+)"/)?.[1] || fallback.apiKey;
    const clientVersion = html.match(/"INNERTUBE_CLIENT_VERSION":\s*"([^"]+)"/)?.[1]
      || html.match(/"clientVersion":"([^"]+)"/)?.[1]
      || fallback.clientVersion;
    const visitorData = html.match(/"VISITOR_DATA":"([^"]+)"/)?.[1]
      || html.match(/"visitorData":"([^"]+)"/)?.[1]
      || fallback.visitorData;
    return { apiKey, clientVersion, visitorData };
  }

  function playerFromHtml(html) {
    const marker = "ytInitialPlayerResponse";
    const markerIndex = html.indexOf(marker);
    if (markerIndex < 0) return null;
    const start = html.indexOf("{", markerIndex);
    if (start < 0) return null;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = start; index < html.length; index++) {
      const char = html[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') quoted = true;
      else if (char === "{") depth++;
      else if (char === "}" && --depth === 0) {
        try { return JSON.parse(html.slice(start, index + 1)); } catch { return null; }
      }
    }
    return null;
  }

  async function innerTube(videoId, session, client) {
    if (!session.apiKey) throw new Error("YouTube 页面未提供播放器会话信息");
    const clientVersion = client.version || session.clientVersion;
    const response = await fetch(`${INNERTUBE_URL}?key=${session.apiKey}&prettyPrint=false`, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "X-YouTube-Client-Name": client.header,
        "X-YouTube-Client-Version": clientVersion,
      },
      body: JSON.stringify({
        context: {
          client: {
            hl: "en",
            gl: "US",
            utcOffsetMinutes: 0,
            visitorData: session.visitorData,
            clientName: client.name,
            clientVersion,
            ...client.context,
          },
          request: { useSsl: true },
        },
        videoId,
        contentCheckOk: true,
        racyCheckOk: true,
      }),
    });
    if (!response.ok) throw new Error(`InnerTube HTTP ${response.status}`);
    return tracksFromPlayer(await response.json());
  }

  async function extractCaptions(videoId) {
    const loaded = currentPlayerResponse();
    if (loaded?.videoDetails?.videoId === videoId) {
      const tracks = tracksFromPlayer(loaded);
      if (tracks.length) return tracks;
    }

    let session = currentSession();
    try {
      const response = await fetch(`${WATCH_URL}${videoId}&hl=en&persist_hl=1&has_verified=1&bpctr=9999999999`, {
        credentials: "include",
        headers: { Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
      });
      if (response.ok) {
        const html = await response.text();
        const parsed = playerFromHtml(html);
        if (parsed?.videoDetails?.videoId === videoId) {
          const tracks = tracksFromPlayer(parsed);
          if (tracks.length) return tracks;
        }
        session = parseSession(html, session);
      }
    } catch { /* InnerTube 兜底 */ }

    for (const client of clients) {
      try {
        const tracks = await innerTube(videoId, session, client);
        if (tracks.length) return tracks;
      } catch { /* 尝试下一个客户端 */ }
    }
    return [];
  }

  async function translatorAvailability(source, target) {
    if (!("Translator" in window)) return "unavailable";
    try {
      return await window.Translator.availability({ sourceLanguage: source, targetLanguage: target });
    } catch {
      return "unavailable";
    }
  }

  async function getTranslator(source, target, requestId) {
    const key = `${source}->${target}`;
    if (!translators.has(key)) {
      translators.set(key, window.Translator.create({
        sourceLanguage: source,
        targetLanguage: target,
        monitor(monitor) {
          monitor.addEventListener("downloadprogress", event => {
            progress(requestId, { loaded: event.loaded, total: event.total });
          });
        },
      }));
    }
    try {
      return await translators.get(key);
    } catch (error) {
      translators.delete(key);
      throw error;
    }
  }

  async function translateTexts(texts, source, target, requestId) {
    const availability = await translatorAvailability(source, target);
    if (availability === "unavailable") throw new Error("浏览器本地翻译不支持当前语言对");
    const translator = await getTranslator(source, target, requestId);
    const output = [];
    for (const text of texts || []) output.push(await translator.translate(String(text || "")));
    return output;
  }

  async function detectLanguage(text, requestId) {
    if (!("LanguageDetector" in window)) return "";
    const availability = await window.LanguageDetector.availability();
    if (availability === "unavailable") return "";
    if (!detectorPromise) {
      detectorPromise = window.LanguageDetector.create({
        expectedInputLanguages: ["en", "zh"],
        monitor(monitor) {
          monitor.addEventListener("downloadprogress", event => {
            progress(requestId, { loaded: event.loaded, total: event.total });
          });
        },
      });
    }
    const detector = await detectorPromise;
    const results = await detector.detect(String(text || ""));
    return results?.[0]?.detectedLanguage || "";
  }

  function allowedFetchUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && (
        url.hostname === "www.youtube.com"
        || url.hostname.endsWith(".youtube.com")
        || url.hostname.endsWith(".googlevideo.com")
      );
    } catch {
      return false;
    }
  }

  window.addEventListener("message", async event => {
    const message = event.data;
    if (event.source !== window || message?.namespace !== "YTDS3" || message.type !== "request") return;
    const { id, action, payload = {} } = message;
    try {
      if (action === "GET_PLAYER") {
        result(id, true, currentPlayerResponse());
      } else if (action === "GET_CAPTIONS") {
        result(id, true, await extractCaptions(payload.videoId));
      } else if (action === "FETCH") {
        if (!allowedFetchUrl(payload.url)) throw new Error("不允许的页面请求地址");
        const response = await fetch(payload.url, { credentials: "include" });
        result(id, true, { status: response.status, text: await response.text() });
      } else if (action === "TRANSLATOR_STATUS") {
        result(id, true, { availability: await translatorAvailability(payload.source, payload.target) });
      } else if (action === "TRANSLATE") {
        result(id, true, { texts: await translateTexts(payload.texts, payload.source, payload.target, id) });
      } else if (action === "DETECT") {
        result(id, true, { language: await detectLanguage(payload.text, id) });
      } else {
        throw new Error("未知桥接动作");
      }
    } catch (error) {
      result(id, false, null, error.message || String(error));
    }
  });

  window.addEventListener("pagehide", () => {
    for (const promise of translators.values()) promise.then(session => session.destroy?.()).catch(() => {});
    detectorPromise?.then(session => session.destroy?.()).catch(() => {});
  }, { once: true });
})();
