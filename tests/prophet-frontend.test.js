const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const source = fs.readFileSync(path.join(__dirname, "../public/prophet.js"), "utf8");
function ui() {
  const elements = new Map();
  const nodes = [];
  function node() {
    const value = { textContent: "", dataset: {}, children: [], disabled: false, hidden: false, value: "", className: "", attributes: {}, listeners: {},
      append(child) { this.children.push(child); }, replaceChildren(...children) { this.children = children; this.textContent = ""; },
      addEventListener(name, callback) { this.listeners[name] = callback; }, setAttribute(name, value) { this.attributes[name] = value; } };
    nodes.push(value);
    return value;
  }
  function element(id) {
    if (!elements.has(id)) elements.set(id, node());
    return elements.get(id);
  }
  const calls = [];
  let fetchImpl = async url => ({ ok: true, status: 200, json: async () => url === "/api/session" ? { token: "fixture" } : { snapshot: null } });
  const context = { Event, document: { getElementById: element, dispatchEvent() {}, createElement: node,
    querySelectorAll: selector => selector.includes("#seasonRows") || selector.includes("#weeklyRows")
      ? element(selector.includes("#seasonRows") ? "seasonRows" : "weeklyRows").children.map(row => row.children[0]?.children[0]).filter(Boolean)
      : nodes.filter(value => value.className.includes("prophet-data-action")) },
    fetch: (url, options) => { calls.push({ url, options }); return fetchImpl(url, options); } };
  vm.runInNewContext(source.replace('  document.addEventListener("eventlens:prophet-open", open);', "  globalThis.ui = { formatPoints, render, refresh, init, open, loadRange };"), context);
  return { ...context.ui, element, calls, setFetch: impl => { fetchImpl = impl; } };
}
const board = { unit: "USDC", thresholds: [{ rankFrom: 1, rankTo: 1000, points: "152.6778000000000000", rewardAmount: "25" }] };
const snapshot = { seasonId: "fixture-season", collectedAt: "2026-10-22T00:00:00Z",
  week: { weekIndex: 2, startMs: 1, endMs: 2 }, season: board, weekly: board };

test("仅显示精度字符串，不作浮点取整；空名次和恶意文本安全显示", () => {
  const app = ui();
  assert.equal(app.formatPoints("9007199254740993.0000000000000001"), "9,007,199,254,740,993.0000000000000001");
  assert.equal(app.formatPoints("-0.0001000000"), "-0.0001");
  assert.equal(app.formatPoints(null), "暂无该名次");
  app.render({ ...snapshot, seasonId: "<img src=x onerror=bad>" });
  assert.equal(app.element("seasonPeriod").textContent, "<img src=x onerror=bad>");
  assert.equal(app.element("seasonRows").children[0].children[1].textContent, "152.6778");
});

test("点击档位只取50条、可以翻页和收起；明细失败保留旧页", async () => {
  const app = ui();
  await app.init();
  app.render({ ...snapshot, season: { unit: "USDC", thresholds: [
    { rankFrom: 1, rankTo: 10000, points: "1000", rewardAmount: "15" },
    { rankFrom: 10001, rankTo: 20000, points: "610", rewardAmount: "7" }
  ] } });
  app.setFetch(async (url, options) => ({ ok: true, status: 200, json: async () => {
    if (url === "/api/session") return { token: "fixture" };
    const { rankFrom, rankTo } = JSON.parse(options.body);
    return { unit: "USDC", collectedAt: snapshot.collectedAt, rows: Array.from({ length: rankTo - rankFrom + 1 }, (_, i) => ({
      rank: rankFrom + i, points: "9007199254740993.0000000000000001", estimateReward: "7"
    })) };
  } }));
  const button = app.element("seasonRows").children[1].children[0].children[0];
  await button.listeners.click();
  assert.deepEqual(JSON.parse(app.calls.at(-1).options.body), { board: "season", rankFrom: 10001, rankTo: 10050 });
  assert.equal(app.element("seasonDetailRows").children.length, 50);
  assert.equal(app.element("seasonDetailRows").children[0].children[1].textContent, "9,007,199,254,740,993.0000000000000001");
  assert.equal(button.attributes["aria-expanded"], "true");
  await app.element("seasonNext").listeners.click();
  assert.equal(JSON.parse(app.calls.at(-1).options.body).rankFrom, 10051);
  const rows = app.element("seasonDetailRows").children;
  app.setFetch(async () => ({ ok: false, status: 502, json: async () => ({ error: "暂不可用" }) }));
  await app.element("seasonNext").listeners.click();
  assert.equal(app.element("seasonDetailRows").children, rows);
  assert.match(app.element("seasonDetailStatus").textContent, /保留上次成功明细/);
  const count = app.calls.length;
  await button.listeners.click();
  assert.equal(app.element("seasonDetails").hidden, true);
  assert.equal(app.calls.length, count);
});

test("名次搜索只请求对应名次，周榜绑定所显示周次；非法名次不发请求", async () => {
  const app = ui();
  await app.init();
  app.render(snapshot);
  app.setFetch(async (url, options) => ({ ok: true, status: 200, json: async () => url === "/api/session" ? { token: "fixture" } :
    { unit: "USDC", collectedAt: snapshot.collectedAt, rows: [{ rank: JSON.parse(options.body).rankFrom, points: "152.6778000000000000", estimateReward: "5" }] } }));
  app.element("weeklyRankSearch").value = "500";
  await app.element("weeklySearchForm").listeners.submit({ preventDefault() {} });
  assert.deepEqual(JSON.parse(app.calls.at(-1).options.body), { board: "weekly", rankFrom: 500, rankTo: 500, weekIndex: 2 });
  assert.equal(app.element("weeklyDetailRows").children.length, 1);
  const count = app.calls.length;
  for (const value of ["", "0", "1.5", "1001", "-1"]) {
    app.element("weeklyRankSearch").value = value;
    await app.element("weeklySearchForm").listeners.submit({ preventDefault() {} });
  }
  assert.equal(app.calls.length, count);
});

test("明细加载与汇总刷新互斥，末页不越过档位，汇总更新后清除旧明细", async () => {
  const app = ui();
  await app.init();
  const small = { ...board, thresholds: [{ rankFrom: 1, rankTo: 75, points: "10", rewardAmount: "5" }] };
  app.render({ ...snapshot, season: small });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  app.setFetch(async (url, options) => {
    if (url === "/api/session") return { ok: true, status: 200, json: async () => ({ token: "fixture" }) };
    await gate;
    const { rankFrom, rankTo } = JSON.parse(options.body);
    return { ok: true, status: 200, json: async () => ({ unit: "USDC", collectedAt: snapshot.collectedAt,
      rows: Array.from({ length: rankTo - rankFrom + 1 }, (_, i) => ({ rank: rankFrom + i, points: "10", estimateReward: "5" })) }) };
  });
  const pending = app.loadRange("season", 1, 75, 1);
  await app.refresh();
  await app.loadRange("weekly", 1, 1, 1);
  assert.equal(app.element("prophetRefresh").disabled, true);
  release();
  await pending;
  assert.equal(app.calls.filter(call => call.url.endsWith("refresh")).length, 0);
  assert.equal(app.calls.filter(call => call.url.endsWith("ranks")).length, 1);
  assert.equal(app.element("seasonPrev").disabled, true);
  assert.equal(app.element("seasonNext").disabled, false);
  await app.element("seasonNext").listeners.click();
  assert.deepEqual(JSON.parse(app.calls.at(-1).options.body), { board: "season", rankFrom: 51, rankTo: 75 });
  assert.equal(app.element("seasonDetailRows").children.length, 25);
  assert.equal(app.element("seasonNext").disabled, true);
  assert.equal(app.element("seasonPrev").disabled, false);
  app.render(snapshot);
  assert.equal(app.element("seasonDetails").hidden, true);
  assert.equal(app.element("seasonPrev").disabled, true);
  assert.equal(app.element("seasonNext").disabled, true);
});

test("打开页面只读本地快照，不自动刷新；失败保留旧表格并恢复按钮", async () => {
  const app = ui();
  await app.init();
  assert.deepEqual(app.calls.map(call => call.url), ["/api/prophet"]);
  app.render(snapshot);
  const rows = app.element("seasonRows").children;
  app.setFetch(async url => ({ ok: url === "/api/session", status: url === "/api/session" ? 200 : 502,
    json: async () => url === "/api/session" ? { token: "fixture" } : { error: "暂不可用" } }));
  await app.refresh();
  assert.equal(app.element("seasonRows").children, rows);
  assert.match(app.element("prophetStatus").textContent, /上次成功数据/);
  assert.equal(app.element("prophetRefresh").disabled, false);
  assert.equal(app.calls.at(-1).options.headers["X-EventLens-Token"], "fixture");
});

test("首页按需打开神算子，重复选择或归档只更新标记，不重复读取或自动抓榜", async () => {
  const app = ui();
  assert.equal(app.calls.length, 0);
  const activity = { name: "神算子", startTime: "2026-10-21T00:00:00Z", endTime: "2026-11-16T00:00:00Z", status: "active" };
  await app.open({ detail: activity });
  await app.open({ detail: { ...activity, status: "history" } });
  assert.deepEqual(app.calls.map(call => call.url), ["/api/prophet"]);
  assert.match(app.element("prophetActivityState").textContent, /已过期/);
  assert.equal(app.element("prophetRefresh").disabled, false);
});

test("刷新期间不重复提交，成功后更新两榜和采集时间", async () => {
  const app = ui();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  app.setFetch(async url => {
    if (url === "/api/session") return { ok: true, status: 200, json: async () => ({ token: "fixture" }) };
    await gate;
    return { ok: true, status: 200, json: async () => ({ snapshot }) };
  });
  const pending = app.refresh();
  await app.refresh();
  assert.equal(app.element("prophetRefresh").disabled, true);
  release();
  await pending;
  assert.equal(app.calls.filter(call => call.url.endsWith("refresh")).length, 1);
  assert.equal(app.element("weeklyRows").children.length, 1);
  assert.match(app.element("prophetTime").textContent, /采集时间/);
  assert.equal(app.element("prophetRefresh").disabled, false);
});
