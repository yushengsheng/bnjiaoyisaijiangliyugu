const test = require("node:test");
const assert = require("node:assert/strict");
const api = require("../lib/binance-api");

const originalFetch = global.fetch;
test.afterEach(() => { global.fetch = originalFetch; });

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
