// YouTube 双语字幕 - 时间轴与断句核心（浏览器/Node 测试共用）
(function initTimeline(root, factory) {
  const api = factory();
  root.YTDSCore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : window, () => {
  "use strict";

  const VERSION = 3;

  function normalizeLanguage(code) {
    const value = String(code || "").toLowerCase();
    if (value.startsWith("zh") || value === "cmn") return "zh";
    if (value.startsWith("en")) return "en";
    return value.split("-")[0] || "";
  }

  function detectTextLanguage(text, hint = "") {
    const normalizedHint = normalizeLanguage(hint);
    if (normalizedHint === "zh" || normalizedHint === "en") return normalizedHint;
    const sample = String(text || "").replace(/\s+/g, "");
    if (!sample) return "";
    const cjk = (sample.match(/[\u3400-\u9fff]/g) || []).length;
    const latin = (sample.match(/[A-Za-z]/g) || []).length;
    return cjk >= Math.max(2, latin * 0.18) ? "zh" : "en";
  }

  function targetLanguageFor(sourceLanguage, targetSetting = "auto") {
    const source = normalizeLanguage(sourceLanguage);
    if (targetSetting === "en") return "en";
    if (targetSetting === "zh-CN" || targetSetting === "zh") return "zh";
    return source === "zh" ? "en" : "zh";
  }

  function selectCaptionTrack(tracks, targetSetting = "auto") {
    const available = (Array.isArray(tracks) ? tracks : []).filter(track => track?.baseUrl);
    if (!available.length) return null;
    const languageOf = track => normalizeLanguage(track?.languageCode || "");
    const manual = track => track.kind !== "asr";
    const desiredSource = targetSetting === "en" ? "zh" : targetSetting === "zh-CN" ? "en" : "";
    if (desiredSource) {
      return available.find(track => languageOf(track) === desiredSource && manual(track))
        || available.find(track => languageOf(track) === desiredSource)
        || available.find(track => track.kind === "asr" && ["en", "zh"].includes(languageOf(track)))
        || available.find(track => ["en", "zh"].includes(languageOf(track)) && manual(track))
        || available[0];
    }
    return available.find(track => track.kind === "asr" && ["en", "zh"].includes(languageOf(track)))
      || available.find(track => ["en", "zh"].includes(languageOf(track)) && manual(track))
      || available[0];
  }

  function cleanText(value) {
    return String(value || "")
      .replace(/<[^>]*>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;|&#39;|&#x27;/g, "'")
      .replace(/&nbsp;/g, " ")
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
      .replace(/\s+/g, " ")
      .trim();
  }

  function sharedWordPrefix(previous, current) {
    const a = cleanText(previous).split(/\s+/);
    const b = cleanText(current).split(/\s+/);
    const max = Math.min(12, a.length, b.length);
    for (let count = max; count >= 2; count--) {
      const tail = a.slice(-count).join(" ").toLowerCase();
      const head = b.slice(0, count).join(" ").toLowerCase();
      if (tail === head && tail.length >= 7) return count;
    }
    return 0;
  }

  function removeRollingPrefix(previous, current) {
    const count = sharedWordPrefix(previous, current);
    if (!count) return current;
    return cleanText(current).split(/\s+/).slice(count).join(" ").trim();
  }

  function coalesceSameStart(cues) {
    const out = [];
    for (const cue of cues) {
      const last = out[out.length - 1];
      if (last && Math.abs(last.start - cue.start) < 0.06) {
        if (cue.text === last.text) {
          last.end = Math.max(last.end, cue.end);
        } else if (cue.text.includes(last.text)) {
          out[out.length - 1] = { ...cue, end: Math.max(last.end, cue.end) };
        } else if (!last.text.includes(cue.text)) {
          last.text = `${last.text} ${cue.text}`.trim();
          last.end = Math.max(last.end, cue.end);
        }
      } else {
        out.push({ ...cue });
      }
    }
    return out;
  }

  function splitByBudget(text, language, maxChars) {
    const value = cleanText(text);
    if (!value || value.length <= maxChars) return value ? [value] : [];
    const chunks = [];
    let remaining = value;
    const isZh = normalizeLanguage(language) === "zh";
    while (remaining.length > maxChars) {
      const window = remaining.slice(0, maxChars + Math.round(maxChars * 0.25));
      let cut = -1;
      const preferred = isZh
        ? [/[。！？；：]/g, /[，、]/g]
        : [/[.!?;:]\s+/g, /[,—-]\s+/g, /\s+(?=(?:and|but|because|so|which|that|when|while|however)\b)/gi];
      for (const re of preferred) {
        let match;
        while ((match = re.exec(window))) {
          const pos = match.index + match[0].length;
          if (pos >= Math.round(maxChars * 0.45) && pos <= Math.round(maxChars * 1.2)) cut = pos;
          if (!match[0].length) re.lastIndex++;
        }
        if (cut > 0) break;
      }
      if (cut < 0 && !isZh) {
        const space = window.lastIndexOf(" ", maxChars);
        if (space >= Math.round(maxChars * 0.45)) cut = space;
      }
      if (cut < 0) cut = Math.min(maxChars, remaining.length);
      chunks.push(remaining.slice(0, cut).trim());
      remaining = remaining.slice(cut).trim();
    }
    if (remaining) chunks.push(remaining);
    return chunks.filter(Boolean);
  }

  function splitCue(cue, language) {
    const lang = normalizeLanguage(language) || detectTextLanguage(cue.text);
    const maxChars = lang === "zh" ? 34 : 86;
    const duration = Math.max(0.35, cue.end - cue.start);
    let parts = cleanText(cue.text).split(/(?<=[。！？!?])\s*/).filter(Boolean);
    if (parts.length === 1) parts = splitByBudget(cue.text, lang, maxChars);
    else parts = parts.flatMap(part => splitByBudget(part, lang, maxChars));
    if (duration <= 5.5 && parts.length === 1) return [{ ...cue, text: parts[0] }];
    if (parts.length === 1 && duration > 5.5) parts = splitByBudget(cue.text, lang, Math.max(18, Math.round(maxChars * 0.72)));
    if (parts.length === 1) return [{ ...cue, text: parts[0] }];

    const weights = parts.map(part => Math.max(1, part.replace(/\s+/g, "").length));
    const total = weights.reduce((sum, value) => sum + value, 0);
    let cursor = cue.start;
    return parts.map((text, index) => {
      const end = index === parts.length - 1
        ? cue.end
        : cursor + duration * (weights[index] / total);
      const result = { text, start: cursor, end: Math.max(cursor + 0.2, end) };
      cursor = result.end;
      return result;
    });
  }

  function normalizeSegments(rawSegments, languageHint = "") {
    const sanitized = (Array.isArray(rawSegments) ? rawSegments : [])
      .map((item, index) => {
        const start = Number(item?.start);
        const end = Number(item?.end);
        const text = cleanText(item?.text);
        if (!Number.isFinite(start) || !text) return null;
        return {
          text,
          start: Math.max(0, start),
          end: Number.isFinite(end) ? end : start + 2.5,
          _order: index,
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.start - b.start || a._order - b._order);

    const cues = coalesceSameStart(sanitized);
    const deduped = [];
    for (const cue of cues) {
      const previous = deduped[deduped.length - 1];
      if (previous && cue.text === previous.text && cue.start - previous.start < 1.2) {
        previous.end = Math.max(previous.end, cue.end);
        continue;
      }
      if (previous && cue.start < previous.end) {
        const trimmed = removeRollingPrefix(previous.text, cue.text);
        if (!trimmed) continue;
        cue.text = trimmed;
      }
      deduped.push(cue);
    }

    const timed = [];
    for (let index = 0; index < deduped.length; index++) {
      const cue = deduped[index];
      const nextStart = deduped[index + 1]?.start;
      let end = Number.isFinite(cue.end) ? cue.end : cue.start + 2.5;
      if (Number.isFinite(nextStart) && nextStart > cue.start) end = Math.min(end, nextStart);
      if (end <= cue.start + 0.08) {
        if (Number.isFinite(nextStart) && nextStart > cue.start + 0.08) end = nextStart;
        else continue;
      }
      timed.push({ text: cue.text, start: cue.start, end });
    }

    const sample = timed.slice(0, 12).map(cue => cue.text).join(" ");
    const language = detectTextLanguage(sample, languageHint) || "en";
    const split = timed.flatMap(cue => splitCue(cue, language));
    const out = [];
    for (const cue of split) {
      const previous = out[out.length - 1];
      const gap = previous ? cue.start - previous.end : 0;
      const budget = language === "zh" ? 32 : 78;
      const combinedLength = previous ? `${previous.text} ${cue.text}`.length : 0;
      if (
        previous &&
        previous.end - previous.start < 0.7 &&
        gap >= 0 && gap < 0.22 &&
        cue.end - previous.start <= 4.6 &&
        combinedLength <= budget
      ) {
        previous.text = `${previous.text} ${cue.text}`.replace(/\s+([，。！？,.!?])/g, "$1").trim();
        previous.end = cue.end;
      } else {
        out.push({ text: cue.text, start: cue.start, end: cue.end });
      }
    }

    for (let index = 0; index < out.length - 1; index++) {
      if (out[index].end > out[index + 1].start) out[index].end = out[index + 1].start;
    }
    return out.filter(cue => cue.text && cue.end > cue.start + 0.05);
  }

  function validateTimeline(segments) {
    const errors = [];
    let previousStart = -1;
    let previousEnd = -1;
    (Array.isArray(segments) ? segments : []).forEach((cue, index) => {
      if (!cue || !cleanText(cue.text)) errors.push(`empty:${index}`);
      if (!Number.isFinite(Number(cue?.start)) || !Number.isFinite(Number(cue?.end))) errors.push(`nan:${index}`);
      if (Number(cue?.end) <= Number(cue?.start)) errors.push(`duration:${index}`);
      if (Number(cue?.start) < previousStart) errors.push(`order:${index}`);
      if (Number(cue?.start) < previousEnd - 0.02) errors.push(`overlap:${index}`);
      previousStart = Number(cue?.start);
      previousEnd = Number(cue?.end);
    });
    return { ok: errors.length === 0 && segments.length > 0, errors };
  }

  function fingerprintSegments(segments) {
    let hash = 2166136261;
    const input = (segments || [])
      .map(cue => `${Number(cue.start).toFixed(2)}|${Number(cue.end).toFixed(2)}|${cleanText(cue.text)}`)
      .join("\n");
    for (let index = 0; index < input.length; index++) {
      hash ^= input.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  function breakLines(text, languageHint = "") {
    const value = cleanText(text);
    if (!value) return [];
    const language = detectTextLanguage(value, languageHint);
    const max = language === "zh" ? 20 : 54;
    if (value.length <= max) return [value];
    const chunks = splitByBudget(value, language, max);
    if (chunks.length <= 2) return chunks;
    return [chunks[0], chunks.slice(1).join(language === "zh" ? "" : " ")];
  }

  function cueIndexAt(segments, currentTime) {
    let low = 0;
    let high = segments.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const cue = segments[middle];
      if (currentTime < cue.start) high = middle - 1;
      else if (currentTime > cue.end) low = middle + 1;
      else return middle;
    }
    return -1;
  }

  function classifySubtitleOutcome(segments, translations) {
    const total = Array.isArray(segments) ? segments.length : 0;
    const completed = Array.isArray(translations)
      ? translations.slice(0, total).filter(value => cleanText(value)).length
      : 0;
    const coverage = total > 0 ? completed / total : 0;
    if (!total) return { kind: "load-error", total, completed, coverage };
    if (coverage >= 0.9) return { kind: "ready", total, completed, coverage };
    if (completed > 0) return { kind: "partial", total, completed, coverage };
    return { kind: "source-only", total, completed, coverage };
  }

  return {
    VERSION,
    breakLines,
    cleanText,
    classifySubtitleOutcome,
    cueIndexAt,
    detectTextLanguage,
    fingerprintSegments,
    normalizeLanguage,
    normalizeSegments,
    selectCaptionTrack,
    targetLanguageFor,
    validateTimeline,
  };
});
