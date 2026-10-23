const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const LIST_URL = "https://www.bsmkweb.cc/zh-CN/support/announcement/list/93";
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function resolveLeaderboardUrl(send, input, {
  timeoutMs = 30000, pause = delay,
  validateTarget = url => require("./parser").validateLeaderboardHost(url)
} = {}) {
  await send("Page.navigate", { url: LIST_URL });
  const deadline = Date.now() + timeoutMs;
  const navigationOrigin = new URL(LIST_URL).origin;
  const probedOrigins = new Set();
  let previousOrigin;
  while (Date.now() < deadline) {
    let current;
    let appReady = false;
    try {
      const result = await send("Runtime.evaluate", {
        expression: `({ href: location.href, ready: document.readyState,
          app: Boolean(document.getElementById("__APP_DATA") || document.getElementById("__NEXT_DATA__")) })`,
        returnByValue: true
      });
      const state = result.result?.value;
      if (!result.exceptionDetails && state?.href) {
        const parsed = new URL(state.href);
        // 中转站可能 complete，真实应用也可能一直 loading；先确认来源稳定，再验证可用性。
        if (parsed.protocol === "https:") {
          current = parsed;
          appReady = state.ready !== "loading" && state.app === true;
        }
      }
    } catch (_) {}
    if (current && current.origin === previousOrigin) {
      const target = new URL(input);
      target.protocol = current.protocol;
      target.host = current.host;
      if (appReady) {
        await validateTarget(target.href);
        return target.href;
      }
      // 旧 DOM 标记缺失/空白落地页时，以同源公开 CMS 正常响应证明入口可用。
      // 每个来源只探测一次，不使用固定备用域名，不把 Loading 中转页当作币安应用。
      if (current.origin !== navigationOrigin && !probedOrigins.has(current.origin)) {
        probedOrigins.add(current.origin);
        await validateTarget(target.href);
        try {
          const result = await send("Runtime.evaluate", {
            expression: `(async () => {
              const origin = ${JSON.stringify(current.origin)};
              if (location.origin !== origin) return false;
              try {
                const response = await fetch(new URL("/bapi/composite/v1/public/cms/article/catalog/list/query?catalogId=93&pageNo=1&pageSize=1", origin), {
                  credentials: "omit", redirect: "error", headers: { accept: "application/json", lang: "zh-CN", clienttype: "web" },
                  signal: AbortSignal.timeout(4000)
                });
                if (!response.ok || !response.headers.get("content-type")?.includes("json")) return false;
                const data = await response.json();
                return location.origin === origin && new URL(response.url).origin === origin && data.code === "000000" && Array.isArray(data.data?.articles) && data.data.articles.length > 0;
              } catch (_) { return false; }
            })()`,
            awaitPromise: true, returnByValue: true
          });
          if (!result.exceptionDetails && result.result?.value === true) return target.href;
        } catch (_) { /* 跳转或探测失败时继续等待原有页面标记，不使用旧域名兜底。 */ }
      }
    }
    previousOrigin = current?.origin;
    await pause(500);
  }
  throw new Error("bsmkweb.cc 未能提供当前可用的抓榜域名，请稍后重试");
}

// 导航站可能用 JavaScript 选择目标域名，不能只跟随 HTTP 重定向。
async function readAnnouncement(send, pathname, { timeoutMs = 45000, pause = delay } = {}) {
  await send("Page.enable");
  await send("Page.navigate", { url: LIST_URL });
  const deadline = Date.now() + timeoutMs;
  const apiPath = `/bapi/composite/v1/public/cms${pathname}`;
  while (Date.now() < deadline) {
    try {
      const result = await send("Runtime.evaluate", {
        expression: `(async () => {
          if (location.protocol !== "https:") return null;
          try {
            const response = await fetch(new URL(${JSON.stringify(apiPath)}, location.origin), {
              credentials: "omit", headers: { accept: "application/json", lang: "zh-CN", clienttype: "web" },
              signal: AbortSignal.timeout(5000)
            });
            if (!response.ok || !response.headers.get("content-type")?.includes("json")) return null;
            return { data: await response.json(), origin: location.origin };
          } catch (_) { return null; }
        })()`,
        awaitPromise: true,
        returnByValue: true
      });
      if (!result.exceptionDetails && result.result?.value?.data) return result.result.value;
    } catch (_) {
      // 跳转时执行上下文会销毁；下一次使用跳转后的上下文。
    }
    await pause(500);
  }
  throw new Error("bsmkweb.cc 公告导航未能返回公告数据，请检查服务器网络和浏览器是否可访问该导航网址");
}

async function withBrowserPage(task) {
  // 延迟引用，避免 crawler -> parser -> binance-api 的模块循环。
  const browserPath = require("./crawler").findBrowserPath();
  if (!browserPath) throw new Error("公告导航需要 Chrome、Brave 或 Chromium，请先在服务器安装浏览器");
  if (typeof WebSocket !== "function") throw new Error("公告导航需要 Node.js 22 或更高版本");
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "eventlens-announcement-"));
  const child = spawn(browserPath, [
    "--headless=new",
    ...(process.platform === "darwin" ? ["--use-mock-keychain", "--password-store=basic"] : []),
    "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1",
    "--disable-gpu", "--disable-background-networking", "--no-first-run", "--no-default-browser-check",
    `--user-data-dir=${profile}`, "about:blank"
  ], { stdio: "ignore" });
  let launchError;
  child.on("error", error => { launchError = error; });
  const stopChild = () => { try { child.kill("SIGKILL"); } catch (_) {} };
  process.once("exit", stopChild);
  let socket;
  const pending = new Map();
  const rejectPending = () => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error("公告导航浏览器连接已关闭")); }
    pending.clear();
  };
  try {
    let wsUrl;
    for (let attempt = 0; attempt < 40; attempt++) {
      if (launchError || child.exitCode !== null) throw new Error("公告浏览器启动失败，请以普通用户运行并检查浏览器依赖");
      try {
        const [port] = (await fs.readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split("\n");
        if (!/^\d+$/.test(port)) throw new Error("浏览器调试端口无效");
        const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) });
        const tabs = response.ok ? await response.json() : [];
        wsUrl = tabs.find(tab => tab.type === "page")?.webSocketDebuggerUrl;
        if (wsUrl) break;
      } catch (_) {}
      await delay(250);
    }
    if (!wsUrl) throw new Error("无法连接公告导航浏览器");
    socket = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("公告导航浏览器连接超时")), 5000);
      socket.onopen = () => { clearTimeout(timer); resolve(); };
      socket.onerror = () => { clearTimeout(timer); reject(new Error("公告导航浏览器连接失败")); };
    });
    let nextId = 0;
    socket.onclose = rejectPending;
    socket.onerror = rejectPending;
    socket.onmessage = event => {
      let message;
      try { message = JSON.parse(event.data); } catch (_) { return; }
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error("公告导航浏览器命令失败"));
      else entry.resolve(message.result);
    };
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error("公告导航浏览器响应超时")); }, 8000);
      pending.set(id, { resolve, reject, timer });
      try { socket.send(JSON.stringify({ id, method, params })); }
      catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
    });
    return await task(send);
  } finally {
    rejectPending();
    try { socket?.close(); } catch (_) {}
    process.removeListener("exit", stopChild);
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([new Promise(resolve => child.once("exit", resolve)), delay(1000)]);
      if (child.exitCode === null) stopChild();
    }
    await fs.rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
  }
}

const requestJson = pathname => withBrowserPage(send => readAnnouncement(send, pathname));

module.exports = { LIST_URL, requestJson, readAnnouncement, resolveLeaderboardUrl, withBrowserPage };
