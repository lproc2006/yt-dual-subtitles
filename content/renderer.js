// YouTube 双语字幕 - 可恢复的播放器字幕层
(function initRenderer(root) {
  "use strict";

  class SubtitleRenderer {
    constructor(core) {
      this.core = core;
      this.root = null;
      this.sourceEl = null;
      this.translationEl = null;
      this.statusEl = null;
      this.host = null;
      this.video = null;
      this.getSnapshot = null;
      this.rafId = 0;
      this.lastKey = "";
      this.pendingStatus = "";
      this.observer = new MutationObserver(() => {
        if (this.root && !this.root.isConnected) this.invalidate();
      });
    }

    findHost() {
      return document.querySelector(".html5-video-player") || document.querySelector("video")?.parentElement || null;
    }

    invalidate() {
      this.root = null;
      this.sourceEl = null;
      this.translationEl = null;
      this.statusEl = null;
      this.host = null;
      this.lastKey = "";
    }

    ensure() {
      const host = this.findHost();
      if (!host) return false;
      // 扩展开发期重新加载、页面进入 bfcache 或 YouTube 复用播放器时，
      // 旧 content script 可能留下一个不再受控的同名字幕层。
      // 当前渲染器接管前先移除所有非本实例节点，避免跨视频残影。
      document.querySelectorAll("#yt-ds-overlay").forEach(element => {
        if (element !== this.root) element.remove();
      });
      if (this.root?.isConnected && this.host === host) return true;
      if (this.root?.isConnected) this.root.remove();
      this.invalidate();

      const rootEl = document.createElement("div");
      rootEl.id = "yt-ds-overlay";
      rootEl.setAttribute("aria-live", "off");
      const sourceEl = document.createElement("div");
      sourceEl.className = "yt-ds-source";
      const translationEl = document.createElement("div");
      translationEl.className = "yt-ds-translation";
      const statusEl = document.createElement("div");
      statusEl.className = "yt-ds-status";
      statusEl.hidden = true;
      rootEl.append(sourceEl, translationEl, statusEl);
      host.appendChild(rootEl);

      this.root = rootEl;
      this.sourceEl = sourceEl;
      this.translationEl = translationEl;
      this.statusEl = statusEl;
      this.host = host;
      this.applySettings(this.getSnapshot?.()?.settings);
      if (this.pendingStatus) this.setStatus(this.pendingStatus);
      return true;
    }

    applySettings(settings = {}) {
      if (!this.ensure()) return;
      this.root.dataset.style = settings.style === "minimal" ? "minimal" : "cinema";
      this.root.dataset.bg = ["translucent", "solid"].includes(settings.background) ? settings.background : "none";
      const size = Math.min(160, Math.max(80, Number(settings.fontSize) || 100));
      this.root.style.setProperty("--font-scale", (size / 100).toFixed(2));
    }

    setStatus(message) {
      this.pendingStatus = String(message || "");
      if (!this.ensure()) return;
      this.statusEl.textContent = this.pendingStatus;
      this.statusEl.hidden = !this.pendingStatus;
    }

    clear({ keepStatus = false } = {}) {
      this.lastKey = "";
      if (!this.ensure()) return;
      this.sourceEl.textContent = "";
      this.translationEl.textContent = "";
      this.sourceEl.hidden = true;
      this.translationEl.hidden = true;
      if (!keepStatus) this.setStatus("");
    }

    renderLine(element, text, language) {
      element.textContent = this.core.breakLines(text, language).join("\n");
    }

    render(currentTime, snapshot) {
      if (!snapshot?.enabled || !this.ensure()) return;
      const segments = snapshot.segments || [];
      if (!segments.length) {
        if (this.lastKey !== "empty") {
          this.sourceEl.textContent = "";
          this.translationEl.textContent = "";
          this.sourceEl.hidden = true;
          this.translationEl.hidden = true;
          this.lastKey = "empty";
        }
        return;
      }

      const index = this.core.cueIndexAt(segments, currentTime + 0.08);
      const cue = index >= 0 ? segments[index] : null;
      const translation = index >= 0 ? String(snapshot.translations?.[index] || "") : "";
      const key = `${snapshot.videoId || ""}:${index}:${translation}`;
      if (key === this.lastKey) return;
      this.lastKey = key;

      if (!cue) {
        this.sourceEl.textContent = "";
        this.translationEl.textContent = "";
        this.sourceEl.hidden = true;
        this.translationEl.hidden = true;
        return;
      }

      const sourceLanguage = snapshot.sourceLang || this.core.detectTextLanguage(cue.text);
      const targetLanguage = snapshot.actualTarget || (sourceLanguage === "zh" ? "en" : "zh");
      if (snapshot.mode === "dual") {
        this.renderLine(this.sourceEl, cue.text, sourceLanguage);
        this.sourceEl.hidden = false;
        if (translation) {
          this.renderLine(this.translationEl, translation, targetLanguage);
          this.translationEl.dataset.pending = "false";
          this.translationEl.hidden = false;
        } else {
          this.translationEl.textContent = "";
          this.translationEl.hidden = true;
        }
      } else {
        this.sourceEl.textContent = "";
        this.sourceEl.hidden = true;
        // 译文尚未完成时先显示原文，避免播放期间出现空白字幕。
        this.renderLine(this.translationEl, translation || cue.text, translation ? targetLanguage : sourceLanguage);
        this.translationEl.dataset.pending = translation ? "false" : "true";
        this.translationEl.hidden = false;
      }
    }

    start(getSnapshot) {
      this.getSnapshot = getSnapshot;
      this.observer.disconnect();
      if (document.documentElement) this.observer.observe(document.documentElement, { childList: true, subtree: true });
      if (this.rafId) return;
      const frame = () => {
        const snapshot = this.getSnapshot?.();
        if (snapshot?.enabled) {
          if (!this.video?.isConnected) this.video = document.querySelector("video");
          if (this.video) this.render(this.video.currentTime, snapshot);
        }
        this.rafId = requestAnimationFrame(frame);
      };
      this.rafId = requestAnimationFrame(frame);
    }

    stop({ remove = false } = {}) {
      if (this.rafId) cancelAnimationFrame(this.rafId);
      this.rafId = 0;
      this.observer.disconnect();
      this.video = null;
      this.pendingStatus = "";
      if (remove && this.root?.isConnected) this.root.remove();
      this.invalidate();
    }
  }

  root.YTDSRenderer = { SubtitleRenderer };
})(typeof globalThis !== "undefined" ? globalThis : window);
