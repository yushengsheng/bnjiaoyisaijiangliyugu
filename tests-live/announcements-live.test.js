const test = require("node:test");
const assert = require("node:assert/strict");
const { makeDataDir } = require("../tests/helpers");
process.env.EVENTLENS_DATA_DIR = makeDataDir({ campaigns: [], snapshots: {}, history: {} });
const api = require("../lib/binance-api");
const { parseAnnouncement } = require("../lib/parser");
const { crawlLeaderboard } = require("../lib/crawler");
const storage = require("../lib/storage");
const { computeRankingMetrics } = require("../lib/ranking");

test("通过 bsmkweb.cc 导航获取真实公告列表和详情", { timeout: 180000 }, async t => {
  const articles = await api.getAnnouncementList(93, 1, 20);
  assert.ok(articles.length > 0, "公告列表为空");
  assert.match(articles[0].code, /^[a-f0-9]{32}$/i);
  t.diagnostic(`公告列表读取成功，共 ${articles.length} 条`);
  const detail = await api.getAnnouncementDetail(articles[0].code);
  assert.ok(detail.title, "公告详情缺少标题");
  assert.ok(detail.body, "公告详情缺少正文");
  t.diagnostic("公告详情读取成功");
});

test("旧域名活动通过 bsmkweb.cc 自动适配新域名并完整抓榜", { timeout: 240000 }, async t => {
  const articles = await api.getAnnouncementList(93, 1, 20);
  const article = articles.find(item => /交易赛|交易大赛|交易锦标赛|trading.*competition/i.test(item.title));
  assert.ok(article, "近期公告中没有可测试的交易赛");
  const campaign = parseAnnouncement(await api.getAnnouncementDetail(article.code));
  assert.ok(campaign.landingUrl, "公告未包含具体活动路径");
  const oldUrl = new URL(campaign.landingUrl);
  oldUrl.hostname = "www.retired-eventlens-mirror.com";
  campaign.landingUrl = oldUrl.href;
  const snapshot = await crawlLeaderboard(campaign, (percent, message) => t.diagnostic(`${percent}% ${message}`));
  assert.equal(snapshot.integrity.complete, true);
  assert.equal(snapshot.integrity.actualRecords, snapshot.integrity.expectedRecords);
  assert.ok(snapshot.eligibleUserCount > 0);
  assert.equal(snapshot.rankEntries.length, Math.min(1000, snapshot.eligibleUserCount));
  assert.doesNotMatch(JSON.stringify(snapshot.rankEntries), /userId|optInId|nickname/);
  await storage.upsertCampaign(campaign);
  await storage.saveSnapshot(campaign.id, snapshot);
  const saved = await storage.getSnapshot(campaign.id);
  const ranking = computeRankingMetrics(campaign, saved);
  assert.equal(ranking.rankEntriesStatus, "available");
  assert.equal(ranking.rankEntries.length, snapshot.rankEntries.length);
  assert.equal(campaign.landingUrl, oldUrl.href, "自动适配不应改写原始录入链接");
  t.diagnostic(`通过动态域名完整获取 ${snapshot.eligibleUserCount} 条记录`);
  t.diagnostic(`前 ${ranking.rankEntries.length} 名匿名明细已保存并进入奖励计算`);
});
