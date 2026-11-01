const LOCAL_SERVICE = "http://127.0.0.1:8765";

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "yt-ds-pair") return;
  fetch(`${LOCAL_SERVICE}/pair`, { cache: "no-store" })
    .then(async (response) => {
      const data = await response.json().catch(() => null);
      const token = String(data?.token || "");
      if (!response.ok || !/^[0-9a-f]{32,}$/i.test(token)) {
        sendResponse({ ok: false });
        return;
      }
      sendResponse({ ok: true, token });
    })
    .catch(() => sendResponse({ ok: false }));
  return true;
});
