const test = require("node:test");
const assert = require("node:assert/strict");
const { buildExactSnapshot, parseVolume, toMicros, findSourceUpdatedAt, PAGE_LOAD_ATTEMPTS, getRequestedSubTrack, findConfiguredResourceId, extractEligiblePairsFromPageText, campaignPatchFromSnapshot, findCampaignForImmediate } = require("../lib/crawler");
const { mockPage } = require("./helpers");

test("优先输入域名，备用主机不改变活动与子赛道，也不重复抓同一URL", () => {
  const { getLeaderboardUrls } = require("../lib/crawler");
  const pathname = "/zh-CN/activity/trading-competition/202609tradersleague4/Spot-Carnival-Waves-Round2";
  assert.deepEqual(getLeaderboardUrls(`https://www.cagxfucoftt.com${pathname}?utm_source=test`), [
    `https://www.cagxfucoftt.com${pathname}`, `https://www.binance.com${pathname}`, `https://www.icnguxncf.com${pathname}`
  ]);
  assert.deepEqual(getLeaderboardUrls(`https://www.icnguxncf.com${pathname}`), [
    `https://www.icnguxncf.com${pathname}`, `https://www.binance.com${pathname}`
  ]);
});

test("活动页在放弃前会自动加载或刷新三次", () => {
  assert.equal(PAGE_LOAD_ATTEMPTS, 3);
});

test("交易者联赛子赛道可从页面配置精确绑定 Resource ID", () => {
  const url = "https://www.icnguxncf.com/zh-CN/activity/trading-competition/202609tradersleague4/Spot-Carnival-Waves-Round1";
  assert.equal(getRequestedSubTrack(url), "Spot-Carnival-Waves-Round1");
  const appData = {
    activities: [
      { id: 100022565, type: "TRADING_COMPETITION_ACTIVITY", globalContent: { uri: "/Spot-Sprint Reward" } },
      { id: 100022561, type: "TRADING_COMPETITION_ACTIVITY", globalContent: { uri: "/Spot-Carnival-Waves-Round1" } }
    ]
  };
  assert.equal(findConfiguredResourceId(appData, "Spot-Carnival-Waves-Round1"), 100022561);
  assert.equal(findConfiguredResourceId(appData, "unknown"), null);
  const pageText = `符合条件的交易对\n交易对：XRP/USDT、SOL/USDT、A/USDT、LINEA/USDT\n参与者在以下指定交易对产生的交易量按 1.2 倍统计`;
  assert.deepEqual(extractEligiblePairsFromPageText(pageText), ["XRP/USDT", "SOL/USDT", "A/USDT", "LINEA/USDT"]);
  assert.deepEqual(campaignPatchFromSnapshot({ resourceId: null, pairs: ["A/USDT"] }, { resourceId: 100022561, eligiblePairs: ["XRP/USDT", "A/USDT"] }), {
    resourceId: 100022561,
    pairs: ["XRP/USDT", "A/USDT"]
  });
  assert.deepEqual(campaignPatchFromSnapshot({ resourceId: null, pairs: ["XRP/USDT", "A/USDT"] }, { resourceId: 100022561, eligiblePairs: ["A/USDT"] }), {
    resourceId: 100022561
  });
});

test("指定活动页倍率覆盖公告旧倍率，同时保留其他币对且拒绝缩减集合", () => {
  const campaign = { pairs: ["A/USDT", "HUMA/USDT"], pairMultipliers: { "A/USDT": 1.2, "HUMA/USDT": 1.2 } };
  assert.deepEqual(campaignPatchFromSnapshot(campaign, {
    eligiblePairs: ["BTC/USDT", "A/USDT", "HUMA/USDT"],
    eligiblePairMultipliers: { "BTC/USDT": 1, "A/USDT": 1.2, "HUMA/USDT": 1.5, "WRONG/USDT": 5 }
  }), { pairs: ["BTC/USDT", "A/USDT", "HUMA/USDT"], pairMultipliers: { "BTC/USDT": 1, "A/USDT": 1.2, "HUMA/USDT": 1.5 } });
  assert.deepEqual(campaignPatchFromSnapshot(campaign, { eligiblePairs: ["A/USDT"], eligiblePairMultipliers: { "A/USDT": 1.5 } }), {});
});

test("手动调度只按活动 ID 精确匹配", () => {
  const campaigns = [{ id: "Round-A", status: "active" }, { id: "round-a", status: "active" }];
  assert.equal(findCampaignForImmediate(campaigns, "Round-A").id, "Round-A");
  assert.equal(findCampaignForImmediate(campaigns, "ROUND-A"), null);
  assert.equal(findCampaignForImmediate(campaigns).id, "Round-A");
});

test("数量后缀 K/M/B/万/亿 均按实际数量级解析", () => {
  assert.equal(parseVolume("$637.06M"), 637_060_000);
  assert.equal(parseVolume("1.2B"), 1_200_000_000);
  assert.equal(parseVolume("3万"), 30_000);
  assert.equal(parseVolume("2.5亿"), 250_000_000);
  assert.equal(toMicros("0.123456"), 123456n);
});

test("完整分页按原始顺序精确求和并拆分", () => {
  const pages = [
    mockPage(1, 3, 5, { volumes: [5000.123456, 4000.2, 3000], updateTime: 1789171200000 }),
    mockPage(4, 2, 5, { volumes: [2000.5, 1000.1], pageIndex: 2 })
  ];
  const result = buildExactSnapshot({ resourceId: 123, pages, cutoffRank: 3, tierCutoffs: [1, 3], collectedAt: "2026-09-12T01:00:00.000Z" });
  assert.equal(result.eligibleUserCount, 5);
  assert.equal(result.eligibleTradingVolume, 15000.923456);
  assert.equal(result.topRankingTradingVolume, 12000.323456);
  assert.equal(result.otherEligibleTradingVolume, 3000.6);
  assert.equal(result.cutoff1000Volume, 3000);
  assert.equal(result.tierThresholds[1], 5000.123456);
  assert.equal(result.sourceUpdatedAt, "2026-09-12T00:00:00.000Z");
  assert.equal(result.integrity.complete, true);
});

test("记录数不足时拒绝保存估算结果", () => {
  const pages = [mockPage(1, 3, 5, { volumes: [5, 4, 3] })];
  assert.throws(() => buildExactSnapshot({ resourceId: 123, pages, cutoffRank: 3 }), /排行榜缺失/);
});

test("分页重复参与者会被完整性校验拒绝", () => {
  const first = mockPage(1, 2, 4, { volumes: [5, 4] });
  const second = mockPage(1, 2, 4, { volumes: [3, 2], pageIndex: 2 });
  assert.throws(() => buildExactSnapshot({ resourceId: 123, pages: [first, second], cutoffRank: 2 }), /重复参与者/);
});

test("乱序排名和无效交易量会指出具体页行，同时允许并列名次", () => {
  const tiedRanks = mockPage(1, 3, 3, { volumes: [5, 4, 4], sequences: [1, 2, 2] });
  const tied = buildExactSnapshot({ resourceId: 123, pages: [tiedRanks], cutoffRank: 2 });
  assert.equal(tied.eligibleUserCount, 3);
  assert.equal(tied.cutoffTied, true);
  const wrongRank = mockPage(1, 3, 3, { volumes: [5, 4, 3], sequences: [1, 3, 2] });
  assert.throws(() => buildExactSnapshot({ resourceId: 123, pages: [wrongRank], cutoffRank: 1 }), /排名顺序异常：第 1 页第 3 行/);
  const invalidVolume = mockPage(1, 2, 2, { volumes: [5, "not-a-volume"] });
  assert.throws(() => buildExactSnapshot({ resourceId: 123, pages: [invalidVolume], cutoffRank: 1 }), /交易量无效：第 1 页第 2 行/);
});

test("缺少稳定用户标识或跨页源时间变化时拒绝生成完整快照", () => {
  const noIdentity = mockPage(1, 1, 1, { volumes: [500] });
  delete noIdentity.data.resourceSummaryList.data[0].userId;
  delete noIdentity.data.resourceSummaryList.data[0].optInId;
  assert.throws(() => buildExactSnapshot({ resourceId: 123, pages: [noIdentity] }), /参与者标识/);
  const pages = [
    mockPage(1, 1, 2, { volumes: [600], updateTime: 1789171200000 }),
    mockPage(2, 1, 2, { volumes: [500], updateTime: 1789171260000 })
  ];
  assert.throws(() => buildExactSnapshot({ resourceId: 123, pages }), /源时间不一致/);
});

test("官方聚合总量允许一美分工程误差，超过后仍拒绝保存", () => {
  const accepted = mockPage(1, 2, 2, { volumes: [5, 4], reportedVolume: 9.01 });
  assert.equal(buildExactSnapshot({ resourceId: 123, pages: [accepted], cutoffRank: 1 }).reportedVolumeDifference, 0.01);
  const rejected = mockPage(1, 2, 2, { volumes: [5, 4], reportedVolume: 9.010001 });
  assert.throws(() => buildExactSnapshot({ resourceId: 123, pages: [rejected], cutoffRank: 1 }), /官方总量与逐条求和不一致/);
});

test("分页总人数或 Resource ID 不一致会被拒绝", () => {
  const first = mockPage(1, 2, 4, { volumes: [5, 4] });
  const wrongTotal = mockPage(3, 2, 5, { volumes: [3, 2], pageIndex: 2 });
  assert.throws(() => buildExactSnapshot({ resourceId: 123, pages: [first, wrongTotal], cutoffRank: 2 }), /分页总人数不一致/);
  const wrongResource = mockPage(3, 2, 4, { volumes: [3, 2], pageIndex: 2, resourceId: 999 });
  assert.throws(() => buildExactSnapshot({ resourceId: 123, pages: [first, wrongResource], cutoffRank: 2 }), /Resource ID 不匹配/);
});

test("参与人数小于门槛时后段为 0 且门槛显示不可用", () => {
  const result = buildExactSnapshot({ resourceId: 123, pages: [mockPage(1, 2, 2, { volumes: [5, 4] })], cutoffRank: 1000 });
  assert.equal(result.topRankUserCount, 2);
  assert.equal(result.otherEligibleUserCount, 0);
  assert.equal(result.otherEligibleTradingVolume, 0);
  assert.equal(result.cutoff1000Volume, null);
});

test("分界为零时所有上榜量属于后段，不被默认1000覆盖", () => {
  const result = buildExactSnapshot({ resourceId: 123, pages: [mockPage(1, 2, 2, { volumes: [600, 500] })], cutoffRank: 0 });
  assert.equal(result.topRankUserCount, 0);
  assert.equal(result.otherEligibleTradingVolume, 1100);
});

test("源更新时间只来自上游元数据，不读取参与者记录或采集时间", () => {
  assert.equal(findSourceUpdatedAt({ data: { updatedTime: 1789257534000 } }), new Date(1789257534000).toISOString());
  assert.equal(findSourceUpdatedAt({ data: { updateTime: "2026-09-12T02:00:00Z" } }), "2026-09-12T02:00:00.000Z");
  assert.equal(findSourceUpdatedAt({ data: { resourceSummaryList: { data: [{ updatedAt: "2020-01-01T00:00:00Z" }] } } }), null);
  assert.equal(findSourceUpdatedAt({ data: { unrelated: 123 } }), null);
  const snapshot = buildExactSnapshot({ resourceId: 123, pages: [mockPage(1, 2, 2, { volumes: [5, 4] })], cutoffRank: 1, collectedAt: "2026-09-12T03:00:00.000Z" });
  assert.equal(snapshot.sourceUpdatedAt, null);
  assert.equal(snapshot.rankingUpdatedAt, null);
  assert.equal(snapshot.collectedAt, "2026-09-12T03:00:00.000Z");
});
