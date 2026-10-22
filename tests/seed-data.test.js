const test = require("node:test");
const assert = require("node:assert/strict");
const campaigns = require("../data/seed-campaigns.json");
const snapshots = require("../data/seed-snapshots.json");
const { normalizeSnapshot } = require("../lib/storage");
const { toMicros } = require("../lib/crawler");
const { computeRankingMetrics } = require("../lib/ranking");

test("发布样本快照完整、可定位到活动，逐名数据匿名且与汇总一致", () => {
  assert.equal(new Set(campaigns.map(c => c.id)).size, campaigns.length);
  for (const [id, snapshot] of Object.entries(snapshots)) {
    assert.ok(campaigns.some(c => c.id === id), id);
    const value = normalizeSnapshot(snapshot);
    assert.equal(value.integrity.actualRecords, value.eligibleUserCount);
    assert.equal(value.topRankUserCount + value.otherEligibleUserCount, value.eligibleUserCount);
    assert.equal(toMicros(value.topRankingTradingVolume) + toMicros(value.otherEligibleTradingVolume), toMicros(value.eligibleTradingVolume));
    assert.equal(value.rankEntries.length, Math.min(1000, value.eligibleUserCount));
    assert.ok(Number.isFinite(Date.parse(value.sourceUpdatedAt)));
    assert.ok(Date.parse(value.collectedAt) >= Date.parse(value.sourceUpdatedAt));
    assert.doesNotMatch(JSON.stringify(value), /userId|optInId|nickname|displayName|avatar|nextCursor/);
    for (const row of value.rankEntries) {
      assert.deepEqual(Object.keys(row).sort(), ["position", "rank", "rewardAmbiguous", "tied", "volume"]);
    }
  }
});

test("THE、SAHARA 样本补齐两轮独立奖励，不将其并入主榜计算", () => {
  for (const id of ["spot-altcoin-festival-wave-THE-R1", "spot-altcoin-festival-wave-SAHARA-R2"]) {
    const campaign = campaigns.find(c => c.id === id);
    assert.equal(campaign.bonusRewards.length, 1);
    const bonus = campaign.bonusRewards[0];
    assert.equal(bonus.roundCount, 2);
    assert.equal(bonus.totalReward, 80);
    assert.equal(bonus.rewardToken, "BNB");
    assert.equal(bonus.details.reduce((sum, row) => sum + row.rewardsPerRound.reduce((a, b) => a + b, 0), 0), 80);
    const snapshot = snapshots[id] || snapshots["spot-altcoin-festival-wave-THE-R1"];
    assert.deepEqual(computeRankingMetrics(campaign, snapshot, 700),
      computeRankingMetrics({ ...campaign, bonusRewards: [] }, snapshot, 700));
  }
});
