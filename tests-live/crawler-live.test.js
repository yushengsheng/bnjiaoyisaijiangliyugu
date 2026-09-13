const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "eventlens-live-"));
fs.writeFileSync(path.join(dataDir, "campaigns.json"), fs.readFileSync(path.join(__dirname, "../data/seed-campaigns.json")));
fs.writeFileSync(path.join(dataDir, "snapshots.json"), "{}\n");
fs.writeFileSync(path.join(dataDir, "snapshot-history.json"), "{}\n");
process.env.EVENTLENS_DATA_DIR = dataDir;

const storage = require("../lib/storage");
const { crawlLeaderboard, toMicros } = require("../lib/crawler");
const { getCampaignMarketAnalysis } = require("../lib/market");

const campaignId = "spot-altcoin-festival-wave-THE-R1";

test("真实币安 THE 盘口可用且买一不高于卖一", { timeout: 30_000 }, async () => {
  const result = await getCampaignMarketAnalysis(campaignId, { feeRate: 0.00075, rebateRate: 0.485 });
  assert.ok(result.markets.length >= 1);
  for (const market of result.markets) {
    assert.ok(market.bidPrice > 0);
    assert.ok(market.askPrice >= market.bidPrice);
    assert.ok(market.totalCostPer10k >= 0);
  }
});

test("真实 THE 主榜完成全部分页与精确拆分", { timeout: 240_000 }, async t => {
  const campaign = await storage.getCampaignById(campaignId);
  const snapshot = await crawlLeaderboard(campaign, (percent, text) => t.diagnostic(`${percent}% ${text}`));
  assert.equal(snapshot.integrity.complete, true);
  assert.equal(snapshot.integrity.expectedRecords, snapshot.integrity.actualRecords);
  assert.ok(snapshot.eligibleUserCount >= 1000);
  assert.equal(toMicros(snapshot.topRankingTradingVolume) + toMicros(snapshot.otherEligibleTradingVolume), toMicros(snapshot.eligibleTradingVolume));
  assert.ok(snapshot.resourceId > 0);
  t.diagnostic(JSON.stringify({
    resourceId: snapshot.resourceId,
    users: snapshot.eligibleUserCount,
    total: snapshot.eligibleTradingVolume,
    top: snapshot.topRankingTradingVolume,
    tail: snapshot.otherEligibleTradingVolume,
    cutoff: snapshot.cutoff1000Volume,
    sourceUpdatedAt: snapshot.sourceUpdatedAt,
    collectedAt: snapshot.collectedAt
  }));
});
