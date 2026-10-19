const test = require("node:test");
const assert = require("node:assert/strict");
const api = require("../lib/binance-api");
const navigation = require("../lib/binance-navigation");

const originalFetch = global.fetch;
const originalNavigation = navigation.requestJson;
test.afterEach(() => { global.fetch = originalFetch; navigation.requestJson = originalNavigation; });

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

test("交易对符号必须是有限长度的大写字母数字", () => {
  assert.equal(api.cleanSymbol("the/usdt"), "THEUSDT");
  assert.throws(() => api.cleanSymbol("../../etc/passwd"), /无效交易对/);
  assert.throws(() => api.cleanSymbol("A".repeat(31)), /无效交易对/);
});

test("无效价格响应会报错而不是回退 716.05 或 1.0", async () => {
  global.fetch = async () => jsonResponse({ symbol: "BADUSDT", price: "not-a-price" });
  await assert.rejects(() => api.getTickerPrice("BADUSDT"), /价格响应无效/);
});

test("无效盘口会报错而不是生成固定买卖价", async () => {
  global.fetch = async () => jsonResponse({ symbol: "THEUSDT", bidPrice: "1", askPrice: "0.9" });
  await assert.rejects(() => api.getBookTicker("THEUSDT"), /盘口数据无效/);
});

test("批量盘口优先使用单次 symbols 请求并保持输入顺序", async () => {
  let calls = 0;
  global.fetch = async url => {
    calls++;
    assert.match(String(url), /symbols=/);
    return jsonResponse([
      { symbol: "SOLUSDT", bidPrice: "100", askPrice: "101" },
      { symbol: "XRPUSDT", bidPrice: "1", askPrice: "1.01" }
    ]);
  };
  const result = await api.getBookTickers(["XRPUSDT", "SOLUSDT"]);
  assert.equal(calls, 1);
  assert.deepEqual(result.map(item => item.symbol), ["XRPUSDT", "SOLUSDT"]);
  assert.ok(result.every(item => item.ok));
});

test("批量盘口失败后以有限并发回退并保留每个交易对状态", async () => {
  global.fetch = async url => url.includes("THEUSDT")
    ? jsonResponse({ symbol: "THEUSDT", bidPrice: "0.5", askPrice: "0.6" })
    : jsonResponse({ code: -1121, msg: "Invalid symbol" }, 400);
  const result = await api.getBookTickers(["THEUSDT", "THEUSDC"]);
  assert.equal(result[0].ok, true);
  assert.equal(result[1].ok, false);
  assert.match(result[1].error, /HTTP 400/);
});

function freshApi() {
  delete require.cache[require.resolve("../lib/binance-api")];
  return require("../lib/binance-api");
}

test("公告列表和详情统一从 bsmkweb.cc 发起并允许 HTTP 重定向", async () => {
  const requests = [];
  const code = "a".repeat(32);
  const originalBases = process.env.BINANCE_CMS_BASES;
  process.env.BINANCE_CMS_BASES = "https://obsolete.example/cms";
  try {
    const announcements = freshApi();
    global.fetch = async (url, options) => {
      const parsed = new URL(url);
      requests.push(parsed);
      assert.equal(parsed.origin, "https://www.bsmkweb.cc");
      assert.equal(options.redirect, "follow");
      assert.equal(options.headers.Referer, navigation.LIST_URL);
      return jsonResponse({ code: "000000", data: parsed.pathname.includes("detail") ? { code, title: "测试公告" } : { articles: [{ code }] } });
    };
    assert.deepEqual(await announcements.getAnnouncementList(), [{ code }]);
    assert.equal((await announcements.getAnnouncementDetail(code)).code, code);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].searchParams.get("catalogId"), "93");
  } finally {
    if (originalBases === undefined) delete process.env.BINANCE_CMS_BASES;
    else process.env.BINANCE_CMS_BASES = originalBases;
  }
});

test("公告 HTML 导航使用浏览器跳转结果，缓存目标后读取详情，不回退固定镜像", async () => {
  const announcements = freshApi();
  const code = "b".repeat(32);
  const requests = [];
  let navigations = 0;
  global.fetch = async url => {
    const parsed = new URL(url);
    requests.push(parsed.hostname);
    if (parsed.hostname === "www.bsmkweb.cc") return new Response("<script>location.replace(...)</script>", { headers: { "Content-Type": "text/html" } });
    assert.equal(parsed.hostname, "current.example");
    return jsonResponse({ code: "000000", data: { code, title: "测试详情" } });
  };
  navigation.requestJson = async pathname => {
    navigations++;
    assert.match(pathname, /catalog\/list\/query/);
    return { origin: "https://current.example", data: { code: "000000", data: { articles: [{ code }] } } };
  };
  assert.deepEqual(await announcements.getAnnouncementList(), [{ code }]);
  assert.equal((await announcements.getAnnouncementDetail(code)).title, "测试详情");
  assert.equal(navigations, 1);
  assert.deepEqual([...new Set(requests)], ["www.bsmkweb.cc", "current.example"]);
});

test("公告导航失败明确报错，后续请求可以重新导航", async () => {
  const announcements = freshApi();
  global.fetch = async url => {
    assert.equal(new URL(url).hostname, "www.bsmkweb.cc");
    return new Response("Loading", { headers: { "Content-Type": "text/html" } });
  };
  navigation.requestJson = async () => { throw new Error("bsmkweb.cc 公告导航不可用"); };
  await assert.rejects(announcements.getAnnouncementList(), /公告导航不可用/);
  navigation.requestJson = async () => ({ origin: "https://current.example", data: { code: "000000", data: { articles: [] } } });
  assert.deepEqual(await announcements.getAnnouncementList(), []);
});
