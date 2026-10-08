const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseAnnouncement,
  parseRewardTable,
  countTimedBonusRounds,
  extractPairMultipliers,
  extractPairMultipliersFromTables,
  selectRewardStructure,
  selectSubTrackPeriodText,
  parseAnnouncementPeriod,
  parseCompactNumber,
  extractCampaignMetaFromUrl,
  normalizeLeaderboardUrl,
  validateLeaderboardUrl,
  validateLeaderboardHost,
  createCampaignFromLeaderboardUrl
} = require("../lib/parser");
const leagueArticle = require("./fixtures/tradersleague-multi-track.json");

test("综合联赛公告按现货章节匹配两期规则，排除 bStocks 和 TradFi 奖池", () => {
  for (const [round, start] of [[1, "2026-09-09T10:00:00.000Z"], [2, "2026-09-23T10:00:00.000Z"]]) {
    const campaign = parseAnnouncement(leagueArticle, `Spot-Carnival-Waves-Round${round}`);
    assert.equal(campaign.needsReview, false, JSON.stringify(campaign.reviewReasons));
    assert.equal(campaign.rewardPoolAmount, 600);
    assert.equal(campaign.startTime, start);
    assert.equal(campaign.minVolumeUsd, 500);
    assert.equal(campaign.otherReward.pool, 120);
    assert.equal(campaign.otherReward.capPerUser, 0.08);
    assert.equal(campaign.otherReward.cutoffRank, 1000);
    assert.equal(campaign.otherReward.distribution, "proportional");
    assert.equal(campaign.bonusRewards[0].totalReward, 120);
    assert.equal(campaign.tiers.at(-1).rankTo, 1000);
  }
});

test("指定现货章节内部的多个主奖池仍须核对", () => {
  const source = structuredClone(leagueArticle);
  const nextTrack = source.body.child.findIndex(node => node.tag === "h2" && /bStocks/.test(node.child[0].text));
  const mainTable = source.body.child.find(node => node.tag === "table" && node.child.some(row => /按交易量占比瓜分120/.test(row.child[1]?.child[0]?.text || "")));
  source.body.child.splice(nextTrack, 0, structuredClone(mainTable));
  const campaign = parseAnnouncement(source, "Spot-Carnival-Waves-Round2");
  assert.equal(campaign.needsReview, true);
  assert.ok(campaign.reviewReasons.some(reason => /多个主奖池/.test(reason)));
});

test("章节缺少同活动现货链接或请求其他赛道时不能消除多主奖池歧义", () => {
  const source = structuredClone(leagueArticle);
  const replaceLinks = node => {
    if (node.tag === "a" && /Spot-Carnival/.test(node.attr.href)) node.attr.href = node.attr.href.replace("202609tradersleague4", "other-league");
    node.child?.forEach(replaceLinks);
  };
  replaceLinks(source.body);
  for (const [article, track] of [[source, "Spot-Carnival-Waves-Round2"], [leagueArticle, "bStock-Solo-Competition-Round2"], [leagueArticle, ""]]) {
    assert.ok(parseAnnouncement(article, track).reviewReasons.some(reason => /多个主奖池/.test(reason)));
  }
});

test("新镜像现货 Round2 通过公告匹配后无需人工解除奖励估算", async () => {
  const api = require("../lib/binance-api");
  const originals = [api.getAnnouncementList, api.getAnnouncementDetail];
  api.getAnnouncementList = async () => [{ code: leagueArticle.code, title: leagueArticle.title }];
  api.getAnnouncementDetail = async () => leagueArticle;
  try {
    const url = "https://www.usnbweb.red/activity/trading-competition/202609tradersleague4/Spot-Carnival-Waves-Round2";
    const campaign = await createCampaignFromLeaderboardUrl(`${url}?utm_source=anns&_dp=test`);
    assert.equal(campaign.landingUrl, url);
    assert.equal(campaign.needsReview, false);
    assert.equal(campaign.endTime, "2026-10-07T09:59:00.000Z");
    assert.equal(campaign.otherReward.pool, 120);
  } finally { [api.getAnnouncementList, api.getAnnouncementDetail] = originals; }
});

test("活动页币对表分别识别 1、1.2 和 1.5 倍，不把奖励表当倍率表", () => {
  const table = [["符合条件的交易对", "早鸟倍数"], ["BTC/USDT, ETH/USDT", "1x"], ["A/USDT, ALT/USDT", "1.2 倍"], ["HUMA/USDT, CATI/USDT", "1.5 倍"]];
  assert.deepEqual(extractPairMultipliersFromTables([table, [["排名", "奖励"], ["第1名", "18 BNB"]]]), {
    "BTC/USDT": 1, "ETH/USDT": 1, "A/USDT": 1.2, "ALT/USDT": 1.2, "HUMA/USDT": 1.5, "CATI/USDT": 1.5
  });
  for (const invalid of ["未知", "0x", "20x"]) {
    assert.deepEqual(extractPairMultipliersFromTables([[...table, ["LINEA/USDT", invalid]]]), {});
  }
  assert.deepEqual(extractPairMultipliersFromTables([table, [["Eligible trading pairs", "Multiplier"], ["A/USDT", "1.5x"]]]), {});
});

test("后段均分、按比例和未知分配方式明确区分", () => {
  for (const [text, distribution] of [
    ["An equal split of 80 BNB, capped at 0.05 BNB", "equal"],
    ["平均分配80 BNB", "equal"],
    ["A proportional share of 80 BNB, capped at 0.05 BNB", "proportional"],
    ["按交易量占比瓜分80 BNB", "proportional"],
    ["80 BNB, see special rules", "unknown"]
  ]) {
    const parsed = parseRewardTable([["1st - 1000th Places", "0.07 BNB"], ["All Remaining Eligible Participants", text]]);
    assert.equal(parsed.otherReward.distribution, distribution);
    assert.equal(parsed.otherReward.pool, 80);
    assert.equal(parsed.otherReward.cutoffRank, 1000);
  }
});

test("不限定联赛名称的中英倍数解析，不扩散到后续普通币对", () => {
  assert.deepEqual(extractPairMultipliers("交易对：HOLO/USDT 交易量按 1.2 倍计入。普通交易对：HOLO/USDC。"), { "HOLO/USDT": 1.2 });
  assert.deepEqual(extractPairMultipliers("Trading volume on A/USDT and ALT/USDT will be counted at 1.2x. Other pairs: BTC/USDT."), { "A/USDT": 1.2, "ALT/USDT": 1.2 });
  const source = article();
  const body = JSON.parse(source.body);
  body.child.push({ node: "text", text: "交易对：THE/USDT 交易量按 1.2 倍计入。" });
  assert.deepEqual(parseAnnouncement({ ...source, body }).pairMultipliers, { "THE/USDT": 1.2 });
});

test("多个主奖池或未知分配方式标记待核对，不能靠评分当作已验证", () => {
  const source = article();
  const body = JSON.parse(source.body);
  const secondMain = structuredClone(body.child.find(node => node.tag === "table"));
  body.child.push(secondMain);
  assert.equal(parseAnnouncement({ ...source, body }).needsReview, true);
  assert.ok(parseAnnouncement({ ...source, body }).reviewReasons.some(reason => /多个主奖池/.test(reason)));
  const unknown = JSON.parse(source.body);
  const table = unknown.child.find(node => node.tag === "table");
  table.child.at(-1).child[1].child[0].text = "80 BNB, see special rules";
  assert.ok(parseAnnouncement({ ...source, body: unknown }).reviewReasons.includes("未识别后段分配方式"));
});

function article({ title = "THE 现货交易锦标赛：交易瓜分高达 400 BNB 奖池", includeRules = true } = {}) {
  const children = [
    { node: "text", text: "活动时间：2026年09月10日10:00至2026年09月17日10:00（UTC） 所有完成交易量至少500 USD的用户均有资格参与。交易对：THE/USDT、THE/USDC。" },
    { tag: "a", attr: { href: "https://www.binance.com/zh-CN/activity/trading-competition/spot-altcoin-festival-wave-THE-R1?utm_source=anns" }, child: [] }
  ];
  if (includeRules) {
    children.push({
      tag: "table",
      child: [
        ["排名", "奖励"], ["第1名", "12 BNB"], ["第2-3名", "4 BNB"], ["第4-1000名", "0.2 BNB"], ["其他符合资格参与者", "瓜分80 BNB，每人上限0.05 BNB"]
      ].map(row => ({ tag: "tr", child: row.map(text => ({ tag: "td", child: [{ node: "text", text }] })) }))
    });
    children.push({
      tag: "table",
      child: [
        ["排名", "第一轮", "第二轮"], ["第1名", "12 BNB", "12 BNB"], ["第2名", "10 BNB", "10 BNB"], ["第3名", "8 BNB", "8 BNB"], ["第4名", "6 BNB", "6 BNB"], ["第5名", "4 BNB", "4 BNB"]
      ].map(row => ({ tag: "tr", child: row.map(text => ({ tag: "td", child: [{ node: "text", text }] })) }))
    });
  }
  return { title, code: "9914db97181f443a9fc3a3e3ef726996", body: JSON.stringify({ tag: "div", child: children }) };
}

test("完整公告解析真实奖池、时间、门槛、阶梯和后段上限", () => {
  const campaign = parseAnnouncement(article());
  assert.equal(campaign.rewardPoolAmount, 400);
  assert.equal(campaign.rewardToken, "BNB");
  assert.equal(campaign.minVolumeUsd, 500);
  assert.equal(campaign.otherReward.pool, 80);
  assert.equal(campaign.otherReward.capPerUser, 0.05);
  assert.equal(campaign.otherReward.cutoffRank, 1000);
  assert.deepEqual(campaign.pairs, ["THE/USDT", "THE/USDC"]);
  assert.equal(campaign.landingUrl.includes("?"), false);
  assert.equal(campaign.needsReview, false);
  assert.equal(campaign.bonusRewards.length, 1);
  assert.equal(campaign.bonusRewards[0].roundCount, 2);
  assert.equal(campaign.bonusRewards[0].totalReward, 80);
});

test("解析失败不会制造默认 400 BNB 规则", () => {
  const campaign = parseAnnouncement({ title: "一个新活动", code: "incomplete", body: JSON.stringify({ node: "text", text: "规则稍后公布" }) });
  assert.equal(campaign.rewardPoolAmount, null);
  assert.equal(campaign.rewardPool, "");
  assert.equal(campaign.tiers.length, 0);
  assert.equal(campaign.otherReward, null);
  assert.equal(campaign.needsReview, true);
});

test("活动时间未明确时区时标记为待核对", () => {
  const campaign = parseAnnouncement({
    ...article(),
    body: JSON.stringify({ tag: "div", child: [
      { node: "text", text: "活动时间：2026年09月10日10:00至2026年09月17日10:00。交易量至少500 USD。交易对：THE/USDT。" },
      { tag: "a", attr: { href: "https://www.binance.com/zh-CN/activity/trading-competition/spot-altcoin-festival-wave-THE-R1" }, child: [] }
    ] })
  });
  assert.equal(campaign.needsReview, true);
  assert.ok(campaign.reviewReasons.includes("活动时间未明确标注时区"));
});

test("金额后缀按实际数量级解析", () => {
  assert.equal(parseCompactNumber("637.06", "M"), 637_060_000);
  assert.equal(parseCompactNumber("1.2", "B"), 1_200_000_000);
  const campaign = parseAnnouncement(article({ title: "THE 活动总奖池为 1.2M USDT" }));
  assert.equal(campaign.rewardPoolAmount, 1_200_000);
  assert.equal(campaign.rewardToken, "USDT");
});

test("主奖池与额外奖池可合并且支持紧邻币种文本", () => {
  const campaign = parseAnnouncement(article({ title: "THE 活动交易瓜分400 BNB，额外80 BNB奖励" }));
  assert.equal(campaign.rewardPoolAmount, 480);
  assert.equal(campaign.rewardToken, "BNB");
});

test("第 201–1000 名只会解析为阶梯，不会误判为后段奖励", () => {
  const parsed = parseRewardTable([["第201-1000名", "0.1 BNB"]]);
  assert.equal(parsed.tiers.length, 1);
  assert.equal(parsed.tiers[0].rankFrom, 201);
  assert.equal(parsed.tiers[0].rankTo, 1000);
  assert.equal(parsed.otherReward, null);
});

test("联赛主奖励表按名次覆盖和后段结构选择，不依赖具体奖金数字", () => {
  const sprint = [["排名", "奖励"], ["第1名", "7 BNB"], ["第2名", "5 BNB"], ["第3名", "3 BNB"]];
  const main = [["排名", "奖励"], ["第1名", "17 BNB"], ["第2-20名", "均分57 BNB"], ["第21-1000名", "均分203 BNB"], ["其他符合资格参与者", "瓜分91 BNB，每人上限0.07 BNB"]];
  const selected = selectRewardStructure([sprint, main]);
  assert.equal(selected.table, main);
  assert.equal(selected.otherReward.cutoffRank, 1000);
});

test("交易者联赛 Round2 会选择第二期时间而不是沿用第一期", () => {
  const text = "全球现货单人赛 第一期活动时间：2026年09月09日18:00至2026年09月23日17:59（东八区时间） 第二期活动时间：2026年09月23日18:00至2026年10月07日17:59（东八区时间）";
  const period = parseAnnouncementPeriod(selectSubTrackPeriodText(text, "Spot-Carnival-Waves-Round2"));
  assert.equal(period.startTime, "2026-09-23T10:00:00.000Z");
  assert.equal(period.endTime, "2026-10-07T09:59:00.000Z");
});

test("跨越本期结束时间的冲刺轮按开始时间归属且不会重复计入下一期", () => {
  const tables = [[
    ["限时奖池", "活动时间"],
    ["第二轮", "2026年09月13日18:00至2026年09月17日17:59（东八区时间）"]
  ]];
  assert.equal(countTimedBonusRounds(tables, {
    startTime: "2026-09-09T10:00:00.000Z",
    endTime: "2026-09-16T10:00:00.000Z"
  }), 1);
  assert.equal(countTimedBonusRounds(tables, {
    startTime: "2026-09-16T10:00:00.000Z",
    endTime: "2026-09-23T10:00:00.000Z"
  }), 0);
});

test("明确的联赛现货 Round 未识别冲刺奖励时进入待核对", () => {
  const table = rows => ({ tag: "table", child: rows.map(row => ({ tag: "tr", child: row.map(text => ({ tag: "td", child: [{ node: "text", text }] })) })) });
  const campaign = parseAnnouncement({
    title: "币安交易者联赛第四季",
    code: "league-no-bonus",
    body: JSON.stringify({ tag: "div", child: [
      { node: "text", text: "全球现货单人赛。第一期活动时间：2026年09月09日18:00至2026年09月23日17:59（东八区时间）。交易量至少500美元。交易对：A/USDT。" },
      { tag: "a", attr: { href: "https://www.binance.com/zh-CN/activity/trading-competition/202609tradersleague4/Spot-Carnival-Waves-Round1" }, child: [] },
      table([["排名", "奖励"], ["第1名", "10 BNB"], ["第2-1000名", "均分90 BNB"], ["其他符合资格参与者", "瓜分20 BNB，每人上限0.01 BNB"]])
    ] })
  }, "Spot-Carnival-Waves-Round1");
  assert.equal(campaign.needsReview, true);
  assert.ok(campaign.reviewReasons.includes("未识别限时冲刺奖励"));
});

test("交易者联赛单轮现货子赛道按 480 BNB 主榜加两轮 120 BNB 冲刺奖励计算", () => {
  const table = rows => ({ tag: "table", child: rows.map(row => ({ tag: "tr", child: row.map(text => ({ tag: "td", child: [{ node: "text", text }] })) })) });
  const body = {
    tag: "div",
    child: [
      { node: "text", text: "活动一：全球现货单人赛。第一期活动时间：2026年09月09日18:00至2026年09月23日17:59（东八区时间）。用户累计交易至少500美元等值。符合条件的指定交易对：A/USDT、ALT/USDT。用户在以下指定现货交易对产生的有效交易量将按 1.2 倍计入活动统计。" },
      { tag: "a", attr: { href: "https://www.binance.com/zh-CN/activity/trading-competition/202609tradersleague4/Spot-Carnival-Waves-Round1" }, child: [] },
      table([["类别", "奖励池", "活动时间", "最低交易量"], ["全球现货单人赛", "1,200 BNB", "两期", "500 美元"]]),
      table([["排名", "奖励"], ["第1名", "18 BNB"], ["第2名", "15 BNB"], ["第3名", "12 BNB"], ["第4名", "9 BNB"], ["第5名", "6 BNB"], ["第6-20名", "均分60 BNB"], ["第21-50名", "均分60 BNB"], ["第51-200名", "均分96 BNB"], ["第201-1000名", "均分84 BNB"], ["其他符合资格参与者", "瓜分120 BNB，每人上限0.08 BNB"]]),
      table([["限时奖池", "活动时间"], ["第一轮", "2026年09月09日18:00至2026年09月13日17:59"], ["第二轮", "2026年09月13日18:00至2026年09月17日17:59"]]),
      table([["排名", "奖励"], ["第1名", "18 BNB"], ["第2名", "15 BNB"], ["第3名", "12 BNB"], ["第4名", "9 BNB"], ["第5名", "6 BNB"]])
    ]
  };
  const campaign = parseAnnouncement({ title: "币安交易者联赛第四季：全球现货单人赛 1,200 BNB", code: "league", body: JSON.stringify(body) }, "Spot-Carnival-Waves-Round1");
  assert.equal(campaign.rewardPoolAmount, 600);
  assert.equal(campaign.minVolumeUsd, 500);
  assert.equal(campaign.bonusRewards[0].roundCount, 2);
  assert.equal(campaign.bonusRewards[0].totalReward, 120);
  assert.deepEqual(campaign.pairMultipliers, { "A/USDT": 1.2, "ALT/USDT": 1.2 });
  assert.equal(campaign.tiers.reduce((sum, tier) => sum + tier.totalTierReward, 0) + campaign.otherReward.pool + campaign.bonusRewards[0].totalReward, 600);
});

test("排行榜 URL 使用 URL API 追加主奖池路径并移除查询参数", () => {
  const url = normalizeLeaderboardUrl("https://www.icnguxncf.com/activity/trading-competition/test-wave-TEST-R1?utm_source=anns#x");
  assert.equal(url, "https://www.icnguxncf.com/activity/trading-competition/test-wave-TEST-R1/Main-Reward");
  assert.equal(extractCampaignMetaFromUrl(url).token, "TEST");
});

test("带子赛道的交易者联赛保留子赛道入口，不错误追加 Main-Reward", () => {
  const url = normalizeLeaderboardUrl("https://www.icnguxncf.com/zh-CN/activity/trading-competition/202609tradersleague4/Spot-Carnival-Waves-Round1?utm_source=anns&_dp=test");
  assert.equal(url, "https://www.icnguxncf.com/zh-CN/activity/trading-competition/202609tradersleague4/Spot-Carnival-Waves-Round1");
  assert.equal(extractCampaignMetaFromUrl(url).subId, "Spot-Carnival-Waves-Round1");
});

test("公告反查必须由详情中的精确活动 slug 确认，不能只看同币种标题", async () => {
  const api = require("../lib/binance-api");
  const originalList = api.getAnnouncementList;
  const originalDetail = api.getAnnouncementDetail;
  api.getAnnouncementList = async () => [
    { title: "THE 交易锦标赛 Round2", code: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    { title: "THE 交易锦标赛 Round1", code: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }
  ];
  api.getAnnouncementDetail = async code => ({
    title: code.startsWith("a") ? "THE 交易锦标赛 Round2" : "THE 交易锦标赛 Round1",
    code,
    body: JSON.stringify({ tag: "div", child: [
      { node: "text", text: "活动时间：2026年09月10日10:00至2026年09月17日10:00（UTC） 交易量至少500 USD。交易对：THE/USDT。" },
      { tag: "a", attr: { href: `https://www.binance.com/zh-CN/activity/trading-competition/spot-altcoin-festival-wave-THE-${code.startsWith("a") ? "R2" : "R1"}` }, child: [] }
    ] })
  });
  try {
    const campaign = await createCampaignFromLeaderboardUrl("https://www.binance.com/zh-CN/activity/trading-competition/spot-altcoin-festival-wave-THE-R1");
    assert.equal(campaign.articleCode, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    assert.match(campaign.landingUrl, /THE-R1/);
  } finally {
    api.getAnnouncementList = originalList;
    api.getAnnouncementDetail = originalDetail;
  }
});

test("自定义活动链接保留 HTTPS、公网主机和活动路径限制", () => {
  assert.throws(() => validateLeaderboardUrl("http://www.icnguxncf.com/activity/trading-competition/x"), /HTTPS/);
  for (const host of ["127.0.0.1", "2130706433", "[::1]", "localhost", "a.local", "a.internal", "a.example"]) {
    assert.throws(() => validateLeaderboardUrl(`https://${host}/activity/trading-competition/x`), /公网域名/);
  }
  assert.throws(() => validateLeaderboardUrl("https://user:pass@www.binance.com/activity/trading-competition/x"), /用户名/);
  assert.throws(() => validateLeaderboardUrl("https://www.binance.com:8443/activity/trading-competition/x"), /端口/);
  assert.throws(() => validateLeaderboardUrl("https://www.binance.com/unrelated/activity/trading-competition/x"), /活动页面/);
  assert.throws(() => validateLeaderboardUrl("https://www.binance.com/activity/trading-competition/x/round/extra"), /活动页面/);
});

test("新镜像和未来自定义域名保留输入主机，活动ID跨域一致", () => {
  const hosts = ["www.cagxfucoftt.com", "www.future-mirror.com", "www.binance.com", "app.binance.com", "www.icnguxncf.com"];
  for (const host of hosts) {
    const input = `https://${host}/activity/trading-competition/spot-altcoin-festival-wave-REZ-R1?utm_source=test#rank`;
    const normalized = normalizeLeaderboardUrl(input);
    assert.equal(normalized, `https://${host}/activity/trading-competition/spot-altcoin-festival-wave-REZ-R1/Main-Reward`);
    assert.equal(extractCampaignMetaFromUrl(normalized).campaignId, "spot-altcoin-festival-wave-REZ-R1");
  }
  const round = "https://www.cagxfucoftt.com/zh-CN/activity/trading-competition/202609tradersleague4/Spot-Carnival-Waves-Round2";
  assert.equal(normalizeLeaderboardUrl(round), round);
  assert.equal(normalizeLeaderboardUrl(`${round}/Main-Reward`), round);
  assert.equal(extractCampaignMetaFromUrl(round).subId, "Spot-Carnival-Waves-Round2");
});

test("公网域名解析到内网时在启动浏览器前拒绝，兼容 IPv4/IPv6", async () => {
  const input = "https://www.cagxfucoftt.com/activity/trading-competition/spot-altcoin-festival-wave-REZ-R1/Main-Reward";
  for (const address of ["127.0.0.1", "10.1.2.3", "172.16.2.3", "192.168.1.1", "169.254.169.254", "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1"]) {
    await assert.rejects(validateLeaderboardHost(input, async () => [{ address }]), /内网地址/);
  }
  const resolved = await validateLeaderboardHost(input, async () => [{ address: "8.8.8.8" }, { address: "2606:4700::1111" }]);
  assert.equal(resolved.hostname, "www.cagxfucoftt.com");
  await assert.rejects(validateLeaderboardHost(input, async () => [{ address: "8.8.8.8" }, { address: "10.1.2.3" }]), /内网地址/);
});

test("新域名录入仍从官方公告匹配规则，保留输入URL且换域不重复活动", async () => {
  const api = require("../lib/binance-api");
  const originalList = api.getAnnouncementList;
  const originalDetail = api.getAnnouncementDetail;
  api.getAnnouncementList = async () => [{ code: "test-code", title: "THE 交易锦标赛" }];
  api.getAnnouncementDetail = async () => article();
  try {
    const custom = await createCampaignFromLeaderboardUrl("https://www.cagxfucoftt.com/activity/trading-competition/spot-altcoin-festival-wave-THE-R1/Main-Reward");
    const standard = await createCampaignFromLeaderboardUrl("https://www.binance.com/activity/trading-competition/spot-altcoin-festival-wave-THE-R1/Main-Reward");
    assert.equal(custom.id, standard.id);
    assert.equal(new URL(custom.landingUrl).hostname, "www.cagxfucoftt.com");
    assert.deepEqual(custom.otherReward, standard.otherReward);
    assert.equal(custom.needsReview, false);
  } finally { api.getAnnouncementList = originalList; api.getAnnouncementDetail = originalDetail; }
});

test("轮次 R8 不作为币种，兼容旧 ENSO1 活动命名", () => {
  const prefix = "https://www.binance.com/activity/trading-competition/";
  assert.equal(extractCampaignMetaFromUrl(`${prefix}spot-altcoin-trading-festival-wave-R8`).token, "");
  assert.equal(extractCampaignMetaFromUrl(`${prefix}spot-altcoin-festival-wave-ENSO1`).token, "ENSO");
});

test("短页仍继续反查旧公告，跳过相似 slug 和坏详情，第二页第13条也能命中", async () => {
  const api = require("../lib/binance-api");
  const originals = [api.getAnnouncementList, api.getAnnouncementDetail];
  const pages = [];
  const slug = "spot-altcoin-trading-festival-wave-R8";
  api.getAnnouncementList = async (_, page) => {
    pages.push(page);
    return page === 1 ? [{ code: "broken", title: "交易锦标赛" }] :
      Array.from({ length: 13 }, (_, i) => ({ code: String(i), title: "现货交易锦标赛" }));
  };
  api.getAnnouncementDetail = async code => {
    if (code === "broken") throw new Error("临时详情失败");
    const fixture = article();
    return { ...fixture, code, body: fixture.body.replaceAll("spot-altcoin-festival-wave-THE-R1", code === "12" ? slug : `${slug}-extra`) };
  };
  try {
    const campaign = await createCampaignFromLeaderboardUrl(`https://www.cagxfucoftt.com/activity/trading-competition/${slug}`);
    assert.deepEqual(pages, [1, 2]);
    assert.equal(campaign.id, slug);
    assert.equal(campaign.needsReview, false);
    assert.equal(campaign.token, "THE");
  } finally { [api.getAnnouncementList, api.getAnnouncementDetail] = originals; }
});

test("公告重复页及时停止，未找到仍保持待核对", async () => {
  const api = require("../lib/binance-api");
  const originals = [api.getAnnouncementList, api.getAnnouncementDetail];
  let pages = 0;
  api.getAnnouncementList = async () => { pages++; return [{ code: "same", title: "交易锦标赛" }]; };
  api.getAnnouncementDetail = async () => article();
  try {
    const campaign = await createCampaignFromLeaderboardUrl("https://www.binance.com/activity/trading-competition/missing");
    assert.equal(pages, 2);
    assert.equal(campaign.needsReview, true);
  } finally { [api.getAnnouncementList, api.getAnnouncementDetail] = originals; }
});
