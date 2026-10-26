const navigation = require("./prophet-navigation");
const { SEASON_ID, SOURCE_URL, API_PATH } = navigation;
// 当前赛季的官方起止时间（2026-10-22 核验），兼容尚未保存时间字段的旧快照。
const DEFAULT_PERIOD = { startMs: 1792540800000, endMs: 1794787140000 };
const MAX_RANK = 25000;
const decimalPattern = /^-?\d{1,40}(?:\.\d{1,40})?$/;

function upstreamError(message) {
  return Object.assign(new Error(message), { statusCode: 502 });
}

function validPeriod(period) {
  return Number.isSafeInteger(period?.startMs) && Number.isSafeInteger(period?.endMs) &&
    period.startMs > 0 && period.endMs > period.startMs && period.endMs <= 8640000000000000;
}

function getActivity(snapshot, now = Date.now()) {
  const period = snapshot?.seasonId === SEASON_ID && validPeriod(snapshot.period) ? snapshot.period : DEFAULT_PERIOD;
  return {
    id: `prophet:${SEASON_ID}`, kind: "prophet", name: "神算子 · 第 1 赛季", token: "神算子", market: "积分",
    startTime: new Date(period.startMs).toISOString(), endTime: new Date(period.endMs).toISOString(),
    status: now >= period.endMs ? "history" : now < period.startMs ? "upcoming" : "active"
  };
}

function decimal(value, nonnegative = false) {
  if (typeof value !== "string" || !decimalPattern.test(value) || (nonnegative && value.startsWith("-"))) {
    throw upstreamError("神算子积分或奖励格式异常，已保留上次数据");
  }
  return value;
}

// 不经过浮点数，保留接口的完整精度（周榜也允许负收益）。
function comparePoints(left, right) {
  const parts = [decimal(left), decimal(right)].map(value => value.split("."));
  const scale = Math.max(...parts.map(([, fraction = ""]) => fraction.length));
  const [a, b] = parts.map(([integer, fraction = ""]) => BigInt(`${integer}${fraction.padEnd(scale, "0")}`));
  return a > b ? 1 : a < b ? -1 : 0;
}

function normalizePage(data) {
  if (!data || !Array.isArray(data.leaderboardInfos) || typeof data.hasMore !== "boolean") {
    throw upstreamError("神算子榜单格式已变化，已保留上次数据");
  }
  const rows = data.leaderboardInfos.map(row => {
    if (!row || !Number.isSafeInteger(row.rank) || row.rank < 1 || row.rank > MAX_RANK) {
      throw upstreamError("神算子名次格式异常，已保留上次数据");
    }
    return { rank: row.rank, points: decimal(row.points), estimateReward: decimal(row.estimateReward, true) };
  });
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].rank !== rows[i - 1].rank + 1 || comparePoints(rows[i - 1].points, rows[i].points) < 0) {
      throw upstreamError("神算子名次不连续或积分顺序异常，已保留上次数据");
    }
  }
  if (data.hasMore && (!rows.length || typeof data.nextCursor !== "string" || !data.nextCursor || data.nextCursor.length > 4096)) {
    throw upstreamError("神算子分页信息异常，已保留上次数据");
  }
  return { rows, hasMore: data.hasMore, nextCursor: data.nextCursor };
}

function rewardTiers(config) {
  if (!config || config.enable !== true || !/^[A-Za-z0-9]{1,12}$/.test(config.unit || "") ||
      !Array.isArray(config.tierRewardConfigs) || !config.tierRewardConfigs.length || config.tierRewardConfigs.length > 30) {
    throw upstreamError("神算子奖励规则不可用，已保留上次数据");
  }
  let nextRank = 1;
  return config.tierRewardConfigs.map(tier => {
    const { rankFrom, rankTo } = tier;
    if (rankFrom !== nextRank || !Number.isSafeInteger(rankTo) || rankTo < rankFrom || rankTo > MAX_RANK) {
      throw upstreamError("神算子奖励档位异常，已保留上次数据");
    }
    nextRank = rankTo + 1;
    return { rankFrom, rankTo, rewardAmount: decimal(tier.rewardAmount, true) };
  });
}

function normalizeWeeks(weekInfos) {
  if (!Array.isArray(weekInfos) || !weekInfos.length) throw upstreamError("神算子周次信息不可用");
  const weeks = weekInfos.map(week => {
    if (!week || !Number.isSafeInteger(week.weekIndex) || week.weekIndex < 1 || week.weekIndex > 52 || !Number.isSafeInteger(week.startMs) ||
        !Number.isSafeInteger(week.endMs) || week.endMs <= week.startMs) throw upstreamError("神算子周次信息异常");
    return { weekIndex: week.weekIndex, startMs: week.startMs, endMs: week.endMs };
  }).sort((a, b) => a.startMs - b.startMs);
  for (let i = 1; i < weeks.length; i++) {
    if (weeks[i].startMs < weeks[i - 1].endMs || weeks.slice(0, i).some(w => w.weekIndex === weeks[i].weekIndex)) {
      throw upstreamError("神算子周次信息冲突");
    }
  }
  return weeks;
}

function selectWeek(weekInfos, now, weekIndex) {
  const weeks = normalizeWeeks(weekInfos);
  const week = weekIndex === undefined
    ? weeks.find(w => now >= w.startMs && now < w.endMs) || weeks.filter(w => w.startMs <= now).at(-1) || weeks[0]
    : weeks.find(w => w.weekIndex === weekIndex);
  if (!week) throw Object.assign(new Error("所选周次不在当前赛季内，请刷新榜单"), { statusCode: 400 });
  return { ...week, status: now < week.startMs ? "upcoming" : now >= week.endMs ? "ended" : "active" };
}

function seekCursor(cursor, rank) {
  try {
    const anchor = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!anchor || Array.isArray(anchor) || !Number.isSafeInteger(anchor.rank) || anchor.rank < 1 || !("id" in anchor)) return null;
    return Buffer.from(JSON.stringify({ ...anchor, rank: Math.max(1, rank - 25) })).toString("base64");
  } catch (_) { return null; }
}

function createRequester({ fetchImpl = globalThis.fetch, pause = ms => new Promise(resolve => setTimeout(resolve, ms)),
  resolveOrigin = navigation.getOrigin, invalidateOrigin = navigation.invalidate } = {}) {
  const deadline = AbortSignal.timeout(180000);
  let requests = 0;
  let origin;
  return async function request(endpoint, payload) {
    if (requests++) await pause(100);
    try {
      // 一次采集固定同一来源，避免中途切换域名拼接不同榜单。
      origin ||= await resolveOrigin();
      const response = await fetchImpl(origin + API_PATH + endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ seasonId: SEASON_ID, ...payload }),
        redirect: "error",
        signal: AbortSignal.any([deadline, AbortSignal.timeout(12000)])
      });
      if (!response.ok) throw Object.assign(upstreamError(response.status === 429 ? "官方接口暂时限流，请稍后刷新" : "神算子公开接口暂时不可用"), {
        protocolChange: response.status === 400 || response.status === 422,
        transport: response.status !== 400 && response.status !== 422
      });
      const json = await response.json();
      if (json?.success !== true || json.code !== "000000" || !json.data) {
        throw Object.assign(upstreamError("神算子公开接口返回异常，已保留上次数据"), { protocolChange: true });
      }
      return json.data;
    } catch (error) {
      // 不在故障时重复请求；下次手动更新重新导航，不影响已成功的旧快照。
      if (origin && (error.transport || !error.statusCode)) invalidateOrigin(origin);
      if (error.statusCode) throw error;
      // 不向日志或客户端透传上游响应、游标或网络环境信息。
      throw Object.assign(upstreamError("神算子公开接口连接失败或超时，请稍后刷新"), { transport: true });
    }
  };
}

async function collect(options = {}) {
  if (options.weekIndex !== undefined && (!Number.isSafeInteger(options.weekIndex) || options.weekIndex < 1 || options.weekIndex > 52)) {
    throw Object.assign(new Error("周次无效"), { statusCode: 400 });
  }
  const now = options.now || Date.now;
  const startedAt = now();
  const request = createRequester(options);
  const config = await request("query", {});
  const period = { startMs: config.seasonStartTime, endMs: config.seasonEndTime };
  if (!validPeriod(period)) throw upstreamError("神算子赛季时间信息异常，已保留上次数据");
  const weeks = normalizeWeeks(config.weekInfos);
  const week = selectWeek(weeks, startedAt, options.weekIndex);
  async function board(kind) {
    const payload = kind === "weekly" ? { weekIndex: week.weekIndex } : {};
    const endpoint = `leaderboard/${kind}`;
    const rawHead = await request(endpoint, { ...payload, cursor: null });
    const head = normalizePage(rawHead);
    if (head.rows.length && head.rows[0].rank !== 1) throw upstreamError("神算子榜单起始名次异常");
    const tiers = rewardTiers(rawHead.rewardConfig);
    const targets = tiers.map(tier => tier.rankTo);
    const found = new Map(head.rows.map(row => [row.rank, row]));
    let sequential = false;

    if (head.hasMore) {
      for (const target of targets.filter(rank => !found.has(rank))) {
        const cursor = seekCursor(head.nextCursor, target);
        if (!cursor) { sequential = true; break; }
        // 定位仅为优化；协议或窗口校验不通过时，改走官方 nextCursor。
        let raw;
        try { raw = await request(endpoint, { ...payload, cursor }); }
        catch (error) {
          if (!error.protocolChange) throw error;
          sequential = true;
          break;
        }
        let window;
        try { window = normalizePage(raw); }
        catch (_) { sequential = true; break; }
        const row = window.rows.find(entry => entry.rank === target);
        if (!row) { sequential = true; break; }
        found.set(target, row);
      }
    }

    const ordered = [...found.values()].sort((a, b) => a.rank - b.rank);
    if (ordered.some((row, i) => i && comparePoints(ordered[i - 1].points, row.points) < 0)) sequential = true;
    if (sequential) {
      found.clear();
      let page = head;
      let previous = null;
      const seen = new Set();
      for (let pageIndex = 0; ; pageIndex++) {
        if ((page.rows.length && page.rows[0].rank !== (previous?.rank || 0) + 1) ||
            (previous && page.rows.length && comparePoints(previous.points, page.rows[0].points) < 0)) {
          throw upstreamError("神算子分页名次不连续，已保留上次数据");
        }
        for (const row of page.rows) if (targets.includes(row.rank)) found.set(row.rank, row);
        previous = page.rows.at(-1) || previous;
        if (!page.hasMore || targets.every(rank => found.has(rank))) break;
        if (pageIndex >= 499 || seen.has(page.nextCursor)) throw upstreamError("神算子分页重复或超出安全范围，已保留上次数据");
        seen.add(page.nextCursor);
        page = normalizePage(await request(endpoint, { ...payload, cursor: page.nextCursor }));
      }
    }
    return {
      unit: rawHead.rewardConfig.unit,
      thresholds: tiers.map(tier => ({ ...tier, points: found.get(tier.rankTo)?.points ?? null,
        estimateReward: found.get(tier.rankTo)?.estimateReward ?? null }))
    };
  }

  const season = await board("season");
  const weekly = await board("weekly");
  // 跨周过程中不把两个周次的结果合并成一次成功快照。
  if (week.status === "active" && now() >= week.endMs) throw upstreamError("采集期间已切换周次，请重新刷新");
  return { seasonId: SEASON_ID, sourceUrl: SOURCE_URL, startedAt: new Date(startedAt).toISOString(),
    collectedAt: new Date(now()).toISOString(), period, weeks, week, season, weekly };
}

// 每次只读取一页或一个搜索名次；不保存明细，不进入定时采集队列。
async function getRanks({ board, rankFrom, rankTo = rankFrom, weekIndex }, options = {}) {
  if (!["season", "weekly"].includes(board) || !Number.isSafeInteger(rankFrom) || !Number.isSafeInteger(rankTo) ||
      rankFrom < 1 || rankTo < rankFrom || rankTo > MAX_RANK || rankTo - rankFrom >= 50 ||
      (board === "weekly" && (!Number.isSafeInteger(weekIndex) || weekIndex < 1 || weekIndex > 52))) {
    throw Object.assign(new Error("榜单或名次无效，每次最多读取 50 名"), { statusCode: 400 });
  }
  const request = createRequester(options);
  const payload = board === "weekly" ? { weekIndex } : {};
  const endpoint = `leaderboard/${board}`;
  const rawHead = await request(endpoint, { ...payload, cursor: null });
  const head = normalizePage(rawHead);
  if (head.rows.length && head.rows[0].rank !== 1) throw upstreamError("神算子榜单起始名次异常");
  const tiers = rewardTiers(rawHead.rewardConfig);
  if (rankTo > tiers.at(-1).rankTo) throw Object.assign(new Error("名次超出当前奖励榜范围"), { statusCode: 400 });

  async function readPages(first) {
    let page = first;
    let previous = null;
    const rows = [];
    const seen = new Set();
    for (let pageIndex = 0; ; pageIndex++) {
      if (previous && page.rows.length && (page.rows[0].rank !== previous.rank + 1 || comparePoints(previous.points, page.rows[0].points) < 0)) {
        throw upstreamError("神算子分页名次不连续或积分顺序异常");
      }
      rows.push(...page.rows.filter(row => row.rank >= rankFrom && row.rank <= rankTo));
      previous = page.rows.at(-1) || previous;
      if (!page.hasMore || (previous && previous.rank >= rankTo)) return rows;
      if (pageIndex >= 499 || seen.has(page.nextCursor)) throw upstreamError("神算子分页重复或超出安全范围");
      seen.add(page.nextCursor);
      page = normalizePage(await request(endpoint, { ...payload, cursor: page.nextCursor }));
    }
  }

  let rows;
  if (head.hasMore && head.rows.at(-1).rank < rankFrom) {
    const cursor = seekCursor(head.nextCursor, rankFrom + Math.floor((rankTo - rankFrom) / 2));
    if (cursor) {
      try {
        const page = normalizePage(await request(endpoint, { ...payload, cursor }));
        if (page.rows.some(row => row.rank === rankFrom) && comparePoints(head.rows.at(-1).points, page.rows[0].points) >= 0) {
          rows = await readPages(page);
        }
      } catch (error) {
        // 网络故障和限流不重试；只有定位协议/窗口问题才回退官方顺序分页。
        if (error.transport || error.statusCode !== 502) throw error;
      }
    }
  }
  if (!rows) rows = await readPages(head);
  return { seasonId: SEASON_ID, board, ...(board === "weekly" ? { weekIndex } : {}), rankFrom, rankTo,
    unit: rawHead.rewardConfig.unit, collectedAt: new Date((options.now || Date.now)()).toISOString(), rows };
}

module.exports = { collect, getRanks, comparePoints, selectWeek, getActivity, SEASON_ID, SOURCE_URL };
