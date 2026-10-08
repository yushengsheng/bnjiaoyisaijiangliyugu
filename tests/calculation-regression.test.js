const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { makeDataDir, sampleCampaign } = require("./helpers");

// Fixed HOLO audit observations, independent of the user's changing runtime data.
const campaign = sampleCampaign({
  id: "holo-regression", token: "HOLO", pairs: ["HOLO/USDT", "HOLO/USDC"],
  otherReward: { pool: 80, token: "BNB", capPerUser: 0.05, cutoffRank: 1000 },
  tiers: [
    { name: "第 1 名", rankFrom: 1, rankTo: 1, cutoffRank: 1, rewardPerUser: 12, rewardToken: "BNB" },
    { name: "第 201–1000 名", rankFrom: 201, rankTo: 1000, cutoffRank: 1000, rewardPerUser: 0.07, rewardToken: "BNB" }
  ],
  bonusRewards: [{ name: "分轮排名奖励", roundCount: 2, totalReward: 80, rewardToken: "BNB" }]
});
const snapshot = {
  eligibleUserCount: 5223, topRankUserCount: 1000,
  eligibleTradingVolume: 491441017.06763, topRankingTradingVolume: 483974298.17404,
  otherEligibleUserCount: 4223, otherEligibleTradingVolume: 7466718.89359,
  cutoff1000Volume: 21537.37146, tierThresholds: { 1: 66503285.5937, 1000: 21537.37146 },
  collectedAt: "2026-09-14T04:49:34.172Z", sourceUpdatedAt: "2026-09-14T02:59:59.000Z",
  integrity: { complete: true, expectedRecords: 5223, actualRecords: 5223 }
};
process.env.EVENTLENS_DATA_DIR = makeDataDir({ campaigns: [campaign], snapshots: { [campaign.id]: snapshot } });
const { computeRankingMetrics, getCampaignRanking } = require("../lib/ranking");
const { calculatePairCost } = require("../lib/market");
const storage = require("../lib/storage");
const binanceApi = require("../lib/binance-api");
const originalTicker = binanceApi.getTickerPrice;
test.afterEach(() => { binanceApi.getTickerPrice = originalTicker; });
const metrics = (c = campaign, s = snapshot) => computeRankingMetrics(c, s, 724.43);

test("联赛第二期重新解析后恢复已保存活动的奖励及净收益，保留原快照", async () => {
  const { parseAnnouncement } = require("../lib/parser");
  const corrected = parseAnnouncement(require("./fixtures/tradersleague-multi-track.json"), "Spot-Carnival-Waves-Round2");
  const leagueSnapshot = {
    eligibleUserCount: 11304, topRankUserCount: 1000,
    eligibleTradingVolume: 1501548359.474661, topRankingTradingVolume: 1398565544.665403,
    otherEligibleUserCount: 10304, otherEligibleTradingVolume: 102982814.809258,
    cutoff1000Volume: 127210.99515, tierThresholds: { 1000: 127210.99515 },
    integrity: { complete: true, expectedRecords: 11304, actualRecords: 11304 }
  };
  const old = { ...corrected, needsReview: true, reviewReasons: ["存在多个主奖池表，需核对目标赛道奖励规则"], pairs: ["BTC/USDT", ...corrected.pairs] };
  await storage.upsertCampaign(old);
  await storage.saveSnapshot(old.id, leagueSnapshot);
  const before = await storage.getSnapshot(old.id);
  assert.equal(computeRankingMetrics(old, before).rewardPer10kStatus, "rules-unverified");
  await storage.upsertCampaign(corrected);
  const saved = await storage.getCampaignById(old.id);
  assert.ok(saved.pairs.includes("BTC/USDT"));
  assert.deepEqual(await storage.getSnapshot(old.id), before);
  const data = computeRankingMetrics(saved, before, 782.875);
  assert.equal(data.rewardPer1kStatus, "available");
  assert.equal(data.rewardPer1k, 0.00116523);
  assert.equal(data.rewardPer10k, 0.0116513);
  const { ui, elements } = frontend();
  ui.state.currentCampaign = saved;
  ui.state.rankingData = data;
  ui.renderRankingAndRoi();
  assert.match(elements.rewardPer1kToken.textContent, /0\.00116523 BNB/);
  assert.match(elements.rewardPer10kToken.textContent, /0\.0116513 BNB/);
  assert.notEqual(elements.netProfitPer10k.textContent, "—");
});

test("HOLO 审计基准：拆分、封顶、美元估值与两币对成本", () => {
  const data = metrics();
  assert.equal(data.rewardPer1k, 0.01071278);
  assert.equal(data.rewardPer10k, 0.05);
  assert.equal(data.rewardPer1kUsdt, 7.7607);
  assert.equal(data.rewardPer10kUsdt, 36.22);
  assert.equal(data.rewardPer10kUsdtUnrounded, 36.2215);
  assert.equal(data.capReachedAtVolume, 4669.62);
  assert.equal(data.otherEligibleUserCount, 4223);
  assert.equal(data.otherEligibleTradingVolume, 7466718.89359);
  assert.equal(data.tiers[0].rewardUsdt, 8693.16);
  for (const [symbol, bid, ask, cost] of [["HOLOUSDT", 0.0618, 0.0619, "11.95"], ["HOLOUSDC", 0.0617, 0.0619, "20.04"]]) {
    const result = calculatePairCost({ symbol, bidPrice: bid, askPrice: ask });
    assert.equal(result.totalCostPer10k.toFixed(2), cost);
    assert.ok(Math.abs(result.feeCostPer1000 - 0.38625) < 1e-12);
  }
});

test("无上限的 null/undefined/空值保持无上限，显式零上限保持零", () => {
  for (const cap of [null, undefined, ""]) {
    const data = metrics({ ...campaign, otherReward: { ...campaign.otherReward, capPerUser: cap } });
    assert.equal(data.otherRewardCap, null);
    assert.equal(data.rewardPer10k, 0.10699881);
    assert.equal(data.rewardPer10kCapApplied, false);
    assert.equal(data.capReachedAtVolume, null);
  }
  assert.equal(metrics({ ...campaign, otherReward: { ...campaign.otherReward, capPerUser: 0 } }).rewardPer1k, 0);
});

test("旧配置的均分奖励优先从准确档位总额复算，不沿用四位小数误差", () => {
  const data = metrics({ ...campaign, tiers: [{ ...campaign.tiers[0], rewardPerUser: 2.6667, totalTierReward: 40, userCount: 15 }] });
  assert.equal(data.tiers[0].rewardPerUser, 2.66666667);
  assert.equal(data.tiers[0].rewardUsdt, 1931.81);
  const missing = metrics({ ...campaign, tiers: [{ ...campaign.tiers[0], rewardPerUser: null }] });
  assert.equal(missing.tiers[0].rewardPerUser, null);
  assert.equal(missing.tiers[0].rewardUsdt, null);
});

test("信任上榜资格，最低交易量字段不重复拦截统计和估算", () => {
  const data = metrics({ ...campaign, minVolumeUsd: 2000 });
  assert.equal(data.rewardPer1k, 0.01071278);
  assert.equal(data.eligibleUserCount, 5223);
});

test("THE/SPOT 及精确等于边界的量停止后段估算，保留阶梯", () => {
  for (const cutoff of [803.49908, 1020.89628, 1000, 10000]) {
    const data = metrics(campaign, { ...snapshot, cutoff1000Volume: cutoff });
    assert.equal(data.rewardPer10k, null);
    assert.equal(data.rewardPer10kUsdtUnrounded, null);
    assert.equal(data.rewardPer10kStatus, "ranked-volume");
    assert.equal(data.tiers[1].rewardPerUser, 0.07);
    if (cutoff <= 1000) assert.equal(data.rewardPer1kStatus, "ranked-volume");
    else assert.equal(data.rewardPer1kStatus, "available");
    if (cutoff <= 4669.62) assert.equal(data.capReachedAtVolume, null);
  }
});

test("未知边界、边界并列和待核对规则不会制造奖励", () => {
  const unknown = metrics(campaign, { ...snapshot, cutoff1000Volume: null, tierThresholds: {} });
  assert.equal(unknown.rewardPer1kStatus, "unknown-cutoff");
  assert.equal(unknown.rewardPer1k, null);
  assert.equal(metrics(campaign, { ...snapshot, cutoffTied: true }).rewardPer10kStatus, "rank-tie");
  assert.equal(metrics({ ...campaign, needsReview: true }).rewardPer10kStatus, "rules-unverified");
});

test("均分按新增一人处理，不随交易量增长；未知规则停止估算", () => {
  const data = metrics({ ...campaign, otherReward: { ...campaign.otherReward, distribution: "equal" } });
  assert.equal(data.rewardPer1k, 0.01893939);
  assert.equal(data.rewardPer10k, data.rewardPer1k);
  assert.equal(data.capReachedAtVolume, null);
  assert.equal(data.calculationBasis, "added-participant-included");
  assert.equal(metrics({ ...campaign, otherReward: { ...campaign.otherReward, distribution: "unknown" } }).rewardPer1kStatus, "unsupported-distribution");
});

test("混合奖励币各自取价，单币失败不污染其余估值", async () => {
  const mixed = { ...campaign, rewardPool: "400 USDT", rewardToken: "USDT", bonusRewards: [{ ...campaign.bonusRewards[0], rewardToken: "ETH" }],
    tiers: [{ ...campaign.tiers[0], rewardToken: "USDC" }, campaign.tiers[1]] };
  await storage.upsertCampaign(mixed);
  const requested = [];
  binanceApi.getTickerPrice = async symbol => {
    requested.push(symbol);
    if (symbol === "ETHUSDT") throw new Error("offline ETH");
    return { price: 724.43 };
  };
  const result = await getCampaignRanking(campaign.id);
  assert.deepEqual(requested.sort(), ["BNBUSDT", "ETHUSDT"]);
  assert.deepEqual(result.rewardPricesUsdt, { BNB: 724.43, USDT: 1, USDC: 1, ETH: null });
  assert.equal(result.tiers[0].rewardUsdt, 12);
  assert.equal(result.tiers[1].rewardUsdt, 50.71);
  assert.match(result.priceErrors.ETH, /offline/);
  assert.equal(result.rewardPer10kUsdt, 36.22);
});

function frontend() {
  const elements = {};
  let exported;
  const context = { Blob, setTimeout() {}, URL: { createObjectURL(blob) { exported = blob; return "blob:fixture"; }, revokeObjectURL() {} },
    document: { getElementById(id) { return elements[id] ||= { textContent: "", innerHTML: "", style: {} }; }, createElement() { return { click() {} }; } } };
  const original = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
  const source = original.replace("  init();\n})();", "  globalThis.audit = { state, renderSummaryCards, renderTiers, renderRankingAndRoi, renderHistory, exportAnalysisCsv, sparkline };\n})();");
  assert.notEqual(source, original);
  vm.runInNewContext(source, context);
  const ui = context.audit;
  ui.state.currentCampaign = campaign;
  ui.state.rankingData = metrics();
  ui.state.marketData = { status: "live", feeRate: 0.00075, rebateRate: 0.485,
    markets: [calculatePairCost({ symbol: "HOLOUSDT", bidPrice: 0.0618, askPrice: 0.0619 })] };
  return { ui, elements, exported: () => exported };
}

test("实际前端：缺失门槛与历史值显示未知，曲线不将 null 当零或连线", () => {
  const { ui, elements } = frontend();
  ui.state.rankingData = metrics(campaign, { ...snapshot, eligibleUserCount: 500, cutoff1000Volume: null, tierThresholds: {} });
  ui.state.historyData = [{ eligibleTradingVolume: 1, otherEligibleTradingVolume: 1, cutoff1000Volume: null }];
  ui.renderSummaryCards(); ui.renderTiers(); ui.renderHistory();
  assert.equal(elements.summaryCutoffVolume.textContent, "人数未达到门槛");
  assert.doesNotMatch(elements.tierGrid.innerHTML, /<strong>\$0/);
  assert.match(elements.tierGrid.innerHTML, /等待排行榜/);
  assert.match(elements.trendGrid.innerHTML, /\$—/);
  const chart = ui.sparkline([100, null, 200], "#fff");
  assert.equal((chart.match(/M/g) || []).length, 2);
  assert.doesNotMatch(chart, /L/);
});

test("实际前端：后段单人上限按奖励币价格换算，零和无上限均正确显示", () => {
  const { ui, elements } = frontend();
  ui.state.rankingData = null;
  ui.renderSummaryCards();
  assert.equal(elements.statTailCap.textContent, "0.05 BNB");
  assert.equal(elements.statTailCapUsdt.textContent, "奖励币价格不可用");
  ui.state.currentCampaign = { ...campaign, otherReward: { ...campaign.otherReward, capPerUser: 0 } };
  ui.renderSummaryCards();
  assert.equal(elements.statTailCap.textContent, "0 BNB");
  ui.state.currentCampaign = { ...campaign, otherReward: { ...campaign.otherReward, capPerUser: null } };
  ui.renderSummaryCards();
  assert.equal(elements.statTailCap.textContent, "未设置上限");
  assert.equal(elements.statTailCapUsdt.textContent, "");
  ui.state.rankingData = metrics();
  ui.renderSummaryCards();
  assert.equal(elements.statTailCap.textContent, "0.05 BNB");
  assert.equal(elements.statTailCapUsdt.textContent, "≈ 36.22 USDT");
  ui.state.rankingData.rewardPricesUsdt.BNB = null;
  ui.state.rankingData.rewardTokenPrice = null;
  ui.renderSummaryCards();
  assert.equal(elements.statTailCapUsdt.textContent, "奖励币价格不可用");
});

test("实际前端：混币总奖池及额外奖励按币种估值，未知价格不借用 BNB", () => {
  const { ui, elements } = frontend();
  ui.state.currentCampaign = { ...campaign, rewardPool: "400 USDT", rewardToken: "USDT" };
  ui.state.rankingData.rewardPricesUsdt.USDT = 1;
  ui.renderSummaryCards();
  assert.equal(elements.summaryRewardUsdt.textContent, "≈ $400 USDT");
  ui.state.rankingData.rewardPricesUsdt.USDT = null;
  ui.renderSummaryCards();
  assert.match(elements.summaryRewardUsdt.textContent, /不可用/);
  ui.state.currentCampaign = { ...campaign, bonusRewards: [{ ...campaign.bonusRewards[0], rewardToken: "USDC" }] };
  ui.state.rankingData.rewardPricesUsdt.USDC = 1;
  ui.renderTiers();
  assert.match(elements.tierGrid.innerHTML, /\$80\.00 USDT/);
});

test("实际前端：跨排名边界清空旧 ROI；CSV 包含状态、费率与独立奖励", async () => {
  const { ui, elements, exported } = frontend();
  ui.renderRankingAndRoi();
  assert.match(elements.netProfitPer10k.textContent, /24\.27/);
  ui.state.rankingData = metrics(campaign, { ...snapshot, cutoff1000Volume: 1020.89628 });
  ui.renderRankingAndRoi();
  assert.equal(elements.netProfitPer10k.textContent, "—");
  assert.match(elements.rewardPer10kUsdt.textContent, /阶梯奖励/);
  assert.match(elements.roiFormulaNote.textContent, /阶梯奖励/);
  ui.exportAnalysisCsv();
  const csv = await exported().text();
  assert.match(csv, /每10000U估算状态.*排名奖励门槛/);
  assert.match(csv, /基础费率.*0\.00075/);
  assert.match(csv, /返佣比例.*0\.485/);
  assert.match(csv, /独立分轮奖池/);
  assert.match(csv, /万U净收益\(USDT\).*N\/A/);
});

test("净收益先减未舍入奖励再显示，不因中间取整损失一美分", () => {
  const { ui, elements } = frontend();
  ui.state.marketData.markets[0].totalCostPer10k = 36.216;
  ui.renderRankingAndRoi();
  assert.match(elements.netProfitPer10k.textContent, /^\+\$0\.01/);
});
