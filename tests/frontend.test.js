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
  assert.match(app, /loadCurrentCampaignDetails\(\{ force: true \}\)/);
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
