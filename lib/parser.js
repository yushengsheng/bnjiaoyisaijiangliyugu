const ALLOWED_HOSTS = new Set(["www.binance.com", "binance.com", "app.binance.com", "www.icnguxncf.com", "icnguxncf.com"]);

function parseArticleCode(input) {
  if (!input) return "";
  const match = String(input).trim().match(/(?:detail\/)?([a-f0-9]{32})(?:[/?#]|$)/i);
  return match ? match[1] : "";
}

function getNodeText(node) {
  if (!node) return "";
  if (node.node === "text" && node.text) return String(node.text);
  return Array.isArray(node.child) ? node.child.map(getNodeText).join(" ") : "";
}

function extractAst(node, acc = { tables: [], links: [], texts: [] }) {
  if (!node) return acc;
  if (node.node === "text" && node.text) acc.texts.push(String(node.text));
  if (node.tag === "a" && node.attr?.href) acc.links.push(String(node.attr.href));
  if (node.tag === "table") {
    const rows = [];
    const visitRows = current => {
      if (!current) return;
      if (current.tag === "tr") {
        const cells = [];
        const visitCells = cell => {
          if (!cell) return;
          if (cell.tag === "td" || cell.tag === "th") cells.push(getNodeText(cell).replace(/\s+/g, " ").trim());
          else if (Array.isArray(cell.child)) cell.child.forEach(visitCells);
        };
        visitCells(current);
        if (cells.length) rows.push(cells);
      } else if (Array.isArray(current.child)) current.child.forEach(visitRows);
    };
    visitRows(node);
    if (rows.length) acc.tables.push(rows);
  }
  if (Array.isArray(node.child)) node.child.forEach(child => extractAst(child, acc));
  return acc;
}

function parseCompactNumber(numberText, suffix = "") {
  const base = Number(String(numberText || "").replace(/,/g, ""));
  if (!Number.isFinite(base)) return null;
  const multipliers = { "": 1, K: 1e3, M: 1e6, B: 1e9, 万: 1e4, 亿: 1e8 };
  const multiplier = multipliers[String(suffix || "").toUpperCase()] ?? multipliers[suffix];
  return multiplier ? base * multiplier : null;
}

function matchAmountAndToken(value, prefixPattern = "") {
  const prefixed = prefixPattern ? `(?:${prefixPattern})\\s*` : "";
  const compact = value.match(new RegExp(`${prefixed}([\\d,.]+)([KMB万亿])\\s+([A-Z][A-Z0-9]{1,15})`, "i"));
  if (compact) return { amount: parseCompactNumber(compact[1], compact[2]), token: compact[3].toUpperCase() };
  const normal = value.match(new RegExp(`${prefixed}([\\d,.]+)\\s*([A-Z][A-Z0-9]{1,15})`, "i"));
  return normal ? { amount: parseCompactNumber(normal[1]), token: normal[2].toUpperCase() } : null;
}

function parseRewardValue(text) {
  const value = String(text || "").replace(/\s+/g, " ");
  const split = matchAmountAndToken(value, "equal\\s+split(?:\\s+of)?|均分|平分|共同瓜分|瓜分");
  if (split) return { ...split, isSplit: true };
  const direct = matchAmountAndToken(value);
  if (direct) return { ...direct, isSplit: false };
  return { amount: null, token: "", isSplit: false };
}

function parseRankSpan(rankText) {
  const clean = String(rankText || "").toLowerCase()
    .replace(/,/g, "")
    .replace(/[第名位]/g, "")
    .replace(/places?|rankings?|rank|名次/g, "")
    .trim();
  const range = clean.match(/(\d+)(?:st|nd|rd|th)?\s*[-–—至到~]\s*(\d+)(?:st|nd|rd|th)?/);
  if (range) {
    const from = Number(range[1]);
    const to = Number(range[2]);
    return from >= 1 && to >= from ? { from, to, count: to - from + 1 } : null;
  }
  const single = clean.match(/^(\d+)(?:st|nd|rd|th)?$/);
  if (!single) return null;
  const rank = Number(single[1]);
  return rank >= 1 ? { from: rank, to: rank, count: 1 } : null;
}

function parseAnnouncementPeriod(text) {
  const fullText = String(text || "");
  const chinese = fullText.match(/(\d{4})年(\d{1,2})月(\d{1,2})日\s*(\d{1,2}:\d{2})(?::\d{2})?\s*(?:至|到|[-–—])\s*(\d{4})年(\d{1,2})月(\d{1,2})日\s*(\d{1,2}:\d{2})(?::\d{2})?/i);
  if (chinese) {
    const [, y1, m1, d1, t1, y2, m2, d2, t2] = chinese;
    const nearby = fullText.slice(Math.max(0, chinese.index - 20), chinese.index + chinese[0].length + 50);
    const isUtc = /\bUTC\b(?!\s*\+?8)/i.test(nearby);
    const hasExplicitTimezone = isUtc || /东八区|北京时间|UTC\s*\+?8/i.test(nearby);
    return periodResult(y1, m1, d1, t1, y2, m2, d2, t2, isUtc ? "Z" : "+08:00", !hasExplicitTimezone);
  }

  const international = fullText.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\s+(\d{1,2}:\d{2})(?::\d{2})?\s*(?:\(UTC\))?\s*(?:to|至|到|[-–—])\s*(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\s+(\d{1,2}:\d{2})(?::\d{2})?\s*(?:\(UTC\))?/i);
  if (international) {
    const [, y1, m1, d1, t1, y2, m2, d2, t2] = international;
    const hasExplicitTimezone = /UTC/i.test(international[0]);
    return periodResult(y1, m1, d1, t1, y2, m2, d2, t2, hasExplicitTimezone ? "Z" : "+08:00", !hasExplicitTimezone);
  }
  return { startTime: null, endTime: null, periodStr: "时间待确认" };
}

function periodResult(y1, m1, d1, t1, y2, m2, d2, t2, timezone, timezoneInferred = false) {
  const pad = value => String(value).padStart(2, "0");
  const start = new Date(`${y1}-${pad(m1)}-${pad(d1)}T${pad(t1.split(":")[0])}:${t1.split(":")[1]}:00${timezone}`);
  const end = new Date(`${y2}-${pad(m2)}-${pad(d2)}T${pad(t2.split(":")[0])}:${t2.split(":")[1]}:00${timezone}`);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return { startTime: null, endTime: null, periodStr: "时间待确认" };
  return {
    startTime: start.toISOString(),
    endTime: end.toISOString(),
    periodStr: `${pad(m1)}/${pad(d1)} 至 ${pad(m2)}/${pad(d2)}`,
    timezoneInferred
  };
}

function validateLeaderboardUrl(input) {
  let parsed;
  try {
    parsed = new URL(String(input));
  } catch (_) {
    throw new Error("请输入完整的币安活动链接");
  }
  if (parsed.protocol !== "https:") throw new Error("活动链接必须使用 HTTPS");
  if (!ALLOWED_HOSTS.has(parsed.hostname.toLowerCase())) throw new Error("仅支持币安官方域名或指定镜像域名");
  if (parsed.port && parsed.port !== "443") throw new Error("活动链接端口无效");
  if (!/\/activity\/trading-competition\//i.test(parsed.pathname)) throw new Error("链接不是币安交易赛活动页面");
  parsed.username = "";
  parsed.password = "";
  return parsed;
}

function normalizeLeaderboardUrl(input) {
  const parsed = validateLeaderboardUrl(input);
  parsed.hostname = "www.icnguxncf.com";
  parsed.pathname = parsed.pathname.replace(/\/$/, "").replace(/\/Main-Reward$/i, "");
  const match = parsed.pathname.match(/\/activity\/trading-competition\/(.+)$/i);
  const activitySegments = match ? match[1].split("/").filter(Boolean) : [];
  if (activitySegments.length === 1) parsed.pathname += "/Main-Reward";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

function extractCampaignMetaFromUrl(input) {
  const parsed = validateLeaderboardUrl(input);
  const match = parsed.pathname.replace(/\/Main-Reward\/?$/i, "").match(/\/activity\/trading-competition\/(.+)$/i);
  const segments = match ? match[1].split("/").filter(Boolean) : [];
  const mainId = segments[0] || "";
  const subId = segments[1] || "";
  if (!mainId || !/^[A-Za-z0-9._-]+$/.test(mainId) || (subId && !/^[A-Za-z0-9._-]+$/.test(subId))) {
    throw new Error("无法识别活动 ID");
  }
  const campaignId = subId ? `${mainId}-${subId}` : mainId;
  let token = "";
  const wave = mainId.match(/wave-([A-Za-z0-9]+)/i);
  if (wave) token = wave[1].replace(/\d+$/, "").toUpperCase();
  if (!token && /tradersleague|league/i.test(mainId)) token = "SPOT";
  return { mainId, subId, campaignId, token, pathSegments: segments };
}

function extractPairs(text) {
  const result = [];
  const regex = /\b([A-Z0-9]{1,20})\/(USDT|USDC|FDUSD|BTC|BNB|ETH)\b/g;
  let match;
  while ((match = regex.exec(String(text))) !== null) {
    const pair = `${match[1].toUpperCase()}/${match[2].toUpperCase()}`;
    if (!result.includes(pair)) result.push(pair);
  }
  return result;
}

function extractPairMultipliers(text) {
  const source = String(text || "").replace(/\s+/g, " ");
  const statement = source.match(/符合条件的指定交易对[\s\S]{0,2000}?用户在以下指定现货交易对[\s\S]{0,500}?按\s*([\d.]+)\s*倍/i)
    || source.match(/用户在以下指定现货交易对[\s\S]{0,1500}?按\s*([\d.]+)\s*倍/i);
  if (!statement) return {};
  const multiplier = Number(statement[1]);
  if (!Number.isFinite(multiplier) || multiplier <= 0 || multiplier > 10) return {};
  const statementText = source.slice(statement.index, statement.index + 2500).split(/如何参加|活动期间/i)[0];
  return Object.fromEntries(extractPairs(statementText).map(pair => [pair, multiplier]));
}

function extractMinimumVolume(text) {
  const patterns = [
    /(?:累计交易|交易量|trade)\s*(?:至少|不低于|at least)?\s*([\d,.]+)([KMB万亿]?)\s*(?:美元|USD|USDT|USDC)/i,
    /(?:minimum|min\.?)\s*(?:trading\s*)?volume[^\d]{0,20}([\d,.]+)([KMB万亿]?)\s*(?:USD|USDT|USDC)/i
  ];
  for (const pattern of patterns) {
    const match = String(text).match(pattern);
    if (match) {
      const value = parseCompactNumber(match[1], match[2]);
      if (Number.isFinite(value) && value >= 0) return value;
    }
  }
  return null;
}

function parseRewardTable(table) {
  const tiers = [];
  let otherReward = null;
  for (const row of table || []) {
    if (row.length < 2) continue;
    const rankCell = String(row[0]).trim();
    const rewardCell = row.slice(1).join(" ").trim();
    const isTail = /all\s+(?:remaining|other)|remaining eligible|其他符合资格|其余符合资格|其他参与者|按交易量占比/i.test(rankCell);
    if (isTail) {
      const split = parseRewardValue(rewardCell);
      const cap = rewardCell.match(/(?:capped\s+at|上限(?:为|是)?|最高)\s*([\d,.]+)\s*([A-Z0-9]+)/i);
      if (split.amount !== null) {
        otherReward = {
          pool: split.amount,
          token: split.token,
          capPerUser: cap ? Number(cap[1].replace(/,/g, "")) : null,
          cutoffRank: tiers.reduce((max, tier) => Math.max(max, tier.rankTo), 0)
        };
      }
      continue;
    }

    const span = parseRankSpan(rankCell);
    if (!span) continue;
    const reward = parseRewardValue(rewardCell);
    if (reward.amount === null || !reward.token) continue;
    const rewardPerUser = reward.isSplit ? reward.amount / span.count : reward.amount;
    tiers.push({
      name: span.from === span.to ? `第 ${span.from} 名` : `第 ${span.from}–${span.to} 名`,
      rankFrom: span.from,
      rankTo: span.to,
      cutoffRank: span.to,
      rewardPerUser: Number(rewardPerUser.toFixed(8)),
      rewardToken: reward.token,
      userCount: span.count,
      totalTierReward: Number((reward.isSplit ? reward.amount : reward.amount * span.count).toFixed(8))
    });
  }
  if (otherReward) otherReward.cutoffRank = tiers.reduce((max, tier) => Math.max(max, tier.rankTo), 0);
  return { tiers, otherReward };
}

function countTimedBonusRounds(tables, campaignPeriod) {
  if (!campaignPeriod?.startTime || !campaignPeriod?.endTime) return 0;
  const campaignStart = Date.parse(campaignPeriod.startTime);
  const campaignEnd = Date.parse(campaignPeriod.endTime);
  let best = 0;
  for (const table of tables || []) {
    const heading = String(table?.[0]?.join(" ") || "");
    if (!/限时奖池|冲刺|sprint|limited/i.test(heading)) continue;
    let count = 0;
    for (const row of table || []) {
      const period = parseAnnouncementPeriod(row.join(" "));
      const start = Date.parse(period.startTime);
      if (Number.isFinite(start) && start >= campaignStart && start < campaignEnd) count++;
    }
    best = Math.max(best, count);
  }
  return best;
}

function parseBonusRewardTables(tables, selectedTable, requestedSubTrack = "", campaignPeriod = null) {
  const bonuses = [];
  for (const table of tables || []) {
    if (table === selectedTable) continue;
    const details = [];
    let roundCount = 0;
    let totalReward = 0;
    let token = "";
    for (const row of table || []) {
      const span = parseRankSpan(row[0]);
      if (!span) continue;
      const rewards = row.slice(1).map(parseRewardValue).filter(item => item.amount !== null && item.token);
      if (rewards.length < 2) continue;
      roundCount = Math.max(roundCount, rewards.length);
      if (!token) token = rewards[0].token;
      if (rewards.some(item => item.token !== token)) continue;
      const allocated = rewards.reduce((sum, reward) => sum + (reward.isSplit ? reward.amount : reward.amount * span.count), 0);
      totalReward += allocated;
      details.push({
        name: span.from === span.to ? `第 ${span.from} 名` : `第 ${span.from}–${span.to} 名`,
        rankFrom: span.from,
        rankTo: span.to,
        rewardsPerRound: rewards.map(reward => reward.isSplit ? reward.amount / span.count : reward.amount),
        rewardToken: token
      });
    }
    if (roundCount >= 2 && details.length) {
      bonuses.push({
        name: `分轮排名奖励（${roundCount} 轮）`,
        roundCount,
        totalReward: Number(totalReward.toFixed(8)),
        rewardToken: token,
        details
      });
    }
  }
  if (!bonuses.length && /Spot-Carnival-Waves-Round\d+/i.test(requestedSubTrack)) {
    const mainToken = parseRewardTable(selectedTable).tiers[0]?.rewardToken || "";
    const sprintTable = (tables || []).map(table => ({ table, parsed: parseRewardTable(table) })).find(item => {
      if (item.table === selectedTable || item.parsed.otherReward || item.parsed.tiers.length < 2) return false;
      const sorted = [...item.parsed.tiers].sort((a, b) => a.rankFrom - b.rankFrom);
      const continuous = sorted[0]?.rankFrom === 1 && sorted.every((tier, index) => index === 0 || tier.rankFrom === sorted[index - 1].rankTo + 1);
      const token = sorted[0]?.rewardToken || "";
      return continuous && sorted.at(-1).rankTo <= 20 && (!mainToken || token === mainToken);
    });
    const roundCount = countTimedBonusRounds(tables, campaignPeriod);
    if (sprintTable && roundCount > 0) {
      const perRoundTotal = sprintTable.parsed.tiers.reduce((sum, tier) => sum + (tier.totalTierReward || 0), 0);
      bonuses.push({
        name: `限时冲刺奖励（${roundCount} 轮）`,
        roundCount,
        totalReward: Number((perRoundTotal * roundCount).toFixed(8)),
        rewardToken: sprintTable.parsed.tiers[0].rewardToken,
        details: sprintTable.parsed.tiers.map(tier => ({
          name: tier.name,
          rankFrom: tier.rankFrom,
          rankTo: tier.rankTo,
          rewardsPerRound: Array(roundCount).fill(tier.rewardPerUser),
          rewardToken: tier.rewardToken
        }))
      });
    }
  }
  return bonuses;
}

function selectRewardStructure(tables) {
  const candidates = (tables || []).map(table => ({ table, ...parseRewardTable(table) }));
  const score = candidate => {
    const sorted = [...candidate.tiers].sort((a, b) => a.rankFrom - b.rankFrom);
    const startsAtOne = sorted[0]?.rankFrom === 1;
    const continuous = startsAtOne && sorted.every((tier, index) => index === 0 || tier.rankFrom === sorted[index - 1].rankTo + 1);
    const maxRank = sorted.at(-1)?.rankTo || 0;
    const tailMatches = candidate.otherReward?.cutoffRank === maxRank;
    return candidate.tiers.length * 10 + maxRank / 1000 + (continuous ? 25 : 0) + (candidate.otherReward ? 30 : 0) + (tailMatches ? 20 : 0);
  };
  candidates.sort((a, b) => score(b) - score(a));
  return candidates[0] || { tiers: [], otherReward: null };
}

function parseRewardPool(title, text, tierToken) {
  const combined = `${title} ${text}`.replace(/\s+/g, " ");
  const combinedPool = combined.match(/(?:瓜分|share)([^。；;]{0,80}?)(?:另享|额外|additional)([^。；;]{0,80})/i);
  if (combinedPool) {
    const primary = matchAmountAndToken(combinedPool[1]);
    const additional = matchAmountAndToken(combinedPool[2]);
    if (primary && additional && primary.token === additional.token) {
      const amount = primary.amount + additional.amount;
      return { label: `${amount.toLocaleString("en-US")} ${primary.token}`, amount, token: primary.token };
    }
  }

  const prefixed = matchAmountAndToken(combined, "高达|总奖池(?:为)?|up\\s+to|total\\s+prize\\s+pool(?:\\s+of)?");
  if (prefixed) return { label: `${prefixed.amount.toLocaleString("en-US")} ${prefixed.token}`, ...prefixed };

  const trailingCompact = combined.match(/([\d,.]+)([KMB万亿])\s+([A-Z][A-Z0-9]{1,15})\s*(?:奖池|奖励|token vouchers?)/i);
  if (trailingCompact) {
    const amount = parseCompactNumber(trailingCompact[1], trailingCompact[2]);
    return { label: `${amount.toLocaleString("en-US")} ${trailingCompact[3].toUpperCase()}`, amount, token: trailingCompact[3].toUpperCase() };
  }
  const trailing = combined.match(/([\d,.]+)\s+([A-Z][A-Z0-9]{1,15})\s*(?:奖池|奖励|token vouchers?)/i);
  if (trailing) {
    const amount = parseCompactNumber(trailing[1]);
    return { label: `${amount.toLocaleString("en-US")} ${trailing[2].toUpperCase()}`, amount, token: trailing[2].toUpperCase() };
  }
  return { label: "", amount: null, token: tierToken || "" };
}

function normalizeOfficialLinkPlaceholder(link) {
  return String(link || "")
    .replace(/&amp;/gi, "&")
    .replace(/%suffixOrigin%/gi, "binance.com")
    .replace(/%origin%/gi, "https://www.binance.com")
    .replace(/\/%locale%/gi, "/zh-CN")
    .replace("https://app.binance.com", "https://www.binance.com");
}

function findLandingLink(links) {
  for (const rawLink of links || []) {
    const link = normalizeOfficialLinkPlaceholder(rawLink);
    try {
      if (/\/activity\/trading-competition\//i.test(new URL(link).pathname)) return link;
    } catch (_) {}
  }
  return "";
}

function selectSubTrackPeriodText(fullText, requestedSubTrack) {
  const round = Number(String(requestedSubTrack || "").match(/Round(\d+)/i)?.[1]);
  const labels = ["", "第一期", "第二期", "第三期", "第四期"];
  const label = labels[round];
  if (!label) return fullText;
  const spotStart = fullText.search(/全球现货单人赛|global spot individual/i);
  const section = spotStart >= 0 ? fullText.slice(spotStart, spotStart + 3500) : fullText;
  const markerIndex = section.search(new RegExp(`${label}活动时间[：:]?`, "i"));
  return markerIndex >= 0 ? section.slice(markerIndex, markerIndex + 400) : fullText;
}

function parseAnnouncement(articleData, requestedSubTrack = "") {
  if (!articleData) throw new Error("公告数据为空");
  const title = String(articleData.title || "").trim();
  let body;
  try {
    body = typeof articleData.body === "string" ? JSON.parse(articleData.body) : articleData.body;
  } catch (_) {
    body = { node: "text", text: String(articleData.body || "") };
  }
  const ast = extractAst(body);
  const fullText = ast.texts.join(" ").replace(/\s+/g, " ");
  let sourceLanding = findLandingLink(ast.links);
  if (sourceLanding && requestedSubTrack) {
    const parsed = new URL(sourceLanding);
    const meta = extractCampaignMetaFromUrl(sourceLanding);
    parsed.pathname = parsed.pathname.replace(new RegExp(`${meta.mainId}.*$`), `${meta.mainId}/${requestedSubTrack}`);
    sourceLanding = parsed.toString();
  }

  let meta = null;
  if (sourceLanding) {
    try { meta = extractCampaignMetaFromUrl(sourceLanding); } catch (_) {}
  }
  if (!meta) {
    const code = parseArticleCode(articleData.code || articleData.articleCode || "") || "unknown";
    meta = { mainId: `announcement-${code}`, subId: "", campaignId: `announcement-${code}`, token: "" };
  }

  let pairs = extractPairs(fullText);
  const isTradersLeague = /交易者联赛|traders\s*league/i.test(`${title} ${fullText}`) || /tradersleague/i.test(meta.mainId);
  if (isTradersLeague && /Spot-Carnival-Waves-Round\d+/i.test(requestedSubTrack)) {
    const pairSection = fullText.match(/符合条件的交易对[\s\S]{0,1800}?(?=参与者在以下|如何参与|统计周期)/i)?.[0]
      || fullText.match(/指定现货交易对[\s\S]{0,1800}?(?=参与者在以下|如何参与|统计周期)/i)?.[0]
      || fullText;
    pairs = extractPairs(pairSection);
  }
  const pairMultipliers = isTradersLeague ? extractPairMultipliers(fullText) : {};

  const trackPeriodText = isTradersLeague && requestedSubTrack && /spot|carnival|waves/i.test(requestedSubTrack)
    ? selectSubTrackPeriodText(fullText, requestedSubTrack)
    : fullText;
  const period = parseAnnouncementPeriod(trackPeriodText);
  const rewardStructure = selectRewardStructure(ast.tables);
  const bonusRewards = parseBonusRewardTables(ast.tables, rewardStructure.table, requestedSubTrack, period);
  const tierToken = rewardStructure.tiers.find(tier => tier.rewardToken)?.rewardToken || rewardStructure.otherReward?.token || "";
  let pool = parseRewardPool(title, fullText, tierToken);
  if (isTradersLeague && /Spot-Carnival-Waves-Round\d+/i.test(requestedSubTrack)) {
    const mainReward = rewardStructure.tiers.reduce((sum, tier) => sum + (tier.totalTierReward || 0), 0) + (rewardStructure.otherReward?.pool || 0);
    const bonusReward = bonusRewards.reduce((sum, item) => sum + item.totalReward, 0);
    const subTrackTotal = mainReward + bonusReward;
    if (subTrackTotal > 0 && tierToken) pool = { label: `${subTrackTotal.toLocaleString("en-US")} ${tierToken}`, amount: subTrackTotal, token: tierToken };
  }
  let minVolumeUsd = extractMinimumVolume(fullText);
  if (isTradersLeague && /Spot-Carnival-Waves-Round\d+/i.test(requestedSubTrack)) {
    const overviewRow = ast.tables.flat().find(row => /全球现货单人赛|global spot individual/i.test(String(row[0] || "")));
    const minimumMatch = String(overviewRow?.[overviewRow.length - 1] || "").match(/([\d,.]+)([KMB万亿]?)\s*(?:美元|USD|USDT|USDC)/i);
    const overviewMinimum = minimumMatch ? parseCompactNumber(minimumMatch[1], minimumMatch[2]) : null;
    if (overviewMinimum !== null) minVolumeUsd = overviewMinimum;
  }
  let token = pairs.length === 1 ? pairs[0].split("/")[0] : meta.token;
  if (!token && pairs.length) {
    const bases = [...new Set(pairs.map(pair => pair.split("/")[0]))];
    token = bases.length === 1 ? bases[0] : "MULTI";
  }
  if (!token) token = "UNKNOWN";

  const reviewReasons = [];
  if (!sourceLanding) reviewReasons.push("未找到活动页面链接");
  if (!period.startTime || !period.endTime) reviewReasons.push("未完整识别活动时间");
  else if (period.timezoneInferred) reviewReasons.push("活动时间未明确标注时区");
  if (!pairs.length) reviewReasons.push("未识别参赛交易对");
  if (!rewardStructure.tiers.length) reviewReasons.push("未识别阶梯奖励");
  if (!pool.label) reviewReasons.push("未识别总奖池");
  if (!rewardStructure.otherReward) reviewReasons.push("未识别后段奖励规则");
  if (isTradersLeague && /Spot-Carnival-Waves-Round\d+/i.test(requestedSubTrack) && !bonusRewards.length) reviewReasons.push("未识别限时冲刺奖励");
  const now = Date.now();
  const status = period.endTime && Date.parse(period.endTime) <= now
    ? "history"
    : period.startTime && Date.parse(period.startTime) > now ? "upcoming" : "active";

  return {
    id: meta.campaignId,
    name: title || `${token} 交易赛`,
    market: "现货",
    token,
    rewardToken: pool.token || tierToken,
    rewardPool: pool.label,
    rewardPoolAmount: pool.amount,
    period: period.periodStr,
    startTime: period.startTime,
    endTime: period.endTime,
    status,
    articleCode: parseArticleCode(articleData.code || articleData.articleCode || ""),
    landingUrl: sourceLanding ? normalizeLeaderboardUrl(sourceLanding) : "",
    pairs,
    pairMultipliers,
    minVolumeUsd: minVolumeUsd ?? 0,
    tiers: rewardStructure.tiers,
    otherReward: rewardStructure.otherReward,
    bonusRewards,
    cutoffLabel: rewardStructure.otherReward ? `第 ${rewardStructure.otherReward.cutoffRank} 名门槛` : "排名门槛待确认",
    needsReview: reviewReasons.length > 0,
    reviewReasons,
    updatedAt: new Date().toISOString()
  };
}

async function createCampaignFromLeaderboardUrl(leaderboardUrl) {
  const normalizedUrl = normalizeLeaderboardUrl(leaderboardUrl);
  const meta = extractCampaignMetaFromUrl(normalizedUrl);
  const binanceApi = require("./binance-api");
  let parsed = null;
  try {
    const articles = await binanceApi.getAnnouncementList(93, 1, 40);
    const competitionArticles = articles.filter(article => /联赛|league|锦标赛|竞赛|tournament|competition|瓜分|carnival|单人赛/i.test(article.title || ""));
    const tokenPattern = meta.token && meta.token !== "SPOT"
      ? new RegExp(`(^|[^A-Z0-9])${meta.token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Z0-9]|$)`, "i")
      : null;
    const candidates = [...competitionArticles].sort((a, b) => {
      const score = article => {
        const title = String(article.title || "");
        return (/tradersleague|league/i.test(meta.mainId) && /交易者联赛|traders\s*league/i.test(title) ? 100 : 0) +
          (tokenPattern?.test(title) ? 50 : 0);
      };
      return score(b) - score(a);
    });
    const escapedMainId = meta.mainId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const exactActivityPattern = new RegExp(`(?:/|\\b)${escapedMainId}(?:[/\"'?#]|\\b)`, "i");
    for (const article of candidates.slice(0, 12)) {
      try {
        const detail = await binanceApi.getAnnouncementDetail(article.code);
        const rawBody = typeof detail.body === "string" ? detail.body : JSON.stringify(detail.body);
        if (!exactActivityPattern.test(rawBody)) continue;
        parsed = parseAnnouncement(detail, meta.subId);
        break;
      } catch (_) {}
    }
  } catch (error) {
    console.warn(`[Parser] 公告反查失败: ${error.message}`);
  }

  if (!parsed) {
    parsed = {
      id: meta.campaignId,
      name: `${meta.token || meta.campaignId} 交易赛`,
      market: "现货",
      token: meta.token || "UNKNOWN",
      rewardToken: "",
      rewardPool: "",
      rewardPoolAmount: null,
      period: "时间待确认",
      startTime: null,
      endTime: null,
      status: "needs-review",
      articleCode: "",
      landingUrl: normalizedUrl,
      pairs: [],
      minVolumeUsd: 0,
      tiers: [],
      otherReward: null,
      cutoffLabel: "排名门槛待确认",
      needsReview: true,
      reviewReasons: ["未匹配到官方公告，请人工核对规则"],
      updatedAt: new Date().toISOString()
    };
  }

  parsed.id = meta.campaignId;
  parsed.landingUrl = normalizedUrl;
  return parsed;
}

module.exports = {
  parseArticleCode,
  parseAnnouncement,
  parseAnnouncementPeriod,
  parseRewardValue,
  parseRankSpan,
  extractAst,
  extractCampaignMetaFromUrl,
  createCampaignFromLeaderboardUrl,
  validateLeaderboardUrl,
  normalizeLeaderboardUrl,
  parseRewardTable,
  parseBonusRewardTables,
  countTimedBonusRounds,
  selectRewardStructure,
  selectSubTrackPeriodText,
  extractMinimumVolume,
  parseCompactNumber
};
