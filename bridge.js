(() => {
  "use strict";
  if (globalThis.__volumeStatsBridgeInstalled) return;
  globalThis.__volumeStatsBridgeInstalled = true;
  const PAGE_CHANNEL = "volume-stats-page";
  const COMMAND_CHANNEL = "volume-stats-extension";
  const ALLOWED_PAGE_TYPES = new Set([
    "READY", "STATUS", "CAPTURE_STATUS", "COLLECT_START", "COLLECT_PROGRESS",
    "COLLECT_DONE", "COLLECT_ERROR", "COLLECT_STOPPED"
  ]);
  const ALLOWED_COMMANDS = new Set(["PING", "CLEAR", "STOP", "START_API", "START_DOM"]);

  window.addEventListener("message", event => {
    if (event.source !== window || event.origin !== location.origin || !event.data || event.data.channel !== PAGE_CHANNEL) return;
    if (!ALLOWED_PAGE_TYPES.has(event.data.type)) return;
    chrome.runtime.sendMessage({ channel: "collector", payload: event.data }).catch(() => {});
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.channel !== "collector-command" || !ALLOWED_COMMANDS.has(message.command)) return false;
    window.postMessage({ channel: COMMAND_CHANNEL, command: message.command, options: message.options || {} }, location.origin);
    sendResponse({ ok: true, url: location.href, title: document.title });
    return false;
  });
})();
