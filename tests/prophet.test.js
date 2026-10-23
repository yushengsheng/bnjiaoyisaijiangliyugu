const test = require("node:test");
const assert = require("node:assert/strict");
const { collect, getRanks, comparePoints, selectWeek, getActivity, SEASON_ID } = require("../lib/prophet");

const weeks = [
  { weekIndex: 1, startMs: 1000, endMs: 2000 },
  { weekIndex: 2, startMs: 2000, endMs: 3000 }
];
const tiers = [1, 2, 3, 10, 100, 1000, 5000, 8000].map((rankTo, index, ends) => ({
  rankFrom: index ? ends[index - 1] + 1 : 1, rankTo, rewardAmount: `${100 - index}`
}));
const encode = rank => Buffer.from(JSON.stringify({ rank, id: "fixture" })).toString("base64");
const reply = data => ({ ok: true, json: async () => ({ success: true, code: "000000", data }) });
function fixture({ total = 8000, change = data => data } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const payload = JSON.parse(options.body);
    const endpoint = url.split("/season/")[1];
    const rank = payload.cursor ? JSON.parse(Buffer.from(payload.cursor, "base64")).rank : 0;
    calls.push({ endpoint, rank, ...payload });
    if (endpoint === "query") return reply({ weekInfos: weeks, seasonStartTime: 1000, seasonEndTime: 3000 });
    const end = Math.min(rank + 50, total);
    const data = {
      hasMore: end < total, nextCursor: end < total ? encode(end) : null,
      rewardConfig: { enable: true, unit: "USDC", tierRewardConfigs: tiers },
      leaderboardInfos: Array.from({ length: Math.max(0, end - rank) }, (_, i) => ({
        rank: rank + i + 1, points: `${4000 - rank - i}.0000000000000001`, estimateReward: "5",
        displayName: "must-not-be-saved", avatar: "must-not-be-saved"
      }))
    };
    return reply(change(data, { endpoint, rank, calls }));
  };
  return { calls, fetchImpl, now: () => 2500, pause: async () => {},
    resolveOrigin: async () => "https://current.fixture.com", invalidateOrigin: () => {} };
}

test("积分比较保留高精度、大整数、负收益和负零", () => {
  assert.equal(comparePoints("9007199254740993.0000000000000001", "9007199254740993.0000000000000000"), 1);
  assert.equal(comparePoints("-0.0001", "0"), -1);
  assert.equal(comparePoints("-20.1", "-20.01"), -1);
  assert.equal(comparePoints("1.00", "1"), 0);
  assert.throws(() => comparePoints("1e3", "1000"));
});

test("周次按官方时间切换，不固定第一周；活动前后明确状态", () => {
  assert.equal(selectWeek(weeks, 1999).weekIndex, 1);
  assert.equal(selectWeek(weeks, 2000).weekIndex, 2);
  assert.equal(selectWeek(weeks, 500).status, "upcoming");
  assert.equal(selectWeek(weeks, 3000).status, "ended");
  assert.throws(() => selectWeek([{ ...weeks[0], endMs: 2500 }, weeks[1]], 2100));
});

test("神算子按整个赛季结束时间归档，不按单周归档，旧快照也能判定过期", () => {
  const snapshot = { seasonId: SEASON_ID, period: { startMs: 1000, endMs: 3000 }, week: weeks[0] };
  assert.equal(getActivity(snapshot, 500).status, "upcoming");
  assert.equal(getActivity(snapshot, 2000).status, "active");
  assert.equal(getActivity(snapshot, 2999).status, "active");
  assert.equal(getActivity(snapshot, 3000).status, "history");
  assert.equal(getActivity({ seasonId: SEASON_ID }, Date.UTC(2100, 0, 1)).status, "history");
  assert.equal(getActivity({ ...snapshot, seasonId: "other" }, Date.UTC(2026, 9, 22)).status, "active");
});

test("首次游标定位所有奖励边界，按实际rank取值且不保存昵称和游标", async () => {
  const input = fixture();
  const result = await collect(input);
  assert.equal(input.calls.length, 11);
  assert.equal(result.week.weekIndex, 2);
  assert.deepEqual(result.period, { startMs: 1000, endMs: 3000 });
  assert.equal(result.season.thresholds.at(-1).points, "-3999.0000000000000001");
  assert.equal(result.weekly.thresholds[4].points, "3901.0000000000000001");
  assert.ok(input.calls.filter(call => call.endpoint.endsWith("weekly")).every(call => call.weekIndex === 2));
  assert.doesNotMatch(JSON.stringify(result), /must-not-be-saved|cursor|fixture|avatar/);
});

test("定位窗口缺目标时回退正常逐页，确认榜尾后缺失门槛为null而非0", async () => {
  const input = fixture({ total: 60 });
  const result = await collect(input);
  assert.equal(result.season.thresholds[3].points, "3991.0000000000000001");
  assert.equal(result.season.thresholds[4].points, null);
  assert.ok(input.calls.some(call => call.rank === 50));
});

test("游标协议改变、窗口不连续或HTTP400/422拒绝定位时回退顺序分页", async () => {
  for (const broken of ["cursor", "window", "rejected", 400, 422]) {
    const input = fixture({ total: 120, change(data, { rank }) {
      if (broken === "cursor") data.nextCursor = data.hasMore ? `opaque-${rank + 50}` : null;
      if (broken === "window" && rank === 75) data.leaderboardInfos[2].rank++;
      return data;
    } });
    if (broken === "cursor") {
      // 不透明游标仍是官方可用游标；fixture只在顺序读取时解析它。
      const original = input.fetchImpl;
      input.fetchImpl = (url, options) => {
        const body = JSON.parse(options.body);
        if (body.cursor?.startsWith("opaque-")) body.cursor = encode(Number(body.cursor.slice(7)));
        return original(url, { ...options, body: JSON.stringify(body) });
      };
    }
    if (broken === "rejected" || typeof broken === "number") {
      const original = input.fetchImpl;
      input.fetchImpl = (url, options) => {
        const body = JSON.parse(options.body);
        if (body.cursor && JSON.parse(Buffer.from(body.cursor, "base64")).rank === 75) {
          if (typeof broken === "number") return Promise.resolve({ ok: false, status: broken });
          return Promise.resolve({ ok: true, json: async () => ({ success: false, code: "invalid-cursor" }) });
        }
        return original(url, options);
      };
    }
    const result = await collect(input);
    assert.equal(result.season.thresholds[4].points, "3901.0000000000000001", broken);
    assert.ok(input.calls.some(call => call.rank === 50), broken);
  }
});

test("分页重复、跨页逆序或不连续时拒绝提交", async () => {
  for (const broken of ["repeat", "order", "gap"]) {
    const input = fixture({ total: 130, change(data, { rank }) {
      if (rank === 75) data.leaderboardInfos = []; // 迫使定位回退。
      if (rank === 50) {
        if (broken === "repeat") data.nextCursor = encode(50);
        if (broken === "order") data.leaderboardInfos.forEach(row => { row.points = "99999"; });
        if (broken === "gap") data.leaderboardInfos.forEach(row => { row.rank++; });
      }
      return data;
    } });
    await assert.rejects(collect(input), /分页|顺序/);
  }
});

test("网络、限流、奖励协议和部分榜单失败均不会返回成功快照", async () => {
  await assert.rejects(collect({ ...fixture(), fetchImpl: async () => { throw new Error("sensitive-network-diagnostic"); } }),
    error => error.statusCode === 502 && !error.message.includes("sensitive"));
  await assert.rejects(collect({ ...fixture(), fetchImpl: async () => ({ ok: false, status: 429 }) }), /限流/);
  const invalid = fixture({ change(data) { data.rewardConfig.tierRewardConfigs = [{ rankFrom: 2, rankTo: 5, rewardAmount: "2" }]; return data; } });
  await assert.rejects(collect(invalid), /档位/);
  const input = fixture();
  const original = input.fetchImpl;
  input.fetchImpl = (url, options) => url.endsWith("weekly") ? Promise.reject(new Error("offline")) : original(url, options);
  await assert.rejects(collect(input), /连接失败/);
});

test("跨周采集不落盘旧周数据", async () => {
  let ticks = 0;
  await assert.rejects(collect({ ...fixture(), now: () => ticks++ ? 3000 : 2500 }), /切换周次/);
});

test("单次采集固定导航来源，故障清除缓存但不重试或切换来源", async () => {
  const input = fixture();
  let resolves = 0;
  let invalidates = 0;
  input.resolveOrigin = async () => { resolves++; return "https://current.fixture.com"; };
  input.invalidateOrigin = origin => { assert.equal(origin, "https://current.fixture.com"); invalidates++; };
  const original = input.fetchImpl;
  input.fetchImpl = (url, options) => {
    assert.equal(new URL(url).origin, "https://current.fixture.com");
    assert.equal(options.redirect, "error");
    return original(url, options);
  };
  assert.equal((await collect(input)).sourceUrl, "https://www.bsmkweb.cc/zh-CN/prophet/leaderboard?seasonId=prophet_1019_s1");
  assert.equal(resolves, 1);
  assert.equal(invalidates, 0);
  let requests = 0;
  input.fetchImpl = async () => { requests++; throw new Error("ECONNRESET"); };
  await assert.rejects(collect(input), /连接失败/);
  assert.equal(requests, 1);
  assert.equal(invalidates, 1);
});

test("逐名明细按实际名次定位完整50条，搜索只返回目标，且不泄漏昵称和游标", async () => {
  const input = fixture({ total: 20000, change(data) {
    data.rewardConfig.tierRewardConfigs = [{ rankFrom: 1, rankTo: 20000, rewardAmount: "7" }];
    return data;
  } });
  const result = await getRanks({ board: "season", rankFrom: 10001, rankTo: 10050 }, input);
  assert.equal(result.rows.length, 50);
  assert.equal(result.rows[0].rank, 10001);
  assert.equal(result.rows.at(-1).rank, 10050);
  assert.ok(input.calls.length <= 3);
  assert.doesNotMatch(JSON.stringify(result), /must-not-be-saved|cursor|fixture|avatar/);
  const single = await getRanks({ board: "weekly", rankFrom: 7000, weekIndex: 2 }, fixture());
  assert.equal(single.rows.length, 1);
  assert.equal(single.rows[0].rank, 7000);
  assert.equal(single.weekIndex, 2);
});

test("明细窗口偏移时仍补齐50条，HTTP400/422拒绝定位会回退官方游标", async () => {
  for (const mode of ["offset", 400, 422]) {
    const input = fixture({ total: 150 });
    const original = input.fetchImpl;
    input.fetchImpl = async (url, options) => {
      const body = JSON.parse(options.body);
      const rank = body.cursor ? JSON.parse(Buffer.from(body.cursor, "base64")).rank : 0;
      if (rank === 99) {
        if (mode !== "offset") return { ok: false, status: mode };
        body.cursor = encode(98);
        return original(url, { ...options, body: JSON.stringify(body) });
      }
      return original(url, options);
    };
    const result = await getRanks({ board: "season", rankFrom: 100, rankTo: 149 }, input);
    assert.equal(result.rows.length, 50, String(mode));
    assert.equal(result.rows[0].rank, 100);
    assert.equal(result.rows.at(-1).rank, 149);
    if (mode !== "offset") assert.ok(input.calls.some(call => call.rank === 50));
  }
});

test("明细不存在时确认榜尾，越界或超过50条拒绝；限流不额外回退放大请求", async () => {
  const missing = await getRanks({ board: "season", rankFrom: 1000 }, fixture({ total: 60 }));
  assert.deepEqual(missing.rows, []);
  for (const query of [{ board: "unknown", rankFrom: 1 }, { board: "season", rankFrom: 0 },
    { board: "season", rankFrom: 1, rankTo: 51 }, { board: "weekly", rankFrom: 1 }, { board: "season", rankFrom: 9000 }]) {
    await assert.rejects(getRanks(query, fixture()), error => error.statusCode === 400);
  }
  const input = fixture();
  const original = input.fetchImpl;
  let calls = 0;
  input.fetchImpl = (...args) => ++calls === 2 ? Promise.resolve({ ok: false, status: 429 }) : original(...args);
  await assert.rejects(getRanks({ board: "season", rankFrom: 1000 }, input), /限流/);
  assert.equal(calls, 2);
});

test("逐名顺序回退仍验证跨页连续性和顺序，不接受循环或残缺榜单", async () => {
  for (const broken of ["repeat", "gap", "order", "null-row"]) {
    const input = fixture({ total: 150, change(data, { rank }) {
      if (rank === 99) data.leaderboardInfos = []; // 定位窗口不可用，强制顺序回退。
      if (rank === 50) {
        if (broken === "repeat") data.nextCursor = encode(50);
        if (broken === "gap") data.leaderboardInfos.forEach(row => { row.rank++; });
        if (broken === "order") data.leaderboardInfos.forEach(row => { row.points = "99999"; });
        if (broken === "null-row") data.leaderboardInfos[0] = null;
      }
      return data;
    } });
    await assert.rejects(getRanks({ board: "season", rankFrom: 100, rankTo: 149 }, input), error => error.statusCode === 502);
  }
});
