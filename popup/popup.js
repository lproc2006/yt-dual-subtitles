// popup 控制面板
const $ = id => document.getElementById(id);

function refresh() {
  chrome.storage.sync.get(["enabled", "mode", "targetLang", "settings"], prefs => {
    $("enabled").checked = prefs.enabled !== false;
    $("mode").value = prefs.mode === "zh" ? "translated" : (prefs.mode || "dual");
    $("direction").value = prefs.targetLang || "auto";
    const s = prefs.settings || {};
    $("style").value = s.style || "cinema";
    $("fontsize").value = s.fontSize || 100;
    $("fontsize-label").textContent = (s.fontSize || 100) + "%";
    $("background").value = s.background || "none";
  });
  updateStatus();
}

function updateStatus() {
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    const tab = tabs[0];
    if (!tab || !tab.url || !tab.url.includes("youtube.com")) {
      $("status").textContent = "请在 YouTube 视频页使用";
      return;
    }
    chrome.tabs.sendMessage(tab.id, { type: "yt-ds-get-state" }).then(res => {
      if (res && res.enabled === false) {
        $("status").textContent = "字幕翻译已停用（打开上方开关开启）";
      } else if (res && res.error) {
        $("status").textContent = "⚠ " + res.error;
      } else if (res && res.phase === "partial" && res.total > 0) {
        $("status").textContent = `字幕已显示，部分译文暂未完成（${res.done}/${res.total}）`;
      } else if (res && res.total > 0) {
        if (res.translating) {
          const engine = res.engine === "local" ? "浏览器本地" : res.engine === "google" ? "Google 在线" : "准备中";
          $("status").textContent = `正在一次性翻译全部字幕 ${res.done}/${res.total}（${engine}，首次通常需 1–3 分钟）`;
        } else {
          const engine = res.engine === "cache" ? "本地缓存" : res.engine === "local" ? "浏览器本地" : res.engine === "google" ? "Google 在线" : "原文";
          $("status").textContent = `✓ 已就绪（${res.total} 条 · ${engine}）`;
        }
      } else if (res && res.phase === "source") {
        $("status").textContent = "正在一次性提取字幕，首次处理通常需 1–3 分钟…";
      } else if (res && res.phase === "recovering") {
        $("status").textContent = "本机字幕服务暂不可用，正在自动重试…";
      } else if (res && res.total === 0 && !res.error) {
        $("status").textContent = "正在准备整段字幕，首次处理通常需 1–3 分钟…";
      } else {
        $("status").textContent = "此视频无可用字幕";
      }
    }).catch(() => {
      $("status").textContent = "请刷新视频页面后重试";
    });
  });
}

$("enabled").addEventListener("change", async e => {
  const enabled = e.target.checked;
  $("status").textContent = enabled ? "正在启动字幕翻译…" : "字幕翻译已停用（打开上方开关开启）";
  await chrome.storage.sync.set({ enabled });
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id && tab.url?.includes("youtube.com")) {
      await chrome.tabs.sendMessage(tab.id, { type: "yt-ds-set-enabled", enabled });
    }
  } catch { /* storage 监听仍会兜底同步 */ }
  setTimeout(updateStatus, enabled ? 800 : 100);
});

$("mode").addEventListener("change", e => {
  chrome.storage.sync.set({ mode: e.target.value });
});

function updateSettings() {
  chrome.storage.sync.get("settings", prefs => {
    const s = { ...(prefs.settings || {}), style: $("style").value, fontSize: Number($("fontsize").value), background: $("background").value };
    chrome.storage.sync.set({ settings: s });
  });
}

$("style").addEventListener("change", updateSettings);
$("fontsize").addEventListener("input", e => {
  $("fontsize-label").textContent = e.target.value + "%";
  updateSettings();
});
$("background").addEventListener("change", updateSettings);

$("direction").addEventListener("change", e => {
  chrome.storage.sync.set({ targetLang: e.target.value });
  $("status").textContent = "已切换方向，正在重新加载字幕…";
  setTimeout(updateStatus, 3000);
});

// ---------- 导出 ----------
function slugify(s) {
  return (s || "字幕")
    .replace(/[\\/:*?"<>|\n\r]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60) || "字幕";
}

// 按停顿、完整语句和段落长度融合短字幕，导出为可阅读文章。
function buildParagraphs(segments, translations) {
  const paras = [];
  let cur = [];
  let chars = 0;
  const GAP_SECONDS = 2.8;
  const MAX_CHARS = 520;
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    const prev = i > 0 ? segments[i - 1] : null;
    const gap = prev ? s.start - prev.end : 0;
    const previousEnded = prev && /[。！？.!?][”"']?$/.test(prev.text.trim());
    if (cur.length && ((prev && gap > GAP_SECONDS) || (chars >= MAX_CHARS && previousEnded))) {
      paras.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push({ source: s.text, translated: (translations && translations[i]) || "" });
    chars += s.text.length;
  }
  if (cur.length) paras.push(cur);
  return paras;
}

function joinParagraph(items, field, language) {
  const value = items.map(item => item[field] || "").filter(Boolean).join(" ");
  return language === "zh"
    ? value.replace(/\s+/g, "").replace(/([，。！？；：])(?=[A-Za-z0-9])/g, "$1 ")
    : value.replace(/\s+/g, " ").replace(/\s+([,.;:!?])/g, "$1").trim();
}

async function exportMarkdown() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab || !tab.url || !tab.url.includes("youtube.com")) {
    $("status").textContent = "请先在 YouTube 视频页使用";
    return;
  }
  $("status").textContent = "正在整理字幕…";
  try {
    const data = await chrome.tabs.sendMessage(tab.id, { type: "yt-ds-export" });
    if (!data || !data.segments || !data.segments.length) {
      $("status").textContent = "✗ 无字幕可导出";
      return;
    }
    const fmt = document.querySelector('input[name="fmt"]:checked').value;
    const srcLang = data.sourceLang || "原";
    const tgtLang = data.targetLang === "en" ? "英" : "中";
    const sourceCode = /^zh/i.test(srcLang) ? "zh" : "en";
    const targetCode = data.targetLang === "en" ? "en" : "zh";
    const sameLanguage = data.sourceLang && data.sourceLang === data.targetLang;
    const translations = sameLanguage ? data.segments.map(segment => segment.text) : data.translations;
    const paras = buildParagraphs(data.segments, translations);

    const lines = [
      `# ${data.title || "YouTube 视频字幕"}`,
      "",
      `> 来源：${data.url}`,
      `> 语言：${srcLang} → ${tgtLang}`,
      `> 导出时间：${new Date().toLocaleString("zh-CN")}`,
      "",
    ];

    paras.forEach((p, idx) => {
      lines.push("");
      if (fmt === "source") {
        lines.push(joinParagraph(p, "source", sourceCode));
      } else if (fmt === "translated") {
        lines.push(joinParagraph(p, "translated", targetCode));
      } else {
        const source = joinParagraph(p, "source", sourceCode);
        const translated = joinParagraph(p, "translated", targetCode);
        lines.push(source);
        if (translated) lines.push("", translated);
        if (idx < paras.length - 1) lines.push("", "---");
      }
    });

    const md = lines.join("\n");
    const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const filename = `${slugify(data.title)}-${fmt === "dual" ? "中英对照" : fmt === "translated" ? "译文" : "原文"}.md`;
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    $("status").textContent = `✓ 已导出 ${data.segments.length} 条字幕（${paras.length} 段）`;
    setTimeout(URL.revokeObjectURL, 60000, url);
  } catch (e) {
    $("status").textContent = "✗ 导出失败，请刷新页面后重试";
  }
}

$("export-btn").addEventListener("click", exportMarkdown);

// 重新翻译：清除翻译缓存并强制重新翻译
$("retranslate-btn").addEventListener("click", async () => {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    if (!tab || !tab.url || !tab.url.includes("youtube.com")) {
      $("status").textContent = "请先在 YouTube 视频页使用";
      return;
    }
    await chrome.tabs.sendMessage(tab.id, { type: "yt-ds-retranslate" });
    $("status").textContent = "正在重新翻译…";
    setTimeout(updateStatus, 3000);
  } catch (e) {
    $("status").textContent = "请刷新视频页面后重试";
  }
});

$("clear-cache-btn").addEventListener("click", async () => {
  await chrome.storage.local.clear();
  $("status").textContent = "✓ 本地翻译缓存已清除";
});

refresh();
setInterval(updateStatus, 3000);
