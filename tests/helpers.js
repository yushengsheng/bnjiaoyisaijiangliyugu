const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function sampleCampaign(overrides = {}) {
  return {
    id: "sample-campaign",
    name: "Sample 交易锦标赛",
    market: "现货",
    token: "SAMPLE",
    rewardToken: "BNB",
    rewardPool: "400 BNB",
    rewardPoolAmount: 400,
    period: "09/10 至 09/17",
    startTime: "2026-09-10T10:00:00.000Z",
    endTime: "2099-09-17T10:00:00.000Z",
    status: "active",
    articleCode: "9914db97181f443a9fc3a3e3ef726996",
    landingUrl: "https://www.icnguxncf.com/activity/trading-competition/spot-altcoin-festival-wave-SAMPLE-R1/Main-Reward",
    pairs: ["SAMPLE/USDT", "SAMPLE/USDC"],
    minVolumeUsd: 500,
    tiers: [
      { name: "第 1 名", rankFrom: 1, rankTo: 1, cutoffRank: 1, rewardPerUser: 12, rewardToken: "BNB", userCount: 1 },
      { name: "第 2–3 名", rankFrom: 2, rankTo: 3, cutoffRank: 3, rewardPerUser: 4, rewardToken: "BNB", userCount: 2 }
    ],
    otherReward: { pool: 80, token: "BNB", capPerUser: 0.05, cutoffRank: 3 },
    cutoffLabel: "第 3 名门槛",
    needsReview: false,
    ...overrides
  };
}

function sampleSnapshot(overrides = {}) {
  return {
    resourceId: 123456789,
    sourceUpdatedAt: "2026-09-12T00:00:00.000Z",
    collectedAt: "2026-09-12T00:05:00.000Z",
    eligibleUserCount: 5,
    eligibleTradingVolume: 15000,
    topRankUserCount: 3,
    topRankingTradingVolume: 12000,
    otherEligibleUserCount: 2,
    otherEligibleTradingVolume: 3000,
    cutoff1000Volume: 3000,
    tierThresholds: { 1: 5000, 3: 3000 },
    integrity: { complete: true, expectedRecords: 5, actualRecords: 5 },
    ...overrides
  };
}

function makeDataDir({ campaigns = [sampleCampaign()], snapshots = { "sample-campaign": sampleSnapshot() }, history = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eventlens-test-"));
  fs.writeFileSync(path.join(dir, "campaigns.json"), `${JSON.stringify(campaigns, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, "snapshots.json"), `${JSON.stringify(snapshots, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, "snapshot-history.json"), `${JSON.stringify(history, null, 2)}\n`);
  return dir;
}

function mockPage(start, count, total, options = {}) {
  return {
    code: "000000",
    data: {
      eligibleTradingVolume: options.reportedVolume ?? null,
      updateTime: options.updateTime ?? null,
      resourceSummaryList: {
        total,
        pageIndex: options.pageIndex || 1,
        pageSize: count,
        data: Array.from({ length: count }, (_, index) => {
          const position = start + index;
          return {
            resourceId: options.resourceId || 123,
            sequence: options.sequences?.[index] ?? position,
            grade: options.volumes?.[index] ?? (10000 - position * 100),
            userId: `user-${position}`,
            optInId: `opt-${position}`
          };
        })
      }
    }
  };
}

module.exports = { sampleCampaign, sampleSnapshot, makeDataDir, mockPage };
