const test = require("node:test");
const assert = require("node:assert/strict");
const { makeDataDir } = require("./helpers");

process.env.EVENTLENS_DATA_DIR = makeDataDir();
const binanceApi = require("../lib/binance-api");
const { calculatePairCost, getCampaignMarketAnalysis } = require("../lib/market");

const originalBooks = binanceApi.getBookTickers;
const originalTicker = binanceApi.getTickerPrice;

test.afterEach(() => {
  binanceApi.getBookTickers = originalBooks;
  binanceApi.getTickerPrice = originalTicker;
});

test("买卖价差模型只计算买一卖一价差和手续费", () => {
  const result = calculatePairCost({ symbol: "TESTUSDT", bidPrice: 1, askPrice: 1.002 }, { feeRate: 0.001, rebateRate: 0.5 });
  assert.ok(Math.abs(result.spread - 0.002) < 1e-12);
  assert.ok(Math.abs(result.spreadPercent - 0.1998001998) < 1e-8);
  assert.equal(result.feeCostPer1000, 0.5);
  assert.ok(Math.abs(result.spreadLossPer1000 - 0.999000999) < 1e-8);
  assert.ok(Math.abs(result.totalCostPer10k - 14.99000999) < 1e-8);
});

test("活动交易量按 1.2 倍计入时，成本按所需实际交易量折算", () => {
  const regular = calculatePairCost({ symbol: "TESTUSDT", bidPrice: 1, askPrice: 1.002 }, { feeRate: 0.001, rebateRate: 0.5 });
  const boosted = calculatePairCost({ symbol: "TESTUSDT", bidPrice: 1, askPrice: 1.002 }, { feeRate: 0.001, rebateRate: 0.5, volumeMultiplier: 1.2 });
  assert.equal(boosted.volumeMultiplier, 1.2);
  assert.ok(Math.abs(boosted.totalCostPer10k - regular.totalCostPer10k / 1.2) < 1e-10);
});

test("费率和返佣比例超出范围会被拒绝", () => {
  assert.throws(() => calculatePairCost({ symbol: "XUSDT", bidPrice: 1, askPrice: 1.1 }, { feeRate: -0.1, rebateRate: 0 }), /基础费率/);
  assert.throws(() => calculatePairCost({ symbol: "XUSDT", bidPrice: 1, askPrice: 1.1 }, { feeRate: 0.001, rebateRate: 2 }), /返佣比例/);
});

test("盘口失败不会制造 1.0000/1.0002 假数据", async () => {
  binanceApi.getTickerPrice = async () => ({ price: 2 });
  binanceApi.getBookTickers = async () => [
    { ok: true, symbol: "SAMPLEUSDT", data: { symbol: "SAMPLEUSDT", bidPrice: 1.99, askPrice: 2.01 } },
    { ok: false, symbol: "SAMPLEUSDC", error: "pair unavailable" }
  ];
  const result = await getCampaignMarketAnalysis("sample-campaign", { feeRate: 0.00075, rebateRate: 0.485 });
  assert.equal(result.status, "partial");
  assert.equal(result.markets.length, 1);
  assert.equal(result.unavailableMarkets.length, 1);
  assert.equal(result.unavailableMarkets[0].pair, "SAMPLE/USDC");
});

test("所有币对失败时返回 unavailable 而不是假盘口", async () => {
  binanceApi.getTickerPrice = async () => ({ price: 2 });
  binanceApi.getBookTickers = async symbols => symbols.map(symbol => ({ ok: false, symbol, error: "offline" }));
  const result = await getCampaignMarketAnalysis("sample-campaign");
  assert.equal(result.status, "unavailable");
  assert.equal(result.source, null);
  assert.equal(result.markets.length, 0);
  assert.equal(result.unavailableMarkets.length, 2);
});
