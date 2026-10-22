const test = require("node:test");
const assert = require("node:assert/strict");
const { collect, getRanks } = require("../lib/prophet");

// 用本次真实响应中的原始 rank/points 核对结果，避免把实时榜单变化误判为取错数据。
function reference() {
  const rows = new Map();
  const configs = new Map();
  let requests = 0;
  let active = 0;
  let maxActive = 0;
  const fetchImpl = async (url, options) => {
    requests++;
    maxActive = Math.max(maxActive, ++active);
    try {
      const response = await fetch(url, options);
      const json = await response.clone().json();
      const board = url.endsWith("/weekly") ? "weekly" : "season";
      if (json.data?.leaderboardInfos) {
        for (const row of json.data.leaderboardInfos) rows.set(`${board}:${row.rank}`, {
          rank: row.rank, points: row.points, estimateReward: row.estimateReward
        });
        if (JSON.parse(options.body).cursor === null) configs.set(board, json.data.rewardConfig);
      }
      return response;
    } finally { active--; }
  };
  return { fetchImpl, rows, configs, stats: () => ({ requests, maxActive }) };
}

let snapshot;
test("神算子真实赛季和周榜门槛、奖励档位逐项匹配官方原始响应", { timeout: 190000 }, async t => {
  const source = reference();
  snapshot = await collect({ fetchImpl: source.fetchImpl });
  for (const kind of ["season", "weekly"]) {
    const config = source.configs.get(kind);
    assert.equal(snapshot[kind].unit, config.unit);
    assert.equal(snapshot[kind].thresholds.length, config.tierRewardConfigs.length);
    snapshot[kind].thresholds.forEach((tier, index) => {
      const expected = config.tierRewardConfigs[index];
      assert.equal(tier.rankFrom, expected.rankFrom);
      assert.equal(tier.rankTo, expected.rankTo);
      assert.equal(tier.rewardAmount, expected.rewardAmount);
      const row = source.rows.get(`${kind}:${tier.rankTo}`);
      assert.ok(row, `未核对到 ${kind} 第 ${tier.rankTo} 名`);
      assert.equal(tier.points, row.points);
      assert.equal(tier.estimateReward, row.estimateReward);
    });
  }
  assert.equal(source.stats().maxActive, 1);
  assert.doesNotMatch(JSON.stringify(snapshot), /nextCursor|displayName|nickname|avatar|userId/);
  t.diagnostic(`两榜门槛与奖励逐项通过，${source.stats().requests} 次串行请求`);
});

test("神算子真实跨页明细及奖励榜最后一名不偏移，完整精度与官方行一致", { timeout: 190000 }, async t => {
  assert.ok(snapshot, "须先成功读取当前赛季配置");
  const seasonMax = snapshot.season.thresholds.at(-1).rankTo;
  const weeklyMax = snapshot.weekly.thresholds.at(-1).rankTo;
  for (const query of [
    { board: "season", rankFrom: 51, rankTo: 100 },
    { board: "season", rankFrom: seasonMax - 49, rankTo: seasonMax },
    { board: "season", rankFrom: seasonMax },
    { board: "weekly", rankFrom: weeklyMax, weekIndex: snapshot.week.weekIndex }
  ]) {
    const source = reference();
    const result = await getRanks(query, { fetchImpl: source.fetchImpl });
    assert.equal(result.rows.length, (query.rankTo || query.rankFrom) - query.rankFrom + 1);
    result.rows.forEach((row, index) => {
      assert.equal(row.rank, query.rankFrom + index);
      assert.deepEqual(row, source.rows.get(`${query.board}:${row.rank}`));
    });
    assert.equal(source.stats().maxActive, 1);
    assert.doesNotMatch(JSON.stringify(result), /nextCursor|displayName|nickname|avatar|userId/);
  }
  t.diagnostic("跨页、完整50条、单名次、两榜最后奖励名次均通过");
});
