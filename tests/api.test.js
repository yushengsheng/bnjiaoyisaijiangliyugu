const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { makeDataDir, sampleSnapshot } = require("./helpers");

process.env.EVENTLENS_DATA_DIR = makeDataDir();
const binanceApi = require("../lib/binance-api");
binanceApi.getTickerPrice = async () => { throw new Error("offline fixture"); };
const serverModule = require("../server");
const storage = require("../lib/storage");
const market = require("../lib/market");

let server;
let base;
let token;

async function json(path, options = {}) {
  const response = await fetch(`${base}${path}`, { cache: "no-store", ...options });
  const data = await response.json().catch(() => ({}));
  return { response, data };
}

function rawRequest(path, headers = {}) {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: url.hostname, port: url.port, method: "GET", path, headers }, response => {
      let body = "";
      response.on("data", chunk => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body }));
    });
    request.on("error", reject);
    request.end();
  });
}

test.before(async () => {
  server = serverModule.createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  token = (await json("/api/session")).data.token;
});

test.after(async () => {
  if (server?.listening) await new Promise(resolve => server.close(resolve));
});

test("健康检查和安全响应头可用且不开放通配 CORS", async () => {
  const { response, data } = await json("/api/health");
  assert.equal(response.status, 200);
  assert.equal(data.app, "eventlens-local");
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.match(response.headers.get("content-security-policy"), /default-src 'self'/);
});

test("路径穿越不能读取 server.js", async () => {
  const result = await rawRequest("/../server.js");
  assert.ok(result.status === 403 || result.status === 404);
  assert.doesNotMatch(result.body, /createApplicationServer/);
});

test("非法 Host 被拒绝", async () => {
  const result = await rawRequest("/api/health", { Host: "evil.example" });
  assert.equal(result.status, 403);
});

test("未知活动返回 404 而不是首个活动数据", async () => {
  const { response, data } = await json("/api/binance/ranking?campaignId=definitely-missing");
  assert.equal(response.status, 404);
  assert.match(data.error, /未找到活动|活动不存在/);
});

test("写接口要求本地会话令牌", async () => {
  const { response } = await json("/api/ranking/update", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: base },
    body: JSON.stringify({ campaignId: "sample-campaign", snapshot: sampleSnapshot() })
  });
  assert.equal(response.status, 403);
});

test("多字节伪造令牌返回 403 且不会抛出 RangeError", async () => {
  const { response } = await json("/api/ranking/update", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: base, "X-EventLens-Token": "é".repeat(64) },
    body: JSON.stringify({ campaignId: "sample-campaign", snapshot: sampleSnapshot() })
  });
  assert.equal(response.status, 403);
  assert.equal((await json("/api/health")).response.status, 200);
});

test("即使令牌正确，跨站来源也不能写入", async () => {
  const { response } = await json("/api/ranking/update", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://evil.example", "X-EventLens-Token": token },
    body: JSON.stringify({ campaignId: "sample-campaign", snapshot: sampleSnapshot() })
  });
  assert.equal(response.status, 403);
});

test("不同本地端口也视为跨站来源", async () => {
  const { response } = await json("/api/ranking/update", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://127.0.0.1:65530", "X-EventLens-Token": token },
    body: JSON.stringify({ campaignId: "sample-campaign", snapshot: sampleSnapshot() })
  });
  assert.equal(response.status, 403);
});

test("任意 URL 不能触发本机浏览器访问", async () => {
  const { response, data } = await json("/api/campaigns/add-by-url", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: base, "X-EventLens-Token": token },
    body: JSON.stringify({ url: "https://127.0.0.1/internal" })
  });
  assert.equal(response.status, 400);
  assert.match(data.error, /币安官方域名/);
});

test("多赛道联赛公告代码不能在缺少具体子赛道时直接落库", async () => {
  const original = binanceApi.getAnnouncementDetail;
  binanceApi.getAnnouncementDetail = async () => ({
    title: "币安交易者联赛第四季",
    code: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    body: JSON.stringify({
      tag: "div",
      child: [
        { node: "text", text: "交易者联赛包含多个独立赛道" },
        { tag: "a", attr: { href: "https://www.binance.com/zh-CN/activity/trading-competition/202609tradersleague4" }, child: [] }
      ]
    })
  });
  try {
    const { response, data } = await json("/api/announcements/parse", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: base, "X-EventLens-Token": token },
      body: JSON.stringify({ urlOrCode: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" })
    });
    assert.equal(response.status, 400);
    assert.match(data.error, /具体.*子赛道|子赛道.*链接/);
  } finally {
    binanceApi.getAnnouncementDetail = original;
  }
});

test("联赛公告首个链接即使已带 Round1，公告代码录入仍要求显式粘贴子赛道 URL", async () => {
  const original = binanceApi.getAnnouncementDetail;
  binanceApi.getAnnouncementDetail = async () => ({
    title: "币安交易者联赛第四季",
    code: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    body: JSON.stringify({
      tag: "div",
      child: [
        { node: "text", text: "交易者联赛包含多个独立赛道，活动总奖池 1,200 BNB" },
        { tag: "a", attr: { href: "https://www.binance.com/zh-CN/activity/trading-competition/202609tradersleague4/Spot-Carnival-Waves-Round1" }, child: [] }
      ]
    })
  });
  try {
    const { response, data } = await json("/api/announcements/parse", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: base, "X-EventLens-Token": token },
      body: JSON.stringify({ urlOrCode: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" })
    });
    assert.equal(response.status, 400);
    assert.match(data.error, /具体.*子赛道|子赛道.*链接/);
  } finally {
    binanceApi.getAnnouncementDetail = original;
  }
});

test("自动更新开关可保存并立即启停调度器", async () => {
  const headers = { "Content-Type": "application/json", Origin: base, "X-EventLens-Token": token };
  let result = await json("/api/scheduler/config", {
    method: "POST",
    headers,
    body: JSON.stringify({ autoUpdateEnabled: true })
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.data.settings.autoUpdateEnabled, true);
  assert.equal(result.data.status.enabled, true);

  result = await json("/api/scheduler/config", {
    method: "POST",
    headers,
    body: JSON.stringify({ autoUpdateEnabled: false })
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.data.settings.autoUpdateEnabled, false);
  assert.equal(result.data.status.enabled, false);
  assert.equal((await storage.getSchedulerSettings()).autoUpdateEnabled, false);
});

test("调度接口未传 campaignId 时返回实际更新的默认活动数据", async () => {
  const originalRun = serverModule.scheduler.runImmediate;
  const originalMarket = market.getCampaignMarketAnalysis;
  serverModule.scheduler.runImmediate = async campaignId => {
    assert.equal(campaignId, "sample-campaign");
    return storage.saveSnapshot(campaignId, sampleSnapshot({ eligibleTradingVolume: 18000, topRankingTradingVolume: 15000 }));
  };
  market.getCampaignMarketAnalysis = async campaignId => ({ campaignId, status: "fixture", markets: [] });
  try {
    const { response, data } = await json("/api/scheduler/trigger", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: base, "X-EventLens-Token": token },
      body: "{}"
    });
    assert.equal(response.status, 200);
    assert.equal(data.rankingData.campaignId, "sample-campaign");
    assert.equal(data.marketData.campaignId, "sample-campaign");
  } finally {
    serverModule.scheduler.runImmediate = originalRun;
    market.getCampaignMarketAnalysis = originalMarket;
  }
});

test("无效 JSON 和过大请求体具有 400/413 语义", async () => {
  const headers = { "Content-Type": "application/json", Origin: base, "X-EventLens-Token": token };
  assert.equal((await json("/api/campaigns/delete", { method: "POST", headers, body: "{" })).response.status, 400);
  assert.equal((await json("/api/campaigns/delete", { method: "POST", headers, body: JSON.stringify({ id: "x", padding: "a".repeat(1_000_100) }) })).response.status, 413);
});

test("同源令牌可写成功快照并形成历史", async () => {
  const snapshot = sampleSnapshot({ collectedAt: "2026-09-12T03:00:00.000Z", eligibleTradingVolume: 18000, topRankingTradingVolume: 15000 });
  const { response } = await json("/api/ranking/update", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: base, "X-EventLens-Token": token },
    body: JSON.stringify({ campaignId: "sample-campaign", snapshot })
  });
  assert.equal(response.status, 200);
  const history = await json("/api/ranking/history?campaignId=sample-campaign&limit=10");
  assert.equal(history.data.entries.length, 1);
  assert.equal(history.data.entries[0].eligibleTradingVolume, 18000);
});

test("无效快照属于 400 客户端错误且不会覆盖成功数据", async () => {
  const { response } = await json("/api/ranking/update", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: base, "X-EventLens-Token": token },
    body: JSON.stringify({ campaignId: "sample-campaign", snapshot: { eligibleUserCount: -1 } })
  });
  assert.equal(response.status, 400);
  const ranking = await json("/api/binance/ranking?campaignId=sample-campaign");
  assert.equal(ranking.data.eligibleTradingVolume, 18000);
});

test("行情参数超出边界返回 400", async () => {
  const { response, data } = await json("/api/binance/market?campaignId=sample-campaign&rebateRate=2");
  assert.equal(response.status, 400);
  assert.match(data.error, /返佣比例/);
});

test("排行榜采集失败返回具体原因而不是笼统服务器内部错误", async () => {
  const original = serverModule.scheduler.runImmediate;
  serverModule.scheduler.runImmediate = async () => {
    const error = new Error("活动页面连续加载 3 次仍未返回排行榜数据，请稍后重试");
    error.statusCode = 502;
    throw error;
  };
  try {
    const { response, data } = await json("/api/scheduler/trigger", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: base, "X-EventLens-Token": token },
      body: JSON.stringify({ campaignId: "sample-campaign" })
    });
    assert.equal(response.status, 502);
    assert.match(data.error, /连续加载 3 次/);
    assert.doesNotMatch(data.error, /服务器内部错误/);
  } finally {
    serverModule.scheduler.runImmediate = original;
  }
});

test("未知 API 和不允许的方法具有正确语义", async () => {
  assert.equal((await json("/api/not-found")).response.status, 404);
  assert.equal((await json("/api/health", { method: "POST", headers: { Origin: base, "X-EventLens-Token": token } })).response.status, 405);
});
