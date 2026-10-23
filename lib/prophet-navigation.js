const { withBrowserPage } = require("./binance-navigation");

const SEASON_ID = "prophet_1019_s1";
const SOURCE_URL = `https://www.bsmkweb.cc/zh-CN/prophet/leaderboard?seasonId=${SEASON_ID}`;
const API_PATH = "/bapi/defi/v1/friendly/wallet-direct/growth/prophet/season/";
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// 入口可能使用脚本跳转；只用独立浏览器发现来源，不渲染/滚动采集全榜。
async function resolveProphetOrigin(send, {
  timeoutMs = 30000, pause = delay,
  validateTarget = url => require("./parser").validatePublicHttpsHost(url)
} = {}) {
  await send("Page.navigate", { url: SOURCE_URL });
  const deadline = Date.now() + timeoutMs;
  const probed = new Set();
  let previousOrigin;
  while (Date.now() < deadline) {
    let current;
    try {
      const result = await send("Runtime.evaluate", { expression: "location.href", returnByValue: true });
      if (!result.exceptionDetails && typeof result.result?.value === "string") current = new URL(result.result.value);
    } catch (_) { /* 页面跳转会销毁执行上下文，下一轮重读。 */ }
    if (current && current.origin === previousOrigin && !probed.has(current.origin) &&
        /^\/(?:[a-z]{2}(?:-[a-z]{2,8})?\/)?prophet\/leaderboard\/?$/i.test(current.pathname) &&
        current.searchParams.get("seasonId") === SEASON_ID) {
      probed.add(current.origin);
      await validateTarget(current.href);
      const origin = current.origin;
      try {
        const result = await send("Runtime.evaluate", {
          expression: `(async () => {
            const origin = ${JSON.stringify(origin)};
            if (location.origin !== origin) return false;
            try {
              const response = await fetch(new URL(${JSON.stringify(API_PATH + "query")}, origin), {
                method: "POST", credentials: "omit", redirect: "error",
                headers: { "content-type": "application/json", accept: "application/json" },
                body: ${JSON.stringify(JSON.stringify({ seasonId: SEASON_ID }))}, signal: AbortSignal.timeout(4000)
              });
              if (!response.ok || !response.headers.get("content-type")?.includes("json")) return false;
              const json = await response.json();
              return location.origin === origin && new URL(response.url).origin === origin &&
                json.success === true && json.code === "000000" &&
                Number.isSafeInteger(json.data?.seasonStartTime) && json.data.seasonStartTime > 0 &&
                Number.isSafeInteger(json.data?.seasonEndTime) && json.data.seasonEndTime > json.data.seasonStartTime &&
                Array.isArray(json.data?.weekInfos) && json.data.weekInfos.length > 0;
            } catch (_) { return false; }
          })()`, awaitPromise: true, returnByValue: true
        });
        if (!result.exceptionDetails && result.result?.value === true) return origin;
      } catch (_) { /* 中转页不作为可用来源，每个来源最多探测一次。 */ }
    }
    previousOrigin = current?.origin;
    await pause(500);
  }
  throw new Error("bsmkweb.cc 未能提供当前可用的神算子域名");
}

function createSourceResolver({ openPage = withBrowserPage, resolve = resolveProphetOrigin, now = Date.now } = {}) {
  let cached;
  let pending;
  return {
    async getOrigin() {
      if (cached && now() < cached.expiresAt) return cached.origin;
      if (!pending) {
        pending = Promise.resolve().then(() => openPage(resolve)).then(origin => {
          cached = { origin, expiresAt: now() + 300000 };
          return origin;
        }).catch(() => {
          cached = null;
          throw Object.assign(new Error("bsmkweb.cc 神算子导航暂时不可用，请检查浏览器及网络后重试；已保留上次数据"), { statusCode: 502, transport: true });
        }).finally(() => { pending = null; });
      }
      return pending;
    },
    invalidate(origin) { if (cached?.origin === origin) cached = null; }
  };
}

const source = createSourceResolver();
module.exports = { SEASON_ID, SOURCE_URL, API_PATH, resolveProphetOrigin, createSourceResolver,
  getOrigin: source.getOrigin, invalidate: source.invalidate };
