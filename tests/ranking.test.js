const test = require("node:test");
const assert = require("node:assert/strict");
const { makeDataDir, sampleCampaign, sampleSnapshot } = require("./helpers");

process.env.EVENTLENS_DATA_DIR = makeDataDir();
const storage = require("../lib/storage");
const binanceApi = require("../lib/binance-api");
const { getCampaignRanking, computeRankingMetrics, rewardForAddedVolume } = require("../lib/ranking");

const originalTicker = binanceApi.getTickerPrice;
test.afterEach(() => { binanceApi.getTickerPrice = originalTicker; });

test("新增后段交易量会计入瓜分分母，避免静态份额高估", () => {
  const result = rewardForAddedVolume(80, 30000, 10000, null);
  assert.equal(result.uncapped, 20);
  assert.equal(rewardForAddedVolume(80, 0, 1000, null).uncapped, 80);
});

test("后段人数和交易量为 0 时不显示零美元封顶量", () => {
  const result = computeRankingMetrics(sampleCampaign({ otherReward: { pool: 80, token: "BNB", capPerUser: 0.05, cutoffRank: 1000 } }), {
    eligibleUserCount: 500,
    eligibleTradingVolume: 500000,
    topRankUserCount: 500,
    topRankingTradingVolume: 500000,
    otherEligibleUserCount: 0,
    otherEligibleTradingVolume: 0
  }, 700);
  assert.equal(result.rewardEstimateStatus, "no-tail-users");
  assert.equal(result.rewardPer1k, null);
  assert.equal(result.capReachedAtVolume, null);
});

test("快照按活动精确匹配并计算后段封顶奖励", async () => {
  binanceApi.getTickerPrice = async () => ({ price: 600 });
  const result = await getCampaignRanking("sample-campaign");
  assert.equal(result.dataStatus, "available");
  assert.equal(result.topRankUserCount, 3);
  assert.equal(result.otherEligibleTradingVolume, 3000);
  assert.equal(result.rewardPer1k, 0.05);
  assert.equal(result.rewardPer10k, null);
  assert.equal(result.rewardPer10kStatus, "ranked-volume");
  assert.equal(result.rewardPer1kCapApplied, true);
  assert.equal(result.capReachedAtVolume, 1.88);
  assert.equal(result.rewardPer10kUsdt, null);
  assert.equal(result.calculationBasis, "added-volume-included");
  assert.equal(result.tiers[0].thresholdVolumeUsd, 5000);
});

test("奖励币行情失败时保留排行榜但不生成假估值", async () => {
  binanceApi.getTickerPrice = async () => { throw new Error("offline"); };
  const result = await getCampaignRanking("sample-campaign");
  assert.equal(result.dataStatus, "available");
  assert.equal(result.rewardTokenPrice, null);
  assert.equal(result.rewardPer10kUsdt, null);
  assert.match(result.priceError, /offline/);
});

test("没有快照时前 N 人数为 0 而不是固定 1000", async () => {
  await storage.upsertCampaign(sampleCampaign({ id: "empty", articleCode: "empty-code", token: "EMPTY", landingUrl: "https://www.icnguxncf.com/activity/trading-competition/empty-wave-EMPTY-R1/Main-Reward" }));
  binanceApi.getTickerPrice = async () => ({ price: 600 });
  const result = await getCampaignRanking("empty");
  assert.equal(result.dataStatus, "unavailable");
  assert.equal(result.topRankUserCount, 0);
  assert.equal(result.eligibleUserCount, 0);
  assert.equal(result.rewardPer10k, null);
});

test("不存在或大小写不一致的活动返回明确错误", async () => {
  await assert.rejects(() => getCampaignRanking("definitely-missing"), /未找到活动/);
  await assert.rejects(() => getCampaignRanking("SAMPLE-CAMPAIGN"), /未找到活动/);
});

test("上游未提供源时间时，相同指标的重复抓取仍会去重", async () => {
  const campaign = sampleCampaign({ id: "no-source-time", articleCode: "no-source", token: "NST", landingUrl: "https://www.icnguxncf.com/activity/trading-competition/no-source-wave-NST-R1/Main-Reward" });
  await storage.upsertCampaign(campaign);
  const first = sampleSnapshot({ sourceUpdatedAt: null, rankingUpdatedAt: null, collectedAt: "2026-09-12T00:01:00.000Z" });
  const second = sampleSnapshot({ sourceUpdatedAt: null, rankingUpdatedAt: null, collectedAt: "2026-09-12T00:02:00.000Z" });
  await storage.saveSnapshot(campaign.id, first);
  await storage.saveSnapshot(campaign.id, second);
  assert.equal((await storage.getSnapshotHistory(campaign.id, 10)).length, 1);
});

test("历史只记录成功快照并按采集时间排序去重", async () => {
  await storage.saveSnapshot("sample-campaign", sampleSnapshot({ collectedAt: "2026-09-12T00:06:00.000Z", eligibleTradingVolume: 16000, topRankingTradingVolume: 13000 }));
  await storage.saveSnapshot("sample-campaign", sampleSnapshot({ collectedAt: "2026-09-12T00:07:00.000Z", eligibleTradingVolume: 17000, topRankingTradingVolume: 14000 }));
  await storage.saveSnapshot("sample-campaign", sampleSnapshot({ collectedAt: "2026-09-12T00:07:00.000Z", eligibleTradingVolume: 17000, topRankingTradingVolume: 14000 }));
  const history = await storage.getSnapshotHistory("sample-campaign", 10);
  assert.equal(history.length, 2);
  assert.equal(history[0].eligibleTradingVolume, 16000);
  assert.equal(history[1].eligibleTradingVolume, 17000);
});
