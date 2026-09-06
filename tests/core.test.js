const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../core.js");

test("parses currency values and units", () => {
  assert.equal(core.toCents("$1,234.56"), 123456);
  assert.equal(core.toCents("2.5K"), 250000);
  assert.equal(core.toCents("1.2万"), 1200000);
});

test("calculates token reward per 10,000 U", () => {
  const tailMicros = 4398422453903;
  const result = core.rewardPer10k("80", tailMicros);
  assert.ok(Math.abs(result - 0.0181883393) < 0.000000001);
  assert.equal(core.rewardPer10k("", tailMicros), null);
  assert.equal(core.rewardPer10k("80", 0), null);
});

test("creates, sorts, and paginates compact history entries", () => {
  const baseResult = {
    sourceUrl: "https://example.com/wave-ENSO1/Main-Reward",
    excluded: 1000,
    count: 13520,
    totalMicros: 56013475254069,
    totalCents: 56013475254,
    topCount: 1000,
    topTotalMicros: 51615052800166,
    topTotalCents: 51615052800,
    tailCount: 12520,
    tailTotalMicros: 4398422453903,
    tailTotalCents: 4398422454,
    mode: "api"
  };
  const older = core.makeHistoryEntry({ ...baseResult, finishedAt: "2026-09-06T08:00:00Z" }, { competitionToken: "enso", rewardAmount: "80", rewardToken: "bnb" });
  const newer = core.makeHistoryEntry({ ...baseResult, finishedAt: "2026-09-06T09:00:00Z" }, { competitionToken: "enso", rewardAmount: "80", rewardToken: "bnbnb" });
  const history = core.mergeHistory([older], [newer, older]);
  assert.equal(history.length, 2);
  assert.equal(history[0].finishedAt, newer.finishedAt);
  assert.equal(history[0].competitionToken, "ENSO");
  assert.ok(Math.abs(older.rewardPer10k - 0.0181883393) < 0.000000001);
  const page = core.paginate([...history, older, newer, older, newer], 2, 5);
  assert.equal(page.currentPage, 2);
  assert.equal(page.items.length, 1);
});

test("handles large reward pools and leaderboards without spread overflow", () => {
  assert.equal(core.rewardPer10k("1000000000000000", 100000000000000), 10000000000);
  const records = Array.from({ length: 100000 }, (_, index) => ({
    rank: index + 1,
    position: index + 1,
    cents: index + 1
  }));
  const summary = core.summarize(records, 0);
  assert.equal(summary.count, 100000);
  assert.equal(summary.maxCents, 100000);
  assert.equal(summary.minCents, 1);
});

test("splitLeaderboard preserves tail volume for local reward recalculation", () => {
  const records = [
    { rank: 1, position: 1, micros: 100000000, cents: 100000 },
    { rank: 2, position: 2, micros: 250000000, cents: 250000 },
    { rank: 3, position: 3, micros: 400000000, cents: 400000 }
  ];
  const split = core.splitLeaderboard(records, 1);
  assert.equal(split.topTotalMicros, 100000000);
  assert.equal(split.tailTotalMicros, 650000000);
  assert.equal(split.topCount, 1);
  assert.equal(split.tailCount, 2);
  assert.ok(Number.isFinite(core.rewardPer10k(80, split.tailTotalMicros)));
});

test("extracts nested leaderboard records", () => {
  const payload = {
    code: "000000",
    data: {
      totalCount: 13520,
      pageNo: 101,
      pageSize: 10,
      list: [
        { ranking: 1001, nickname: "alice", tradingVolume: "$9,876.54" },
        { ranking: 1002, nickname: "bob", tradingVolume: "8765.43" }
      ]
    }
  };
  const page = core.extractPage(payload, 101, 10);
  assert.equal(page.total, 13520);
  assert.equal(page.page, 101);
  assert.equal(page.pageSize, 10);
  assert.deepEqual(page.records[0], { rank: 1001, position: 1001, micros: 987654000, cents: 987654, name: "alice" });
});

test("recognizes sequence as rank and trusts requested pagination", () => {
  const page = core.extractPage({ pageIndex: 1, pageSize: 10, total: 13520, data: [{ sequence: 13520, tradingVolume: 500.02345, nickName: "last" }] }, 136, 100);
  assert.equal(page.page, 136);
  assert.equal(page.pageSize, 100);
  assert.equal(page.records[0].rank, 13520);
  assert.equal(page.records[0].position, 13501);
  assert.equal(page.records[0].micros, 50002345);
});

test("detects and rewrites JSON pagination", () => {
  const template = {
    url: "https://example.com/api/rank",
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ campaign: "enso", pagination: { pageNo: 1, pageSize: 10 } })
  };
  const responsePage = { records: [{ rank: 1, cents: 100 }], pageSize: 10 };
  const inspection = core.inspectRequest(template, responsePage);
  assert.equal(inspection.canPaginate, true);
  const request = core.buildRequest(template, inspection, 101);
  assert.deepEqual(JSON.parse(request.body).pagination, { pageNo: 101, pageSize: 10 });
});

test("detects zero-based and offset pagination", () => {
  const zeroTemplate = { url: "https://example.com/api?current=0&size=20", method: "GET", headers: {}, body: null };
  const zeroInspection = core.inspectRequest(zeroTemplate, { records: [{ rank: 1 }], pageSize: 20 });
  assert.equal(zeroInspection.zeroBased, true);
  assert.match(core.buildRequest(zeroTemplate, zeroInspection, 3).url, /current=2/);

  const offsetTemplate = { url: "https://example.com/api?offset=0&limit=10", method: "GET", headers: {}, body: null };
  const offsetInspection = core.inspectRequest(offsetTemplate, { records: [{ rank: 1 }], pageSize: 10 });
  assert.match(core.buildRequest(offsetTemplate, offsetInspection, 101).url, /offset=1000/);
});

test("keeps tied ranks and excludes by leaderboard position", () => {
  const summary = core.summarize([
    { rank: 1000, position: 1000, cents: 50001 },
    { rank: 1001, position: 1001, cents: 10001 },
    { rank: 1002, position: 1002, cents: 20002 },
    { rank: 1002, position: 1003, cents: 20002 }
  ], 1000);
  assert.equal(summary.count, 3);
  assert.equal(summary.totalCents, 50005);
  assert.equal(summary.firstRank, 1001);
  assert.equal(summary.lastRank, 1002);
  assert.equal(summary.firstPosition, 1001);
  assert.equal(summary.lastPosition, 1003);
});
