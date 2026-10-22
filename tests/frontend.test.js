const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "public/index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "public/app.js"), "utf8");
const css = fs.readFileSync(path.join(root, "public/styles.css"), "utf8");

test("页面包含不可用状态、历史趋势、数据时间和自动更新开关", () => {
  for (const id of ["detailStatus", "trendGrid", "marketUpdatedTime", "rankingUpdateTime", "summaryPeriodDetail", "autoUpdateToggle"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
});

test("自动更新开关保存到后端并支持纯手动模式", () => {
  assert.match(app, /\/api\/scheduler\/config/);
  assert.match(app, /autoUpdateEnabled: requested/);
  assert.match(app, /自动更新已关闭，可手动更新/);
  assert.match(app, /state\.autoUpdateEnabled = Boolean\(data\.enabled\)/);
});

test("前端写请求使用本地会话令牌", () => {
  assert.match(app, /\/api\/session/);
  assert.match(app, /X-EventLens-Token/);
  assert.match(app, /state\.sessionToken/);
});

test("快速切换、手动刷新和抓榜完成均具有中止与请求版本保护", () => {
  assert.match(app, /AbortController/);
  assert.match(app, /loadCurrentCampaignDetails\(\{ force = false \}/);
  assert.match(app, /refreshCampaigns\(\{ force: true \}\)/);
  assert.match(app, /loadCurrentCampaignDetails\(\{ force \}\)/);
  assert.match(app, /const campaignId = state\.currentCampaign\.id/);
  assert.match(app, /crawlRequestId === state\.detailRequestId && campaignId === state\.currentCampaignId/);
  assert.match(app, /campaign\.id !== state\.currentCampaignId/);
});

test("服务重启后写请求只自动刷新一次会话令牌", () => {
  assert.match(app, /response\.status === 403/);
  assert.match(app, /allowSessionRetry/);
  assert.match(app, /return api\(path, options, false\)/);
});

test("动态 HTML 内容统一提供转义函数且没有旧总奖池五倍估值", () => {
  assert.match(app, /const escapeHtml/);
  assert.match(app, /escapeHtml\(item\.title\)/);
  assert.match(app, /escapeHtml\(item\.id\)/);
  assert.doesNotMatch(app, /otherReward\.pool\s*\*\s*5/);
});

test("抓榜失败会安全收起进度框且按钮说明符合固定调度语义", () => {
  assert.match(app, /clearTimeout\(state\.crawlProgressHideTimer\)/);
  assert.match(app, /crawlProgressHideTimer = setTimeout\(\(\) => box\.classList\.add\("hidden"\), 3500\)/);
  assert.match(html, /不改变全局自动检查时间/);
  assert.doesNotMatch(html, /抓取后重新开始 30 分钟/);
});

test("无后段数据时显示真实原因而不是误报奖励币价格不可用", () => {
  assert.match(app, /no-tail-users/);
  assert.match(app, /当前人数尚未进入后段/);
  assert.match(app, /ranking\.rewardPer1k === null \? unavailable1k/);
});

test("历史活动跳过详情行情轮询且部分盘口 ROI 明确标注范围", () => {
  assert.match(app, /state\.currentCampaign\?\.status !== "history"/);
  assert.match(app, /部分币对盘口不可用，仅比较当前可用币对/);
  assert.match(app, /data\.status === "partial"/);
});

test("奖励和成本统一使用榜单计入量口径且不宣称深度滑点", () => {
  assert.match(html, /每新增 1,000 U 榜单计入量预计奖励/);
  assert.match(app, /每实际成交 1,000 U 基准手续费/);
  assert.match(app, /万U榜单计入量/);
  assert.doesNotMatch(html, /每刷/);
  assert.doesNotMatch(html, />[^<]*滑点[^<]*</);
});

test("390px 断点对标题、操作区和面板执行纵向布局", () => {
  assert.match(css, /@media \(max-width: 640px\)/);
  assert.match(css, /\.section-heading \{ flex-direction: column/);
  assert.match(css, /\.ranking-actions \{ display: grid/);
  assert.match(css, /overflow-x: hidden/);
});

test("活动卡片保留完整官方标题，MULTI 不覆盖名称且动态内容安全转义", () => {
  const container = { innerHTML: "", querySelectorAll: () => [] };
  const context = { document: { getElementById: () => container } };
  const source = app.replace("  init();\n})();", "  globalThis.ui = { state, renderCampaignButtons };\n})();");
  assert.notEqual(source, app);
  vm.runInNewContext(source, context);
  const names = [
    "现货交易锦标赛：交易瓜分高达300,000 USDC奖池",
    "现货赛第一期：多币种奖励",
    "SAHARA交易锦标赛：交易瓜分高达400 BNB奖池"
  ];
  for (const tab of ["active", "history"]) {
    context.ui.state.currentTab = tab;
    context.ui.state.campaigns[tab] = names.map((name, index) => ({ id: String(index), name, token: "MULTI", status: tab }));
    context.ui.renderCampaignButtons();
    for (const name of names) assert.ok(container.innerHTML.includes(`<strong>${name}</strong>`));
  }
  context.ui.state.campaigns.history = [{ id: "<id>", name: '<img src=x onerror="bad">', token: "MULTI" }];
  context.ui.renderCampaignButtons();
  assert.ok(container.innerHTML.includes("&lt;img"));
  assert.ok(!container.innerHTML.includes("<img"));
});

function campaignUI(groups) {
  const elements = new Map();
  const getElement = id => {
    if (!elements.has(id)) {
      const classes = new Set(id === "campaignDetails" ? ["hidden"] : []);
      elements.set(id, {
        innerHTML: "", textContent: "", style: {}, querySelectorAll: () => [],
        classList: {
          add: value => classes.add(value), remove: value => classes.delete(value),
          contains: value => classes.has(value),
          toggle: (value, enabled) => enabled ? classes.add(value) : classes.delete(value)
        }
      });
    }
    return elements.get(id);
  };
  const saved = new Map();
  const location = { hash: "", pathname: "/", search: "" };
  let currentGroups = groups;
  const events = [];
  const context = {
    AbortController,
    CustomEvent,
    setTimeout: () => 0,
    clearTimeout: () => {},
    document: { getElementById: getElement, dispatchEvent: event => events.push(event) },
    location,
    history: { replaceState: (_, __, url) => { location.hash = url.startsWith("#") ? url : ""; } },
    localStorage: { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) },
    fetch: async url => ({
      ok: true,
      json: async () => url === "/api/campaigns" ? { groups: currentGroups }
        : { dataStatus: "unavailable", markets: [], entries: [], tiers: [] }
    })
  };
  const source = app.replace("  init();\n})();", "  globalThis.ui = { state, selectCampaign, switchCampaignTab, refreshCampaigns, loadCampaigns, loadCurrentCampaignDetails, renderRankings, renderRankList, rankEstimate, updateCostInput };\n})();");
  vm.runInNewContext(source, context);
  return { ...context.ui, element: getElement, location, saved, events, setGroups: next => { currentGroups = next; }, setFetch: next => { context.fetch = next; } };
}

test("神算子与交易赛共用首页分类，到期移入已过期且不触发交易赛详情或自动抓榜", async () => {
  const prophet = { id: "prophet:season", kind: "prophet", name: "神算子", status: "active" };
  const ended = { id: "ended-trade", name: "过期交易赛", status: "history" };
  let groups = { active: [prophet], history: [ended] };
  const ui = campaignUI(groups);
  const calls = [];
  ui.setFetch(async url => {
    calls.push(url);
    return { ok: true, json: async () => url === "/api/campaigns" ? { groups } : { dataStatus: "unavailable", markets: [], entries: [], tiers: [] } };
  });
  await ui.loadCampaigns();
  await ui.selectCampaign(prophet.id);
  assert.equal(ui.element("prophetPanel").classList.contains("hidden"), false);
  assert.equal(ui.element("campaignDetails").classList.contains("hidden"), true);
  assert.equal(ui.events.at(-1).type, "eventlens:prophet-open");
  groups = { active: [], history: [{ ...prophet, status: "history" }, ended] };
  await ui.refreshCampaigns();
  assert.equal(ui.state.currentTab, "history");
  assert.equal(ui.state.currentCampaign.status, "history");
  assert.equal(ui.element("countActive").textContent, 0);
  assert.equal(ui.element("countHistory").textContent, 2);
  await ui.refreshCampaigns();
  assert.ok(calls.every(url => url === "/api/campaigns"), "分类同步不得触发任何榜单采集或交易赛行情请求");
  await ui.selectCampaign(ended.id);
  assert.equal(ui.element("prophetPanel").classList.contains("hidden"), true);
  assert.equal(ui.element("campaignDetails").classList.contains("hidden"), false);
  assert.ok(calls.some(url => url.includes("/api/binance/ranking?campaignId=ended-trade")));
});

test("已过期交易赛平时只同步分类，用户手动刷新时才重新加载详情", async () => {
  const ended = { id: "ended", name: "过期交易赛", status: "history" };
  const ui = campaignUI({ active: [], history: [ended] });
  await ui.loadCampaigns();
  await ui.selectCampaign(ended.id);
  const calls = [];
  ui.setFetch(async url => {
    calls.push(url);
    return { ok: true, json: async () => url === "/api/campaigns" ? { groups: { active: [], history: [ended] } } : { dataStatus: "unavailable", markets: [], entries: [], tiers: [] } };
  });
  await ui.refreshCampaigns();
  assert.deepEqual(calls, ["/api/campaigns"]);
  await ui.refreshCampaigns({ force: true });
  assert.equal(calls.filter(url => url.includes("/api/binance/ranking?")).length, 1);
});

test("进行中为空时隐藏历史活动详情，切回历史后仍能选择和查看", async () => {
  const ended = { id: "ended", name: "已结束联赛", status: "history" };
  const ui = campaignUI({ active: [], history: [ended] });
  await ui.loadCampaigns();
  await ui.selectCampaign("ended");
  assert.equal(ui.state.currentTab, "history");
  assert.equal(ui.element("campaignDetails").classList.contains("hidden"), false);
  const requestId = ui.state.detailRequestId;
  await ui.switchCampaignTab("active");
  assert.equal(ui.state.currentCampaign, null);
  assert.ok(ui.state.detailRequestId > requestId, "旧详情请求必须失效");
  assert.equal(ui.location.hash, "");
  assert.equal(ui.element("campaignDetails").classList.contains("hidden"), true);
  assert.match(ui.element("campaignList").innerHTML, /暂无进行中的活动/);
  await ui.refreshCampaigns();
  assert.equal(ui.state.currentTab, "active", "轮询不应将用户从空分类切走");
  assert.equal(ui.state.currentCampaign, null);
  await ui.switchCampaignTab("history");
  assert.equal(ui.state.currentCampaignId, "ended");
  assert.equal(ui.element("campaignDetails").classList.contains("hidden"), false);
});

test("页面打开期间活动到期，同步分类、数量和当前详情且保留快照", async () => {
  const active = { id: "league", name: "联赛", status: "active" };
  const ui = campaignUI({ active: [active], history: [] });
  await ui.loadCampaigns();
  await ui.selectCampaign("league");
  const ranking = { dataStatus: "available", eligibleUserCount: 3224 };
  ui.state.rankingData = ranking;
  ui.setGroups({ active: [], history: [{ ...active, status: "history" }] });
  await ui.refreshCampaigns();
  assert.equal(ui.state.currentTab, "history");
  assert.equal(ui.state.currentCampaign.status, "history");
  assert.equal(ui.element("countActive").textContent, 0);
  assert.equal(ui.element("countHistory").textContent, 1);
  assert.equal(ui.element("tabHistory").classList.contains("active"), true);
  assert.equal(ui.element("currentStatusBadge").textContent, "已结束");
  assert.equal(ui.state.rankingData, ranking, "归档不应清除已载入的排行榜快照");
  ui.setGroups({ active: [], history: [] });
  await ui.refreshCampaigns();
  assert.equal(ui.state.currentCampaignId, null);
  assert.equal(ui.element("campaignDetails").classList.contains("hidden"), true);
});

test("逐名展示支持精确名次搜索、50条分页和当前币对成本利润估算", () => {
  const ui = campaignUI({ active: [], history: [] });
  ui.state.currentCampaign = { pairs: ["A/USDT", "A/USDC"] };
  ui.state.rankingData = { rankEntriesStatus: "available", rankEntries: Array.from({ length: 1000 }, (_, index) => ({
    rank: index + 1, position: index + 1, volume: 2000 - index, rewardAmount: 1.5, rewardToken: "USDC", rewardUsdt: 1.5, rewardUsdtUnrounded: 1.5
  })) };
  ui.state.marketData = { markets: [
    { pair: "A/USDT", totalCostPer10k: 10, feeCostPer10k: 3, spreadLossPer10k: 7 },
    { pair: "A/USDC", totalCostPer10k: 20, volumeMultiplier: 2 }
  ] };
  ui.renderRankings();
  assert.equal((ui.element("rankList").innerHTML.match(/class="rank-entry"/g) || []).length, 50);
  ui.state.rankSearch = "1000";
  ui.renderRankList();
  assert.equal((ui.element("rankList").innerHTML.match(/class="rank-entry"/g) || []).length, 1);
  assert.match(ui.element("rankList").innerHTML, /data-position="1000"/);
  ui.state.rankSearch = "1";
  ui.renderRankList();
  assert.equal((ui.element("rankList").innerHTML.match(/class="rank-entry"/g) || []).length, 1);
  ui.state.rankSearch = "1001";
  ui.renderRankList();
  assert.match(ui.element("rankList").innerHTML, /请输入 1 至 1000/);
  ui.state.rankSearch = "";
  ui.state.rankPage = 19;
  ui.renderRankList();
  assert.match(ui.element("rankPageInfo").textContent, /951–1000/);
  assert.equal(ui.element("rankNextPage").disabled, true);
  assert.equal(ui.rankEstimate({ volume: 1000, rewardUsdtUnrounded: 1.5 }).profit, 0.5);
  ui.state.rankCostPair = "A/USDC";
  const estimate = ui.rankEstimate({ volume: 1000, rewardUsdtUnrounded: 1.5 });
  assert.equal(estimate.actualVolume, 500);
  assert.equal(estimate.cost, 2);
  assert.equal(estimate.profit, -0.5);
  assert.equal(ui.rankEstimate({ volume: 1000, rewardUsdt: null }).profit, null);
  ui.state.marketData = null;
  assert.equal(ui.rankEstimate({ volume: 1000, rewardUsdt: 10 }).cost, null);
});

test("旧快照不补造逐名交易量，保留汇总并提示获取新快照", () => {
  const ui = campaignUI({ active: [], history: [] });
  ui.state.currentCampaign = { tiers: [{ name: "第1名", rankFrom: 1, rankTo: 1, rewardPerUser: 12, rewardToken: "BNB" }] };
  ui.state.rankingData = { rankEntriesStatus: "needs-refresh", tiers: [{ name: "第1名", rankFrom: 1, rankTo: 1, thresholdVolumeUsd: 5000, rewardPerUser: 12, rewardToken: "BNB" }] };
  ui.renderRankings();
  assert.match(ui.element("rankSummaryGrid").innerHTML, /\$5,000/);
  assert.match(ui.element("rankDataStatus").textContent, /旧快照未保存逐名交易量/);
  assert.doesNotMatch(ui.element("rankList").innerHTML, /class="rank-entry"/);
  assert.equal(ui.element("rankRefreshBtn").classList.contains("hidden"), false);
});

test("刷新行情失败时保留排行榜但停止用旧盘口估算成本和利润", async () => {
  const { sampleCampaign, sampleSnapshot } = require("./helpers");
  const { computeRankingMetrics } = require("../lib/ranking");
  const campaign = sampleCampaign();
  const ranking = computeRankingMetrics(campaign, sampleSnapshot(), 700);
  const ui = campaignUI({ active: [campaign], history: [] });
  ui.state.currentCampaign = campaign;
  ui.state.currentCampaignId = campaign.id;
  ui.state.rankingData = ranking;
  ui.state.marketData = { markets: [{ pair: "SAMPLE/USDT", totalCostPer10k: 10 }] };
  ui.setFetch(async url => {
    if (url.startsWith("/api/binance/market")) throw new Error("offline");
    return { ok: true, json: async () => url.startsWith("/api/binance/ranking") ? ranking : { entries: [] } };
  });
  await ui.loadCurrentCampaignDetails({ force: true });
  assert.equal(ui.state.marketData, null);
  assert.equal(ui.state.rankingData.eligibleTradingVolume, 15000);
  assert.equal(ui.rankEstimate({ volume: 1000, rewardUsdt: 1 }).profit, null);
  assert.equal(ui.element("netProfitPer10k").textContent, "—");
  assert.match(ui.element("detailStatus").textContent, /行情.*offline/);
});

test("活动列表同步失败会显示提示，不抛出未处理的轮询异常", async () => {
  const ui = campaignUI({ active: [], history: [] });
  ui.setFetch(async () => { throw new Error("offline"); });
  await assert.doesNotReject(ui.refreshCampaigns());
  assert.match(ui.element("detailStatus").textContent, /活动列表同步失败.*offline/);
});

test("空值及越界费率暂停估算，后台行情不能恢复旧参数利润，有效零费率可恢复", () => {
  const { sampleCampaign, sampleSnapshot } = require("./helpers");
  const { computeRankingMetrics } = require("../lib/ranking");
  const ui = campaignUI({ active: [], history: [] });
  ui.state.currentCampaign = sampleCampaign();
  ui.state.rankingData = computeRankingMetrics(ui.state.currentCampaign, sampleSnapshot(), 700);
  const input = { value: "0.1", setCustomValidity(value) { this.validationMessage = value; }, setAttribute() {} };
  ui.updateCostInput(input, "feeRate", 0.02, "基础费率");
  assert.equal(ui.state.costInputValidity.feeRate, false);
  assert.match(input.validationMessage, /基础费率/);
  ui.state.marketData = { markets: [{ pair: "SAMPLE/USDT", totalCostPer10k: 10 }] };
  assert.equal(ui.rankEstimate({ volume: 1000, rewardUsdt: 1 }).profit, null);
  input.value = "";
  ui.updateCostInput(input, "feeRate", 0.02, "基础费率");
  assert.equal(ui.state.feeRate, 0.00075, "空输入不能按零费率计算");
  assert.equal(ui.element("netProfitPer10k").textContent, "—");
  input.value = "0";
  ui.updateCostInput(input, "feeRate", 0.02, "基础费率");
  assert.equal(ui.state.feeRate, 0);
  assert.equal(ui.state.costInputValidity.feeRate, true);
  assert.equal(input.validationMessage, "");
  input.value = "2";
  ui.updateCostInput(input, "rebateRate", 1, "返佣比例");
  assert.equal(ui.state.costInputValidity.rebateRate, false);
});
