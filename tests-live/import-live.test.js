const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "eventlens-import-live-"));
fs.writeFileSync(path.join(dataDir, "campaigns.json"), "[]\n");
fs.writeFileSync(path.join(dataDir, "snapshots.json"), "{}\n");
process.env.EVENTLENS_DATA_DIR = dataDir;

const storage = require("../lib/storage");
const { createCampaignFromLeaderboardUrl } = require("../lib/parser");
const { crawlLeaderboard } = require("../lib/crawler");
const { getCampaignRanking } = require("../lib/ranking");

for (const id of ["spot-altcoin-festival-wave-REZ-R1", "spot-altcoin-trading-festival-wave-R8"]) {
test(`${id} 新镜像活动链接可匹配官方规则、完整抓榜并计算`, { timeout: 360_000 }, async t => {
  const input = `https://www.cagxfucoftt.com/activity/trading-competition/${id}/Main-Reward`;
  const campaign = await createCampaignFromLeaderboardUrl(input);
  assert.equal(campaign.landingUrl, input);
  assert.equal(campaign.id, id);
  assert.equal(campaign.needsReview, false, JSON.stringify(campaign.reviewReasons));
  if (id.endsWith("REZ-R1")) assert.ok(campaign.pairs.includes("REZ/USDT"));
  else {
    assert.equal(campaign.articleCode, "f7a7a6dabac24c32bf71cd94e3626ba1");
    assert.equal(campaign.token, "MULTI");
    assert.equal(campaign.rewardPoolAmount, 300000);
    assert.equal(campaign.endTime, "2026-09-09T10:00:00.000Z");
    assert.equal(campaign.otherReward.pool, 60000);
    assert.equal(campaign.otherReward.capPerUser, 50);
  }
  assert.ok(campaign.otherReward.pool > 0);
  await storage.upsertCampaign(campaign);
  let usedFallback = false;
  const snapshot = await crawlLeaderboard(campaign, (percent, message) => {
    if (/备用/.test(message)) usedFallback = true;
    t.diagnostic(`${percent}% ${message}`);
  });
  assert.equal(snapshot.integrity.complete, true);
  assert.equal(snapshot.integrity.expectedRecords, snapshot.integrity.actualRecords);
  await storage.saveSnapshot(campaign.id, snapshot);
  const ranking = await getCampaignRanking(campaign.id);
  assert.equal(ranking.dataStatus, "available");
  assert.equal(ranking.otherRewardToken, campaign.otherReward.token);
  assert.equal((await storage.getCampaignById(campaign.id)).landingUrl, input);
  t.diagnostic(JSON.stringify({ id: campaign.id, usedFallback, resourceId: snapshot.resourceId,
    records: snapshot.eligibleUserCount, distribution: ranking.distribution,
    rewardPer1k: ranking.rewardPer1k, rewardPer10k: ranking.rewardPer10k }));
});
}
