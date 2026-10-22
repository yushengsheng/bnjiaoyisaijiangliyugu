const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { makeDataDir } = require("./helpers");
process.env.EVENTLENS_DATA_DIR = makeDataDir();
const storage = require("../lib/storage");
const prophet = require("../lib/prophet");
const { createServer } = require("../server");
let server, base, token;
const original = prophet.collect;
const originalRanks = prophet.getRanks;
const snapshot = { seasonId: prophet.SEASON_ID, collectedAt: "2026-10-22T00:00:00.000Z", week: { weekIndex: 2 }, season: {}, weekly: {} };

async function post(headers = {}) {
  return fetch(`${base}/api/prophet/refresh`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: "{}" });
}
test.before(async () => {
  server = createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  token = (await (await fetch(`${base}/api/session`)).json()).token;
});
test.after(async () => {
  prophet.collect = original;
  prophet.getRanks = originalRanks;
  await new Promise(resolve => server.close(resolve));
});

test("读取不触发网络，刷新受会话与同源保护，失败保留最后成功数据", async () => {
  let calls = 0;
  prophet.collect = async () => { calls++; return snapshot; };
  const initial = await (await fetch(`${base}/api/prophet`)).json();
  assert.deepEqual(initial, { snapshot: null, refreshing: false });
  assert.equal(calls, 0);
  assert.equal((await post()).status, 403);
  assert.equal((await post({ "X-EventLens-Token": token, Origin: "https://evil.example" })).status, 403);
  assert.equal(calls, 0);
  const files = await fs.readdir(storage.DATA_DIR);
  const before = await Promise.all(files.map(file => fs.readFile(path.join(storage.DATA_DIR, file))));
  const result = await post({ "X-EventLens-Token": token, Origin: base });
  assert.equal(result.status, 200);
  assert.deepEqual((await result.json()).snapshot, snapshot);
  for (const [index, file] of files.entries()) assert.deepEqual(await fs.readFile(path.join(storage.DATA_DIR, file)), before[index]);
  prophet.collect = async () => { throw Object.assign(new Error("公开接口暂不可用"), { statusCode: 502 }); };
  assert.equal((await post({ "X-EventLens-Token": token })).status, 502);
  assert.deepEqual((await (await fetch(`${base}/api/prophet`)).json()).snapshot, snapshot);
  assert.deepEqual(await storage.getProphetSnapshot(), snapshot);
});

test("重复刷新只执行一次，刷新状态可读且不启动交易赛调度", async () => {
  let release;
  let calls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  prophet.collect = async () => { calls++; await gate; return snapshot; };
  const pending = post({ "X-EventLens-Token": token });
  try {
    for (let i = 0; i < 50 && !calls; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal((await (await fetch(`${base}/api/prophet`)).json()).refreshing, true);
    assert.equal((await post({ "X-EventLens-Token": token })).status, 429);
    assert.equal(calls, 1);
    assert.equal(require("../server").scheduler.getStatus().enabled, false);
  } finally { release(); await pending; }
  assert.equal((await (await fetch(`${base}/api/prophet`)).json()).refreshing, false);
});

test("独立页面与静态资源可用，不放宽安全策略", async () => {
  for (const file of ["prophet.html", "prophet.js", "prophet.css"]) {
    const response = await fetch(`${base}/${file}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-security-policy"), /connect-src 'self'/);
  }
});

test("神算子加入同一活动列表，到期归历史；不进入交易赛存储和自动采集队列", async () => {
  const before = await storage.getProphetSnapshot();
  try {
    await storage.saveProphetSnapshot({ ...snapshot, period: { startMs: 1, endMs: 2 } });
    const groups = (await (await fetch(`${base}/api/campaigns`)).json()).groups;
    assert.equal(groups.active.some(item => item.kind === "prophet"), false);
    assert.equal(groups.history.filter(item => item.kind === "prophet").length, 1);
    assert.equal((await storage.getCampaigns()).some(item => item.kind === "prophet"), false);
    assert.deepEqual(await storage.getProphetSnapshot(), { ...snapshot, period: { startMs: 1, endMs: 2 } });
    let calls = 0;
    prophet.collect = async () => { calls++; return snapshot; };
    assert.equal((await post({ "X-EventLens-Token": token })).status, 200);
    assert.equal(calls, 1, "过期后仍允许用户手动刷新");
  } finally { await storage.saveProphetSnapshot(before); }
});

async function ranks(body, headers = { "X-EventLens-Token": token }) {
  return fetch(`${base}/api/prophet/ranks`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
}

test("逐名接口同源会话保护、周次绑定，非法请求不访问上游", async () => {
  let calls = 0;
  prophet.getRanks = async () => { calls++; return {}; };
  const query = { board: "season", rankFrom: 10001, rankTo: 10050 };
  assert.equal((await ranks(query, {})).status, 403);
  assert.equal((await ranks(query, { "X-EventLens-Token": token, Origin: "https://evil.example" })).status, 403);
  assert.equal((await ranks({ board: "weekly", rankFrom: 5000, weekIndex: 1 })).status, 409);
  assert.equal(calls, 0);
  prophet.getRanks = originalRanks;
  for (const body of [null, [], {}, { board: "season", rankFrom: -1 }, { board: "season", rankFrom: 1, rankTo: 51 }]) {
    assert.equal((await ranks(body)).status, 400);
  }
  assert.equal((await (await fetch(`${base}/api/prophet`)).json()).refreshing, false);
});

test("明细与汇总共用互斥，成功与失败均不改已存快照或原交易赛数据", async () => {
  const files = await fs.readdir(storage.DATA_DIR);
  const before = await Promise.all(files.map(file => fs.readFile(path.join(storage.DATA_DIR, file))));
  let release;
  let calls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const detail = { board: "weekly", weekIndex: 2, unit: "USDC", rows: [{ rank: 5000, points: "-0.0000000000000001", estimateReward: "5" }] };
  prophet.getRanks = async body => { calls++; assert.equal(body.weekIndex, 2); await gate; return detail; };
  const pending = ranks({ board: "weekly", rankFrom: 5000, weekIndex: 2 });
  try {
    for (let i = 0; i < 50 && !calls; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal((await ranks({ board: "season", rankFrom: 1 })).status, 429);
    assert.equal((await post({ "X-EventLens-Token": token })).status, 429);
    assert.equal(calls, 1);
  } finally { release(); }
  const response = await pending;
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), detail);
  prophet.getRanks = async () => { throw Object.assign(new Error("上游暂不可用"), { statusCode: 502 }); };
  assert.equal((await ranks({ board: "season", rankFrom: 1 })).status, 502);
  assert.equal((await (await fetch(`${base}/api/prophet`)).json()).refreshing, false);
  for (const [index, file] of files.entries()) assert.deepEqual(await fs.readFile(path.join(storage.DATA_DIR, file)), before[index]);
  assert.deepEqual(await fs.readdir(storage.DATA_DIR), files);
});

test("汇总采集期间也拒绝明细读取，完成后恢复", async () => {
  let release;
  let started = false;
  prophet.collect = async () => { started = true; await new Promise(resolve => { release = resolve; }); return snapshot; };
  const pending = post({ "X-EventLens-Token": token });
  try {
    for (let i = 0; i < 50 && !started; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(started, true);
    assert.equal((await ranks({ board: "season", rankFrom: 1 })).status, 429);
  } finally { release?.(); await pending; }
  assert.equal((await (await fetch(`${base}/api/prophet`)).json()).refreshing, false);
});
