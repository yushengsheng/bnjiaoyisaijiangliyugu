const test = require("node:test");
const assert = require("node:assert/strict");
const { makeDataDir, sampleCampaign } = require("./helpers");

const campaign = sampleCampaign({
  id: "the-audit",
  token: "THE",
  pairs: ["THE/USDT", "THE/USDC"],
  landingUrl: "https://www.icnguxncf.com/activity/trading-competition/spot-altcoin-festival-wave-THE-R1/Main-Reward",
  otherReward: { pool: 80, token: "BNB", capPerUser: 0.05, cutoffRank: 1000 }
});
const snapshot = {
  resourceId: 100023944,
  sourceUpdatedAt: null,
  collectedAt: "2026-09-12T00:00:00.000Z",
  eligibleUserCount: 3079,
  eligibleTradingVolume: 172842954.2793,
  topRankUserCount: 1000,
  topRankingTradingVolume: 171755709.91858,
  otherEligibleUserCount: 2079,
  otherEligibleTradingVolume: 1087244.36072,
  cutoff1000Volume: 702.88829,
  tierThresholds: { 1: 1000000, 1000: 702.88829 },
  integrity: { complete: true, expectedRecords: 3079, actualRecords: 3079 }
};
process.env.EVENTLENS_DATA_DIR = makeDataDir({ campaigns: [campaign], snapshots: { "the-audit": snapshot } });
const storage = require("../lib/storage");
const binanceApi = require("../lib/binance-api");
const { getCampaignRanking, computeRankingMetrics } = require("../lib/ranking");

const originalTicker = binanceApi.getTickerPrice;
test.after(() => { binanceApi.getTickerPrice = originalTicker; });

test("THE 在线审计基准的总量拆分保持微美元精度", () => {
  const toMicros = value => BigInt(Math.round(value * 1e6));
  assert.equal(toMicros(snapshot.topRankingTradingVolume) + toMicros(snapshot.otherEligibleTradingVolume), toMicros(snapshot.eligibleTradingVolume));
  assert.equal(snapshot.eligibleUserCount, snapshot.topRankUserCount + snapshot.otherEligibleUserCount);
});

test("THE 每千 U 和每万 U 奖励均应用 0.05 BNB 上限", async () => {
  binanceApi.getTickerPrice = async () => ({ price: 734.61 });
  const result = await getCampaignRanking("the-audit");
  assert.equal(result.rewardPer1k, 0.05);
  assert.equal(result.rewardPer10k, 0.05);
  assert.equal(result.rewardPer10kUsdt, 36.73);
  assert.equal(result.capReachedAtVolume, 679.95);
});

test("奖励美元估值使用常规金融四舍五入", () => {
  const holoCampaign = { ...campaign, otherReward: { pool: 80, token: "BNB", capPerUser: 0.05, cutoffRank: 1000 } };
  const holoSnapshot = { ...snapshot, otherEligibleTradingVolume: 2719268.97837 };
  const result = computeRankingMetrics(holoCampaign, holoSnapshot, 735.5);
  assert.equal(result.rewardPer10k, 0.05);
  assert.equal(result.rewardPer10kUsdt, 36.78);
});

test("失败检查只记录错误，不覆盖最后成功快照", async () => {
  await storage.markSnapshotCheck("the-audit", "fixture network failure");
  const current = await storage.getSnapshot("the-audit");
  assert.equal(current.eligibleTradingVolume, 172842954.2793);
  assert.match(current.lastCheckError, /fixture network failure/);
  assert.ok(current.lastCheckAt);
});
