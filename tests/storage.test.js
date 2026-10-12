const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { makeDataDir, sampleCampaign, sampleSnapshot } = require("./helpers");

const dataDir = makeDataDir();
process.env.EVENTLENS_DATA_DIR = dataDir;
const storage = require("../lib/storage");

test("并发写活动通过串行原子队列不会丢失记录", async () => {
  await Promise.all(Array.from({ length: 20 }, (_, index) => storage.upsertCampaign(sampleCampaign({
    id: `campaign-${index}`,
    articleCode: `article-${index}`,
    token: `T${index}`,
    name: `Campaign ${index}`,
    landingUrl: `https://www.icnguxncf.com/activity/trading-competition/test-wave-T${index}-R1/Main-Reward`
  }))));
  const campaigns = await storage.getCampaigns();
  assert.equal(campaigns.length, 21);
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(dataDir, "campaigns.json"), "utf8")));
  assert.equal(fs.readdirSync(dataDir).some(name => name.endsWith(".tmp")), false);
});

test("活动 ID 使用大小写精确匹配", async () => {
  await storage.upsertCampaign(sampleCampaign({ id: "SAHARA", articleCode: "upper", token: "SAHARA", name: "Upper", landingUrl: "https://www.icnguxncf.com/activity/trading-competition/test-wave-SAHARA-R1/Main-Reward" }));
  await storage.upsertCampaign(sampleCampaign({ id: "sahara", articleCode: "lower", token: "SAHARA2", name: "Lower", landingUrl: "https://www.icnguxncf.com/activity/trading-competition/test-wave-SAHARA2-R1/Main-Reward" }));
  assert.equal((await storage.getCampaignById("SAHARA")).name, "Upper");
  assert.equal((await storage.getCampaignById("sahara")).name, "Lower");
  assert.equal(await storage.getCampaignById("SaHaRa"), null);
});

test("同一公告代码的多个子赛道按活动 ID 独立保存", async () => {
  const articleCode = "shared-league-article";
  await storage.upsertCampaign(sampleCampaign({ id: "league-round-1", articleCode, name: "Round 1" }));
  await storage.upsertCampaign(sampleCampaign({ id: "league-round-2", articleCode, name: "Round 2" }));
  assert.equal((await storage.getCampaignById("league-round-1")).name, "Round 1");
  assert.equal((await storage.getCampaignById("league-round-2")).name, "Round 2");
});

test("二次录入的空规则不会清空已核对活动配置", async () => {
  const id = "preserve-verified-rules";
  await storage.upsertCampaign(sampleCampaign({
    id,
    pairMultipliers: { "SAMPLE/USDT": 1.2 },
    bonusRewards: [{ name: "冲刺奖励", roundCount: 2, totalReward: 80, rewardToken: "BNB", details: [] }]
  }));
  await storage.upsertCampaign(sampleCampaign({
    id,
    pairs: [],
    pairMultipliers: {},
    tiers: [],
    otherReward: null,
    bonusRewards: [],
    rewardPool: "",
    rewardPoolAmount: null,
    needsReview: true,
    reviewReasons: ["重新解析失败"]
  }));
  const saved = await storage.getCampaignById(id);
  assert.deepEqual(saved.pairs, ["SAMPLE/USDT", "SAMPLE/USDC"]);
  assert.deepEqual(saved.pairMultipliers, { "SAMPLE/USDT": 1.2 });
  assert.equal(saved.tiers.length, 2);
  assert.equal(saved.otherReward.pool, 80);
  assert.equal(saved.bonusRewards[0].totalReward, 80);
  assert.equal(saved.rewardPool, "400 BNB");
  assert.equal(saved.needsReview, false);
});

test("已过期的待核对活动进入历史状态", () => {
  assert.equal(storage.deriveCampaignStatus({ needsReview: true, endTime: "2020-01-01T00:00:00.000Z" }, Date.now()), "history");
});

test("缺失数值保持 null，不会被 Number(null) 误转为 0", () => {
  const normalized = storage.normalizeCampaign(sampleCampaign({ rewardPoolAmount: null, otherReward: { pool: 80, token: "BNB", capPerUser: null, cutoffRank: 3 } }));
  assert.equal(normalized.rewardPoolAmount, null);
  assert.equal(normalized.otherReward.capPerUser, null);
  assert.equal(normalized.otherReward.distribution, "proportional");
  assert.equal(storage.normalizeCampaign(sampleCampaign({ otherReward: { pool: 80, token: "BNB", capPerUser: null, cutoffRank: 3, distribution: "equal" } })).otherReward.distribution, "equal");
  const snapshot = storage.normalizeSnapshot(sampleSnapshot({ cutoff1000Volume: null }));
  assert.equal(snapshot.cutoff1000Volume, null);
});

test("排行榜自动更新开关保存后可再次读取", async () => {
  assert.equal((await storage.getSchedulerSettings()).autoUpdateEnabled, true);
  await storage.saveSchedulerSettings({ autoUpdateEnabled: false });
  assert.equal((await storage.getSchedulerSettings()).autoUpdateEnabled, false);
  await storage.saveSchedulerSettings({ autoUpdateEnabled: true });
  assert.equal((await storage.getSchedulerSettings()).autoUpdateEnabled, true);
});

test("删除活动同时删除最新快照和历史", async () => {
  const campaign = sampleCampaign({ id: "delete-me", articleCode: "delete-code", token: "DEL", landingUrl: "https://www.icnguxncf.com/activity/trading-competition/test-wave-DEL-R1/Main-Reward" });
  await storage.upsertCampaign(campaign);
  await storage.saveSnapshot("delete-me", sampleSnapshot({ collectedAt: "2026-09-12T01:00:00.000Z" }));
  const result = await storage.deleteCampaign("delete-me");
  assert.equal(result.deleted, true);
  assert.equal(await storage.getCampaignById("delete-me"), null);
  assert.equal(await storage.getSnapshot("delete-me"), null);
  assert.deepEqual(await storage.getSnapshotHistory("delete-me"), []);
});

test("首次启动并发初始化与录入不会写入失败或覆盖新活动", async () => {
  const file = path.join(dataDir, "campaigns.json");
  const original = fs.readFileSync(file);
  fs.unlinkSync(file);
  try {
    const results = await Promise.allSettled([
      ...Array.from({ length: 40 }, () => storage.getCampaigns()),
      storage.upsertCampaign(sampleCampaign({ id: "first-run-added" }))
    ]);
    assert.deepEqual(results.filter(result => result.status === "rejected").map(result => result.reason.message), []);
    assert.ok(await storage.getCampaignById("first-run-added"));
    assert.equal(fs.readdirSync(dataDir).some(name => name.endsWith(".tmp")), false);
  } finally { fs.writeFileSync(file, original); }
});

test("不支持硬链接的文件系统也能并发初始化数据", async t => {
  const file = path.join(dataDir, "settings.json");
  const original = fs.readFileSync(file);
  fs.unlinkSync(file);
  t.mock.method(require("node:fs/promises"), "link", async () => { throw Object.assign(new Error("unsupported"), { code: "ENOTSUP" }); });
  try {
    const settings = await Promise.all(Array.from({ length: 20 }, () => storage.getSchedulerSettings()));
    assert.ok(settings.every(value => value.autoUpdateEnabled));
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { autoUpdateEnabled: true });
    assert.equal(fs.readdirSync(dataDir).some(name => name.endsWith(".tmp")), false);
  } finally { fs.writeFileSync(file, original); }
});

test("并发更新活动的不同字段不会丢失，也不会复活已删除活动", async () => {
  await storage.upsertCampaign(sampleCampaign({ id: "update-race" }));
  await Promise.all([
    storage.updateCampaign("update-race", { name: "Updated name" }),
    storage.updateCampaign("update-race", { resourceId: 987 })
  ]);
  const updated = await storage.getCampaignById("update-race");
  assert.equal(updated.name, "Updated name");
  assert.equal(updated.resourceId, 987);
  const results = await Promise.allSettled([
    storage.deleteCampaign("update-race"),
    storage.updateCampaign("update-race", { resourceId: 999 }),
    storage.saveSnapshot("update-race", sampleSnapshot())
  ]);
  assert.equal(results[1].value, null);
  assert.equal(results[2].status, "rejected");
  assert.match(results[2].reason.message, /未找到活动/);
  assert.equal(await storage.getCampaignById("update-race"), null);
  assert.equal(await storage.getSnapshot("update-race"), null);
  assert.deepEqual(await storage.getSnapshotHistory("update-race"), []);
});

test("快照人数必须是整数且与完整性元数据一致", () => {
  assert.throws(() => storage.normalizeSnapshot(sampleSnapshot({ integrity: { complete: true, expectedRecords: 1, actualRecords: 1 } })), /人数|完整性/);
  assert.throws(() => storage.normalizeSnapshot(sampleSnapshot({ eligibleUserCount: 5.5, otherEligibleUserCount: 2.5 })), /人数|字段无效/);
});

test("损坏 JSON 会保留备份并停止覆盖", async () => {
  fs.writeFileSync(path.join(dataDir, "campaigns.json"), "{broken");
  await assert.rejects(() => storage.getCampaigns(), /数据文件损坏，已保留备份/);
  const backups = fs.readdirSync(dataDir).filter(name => name.startsWith("campaigns.json.corrupt-"));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(dataDir, backups[0]), "utf8"), "{broken");
  assert.equal(fs.readFileSync(path.join(dataDir, "campaigns.json"), "utf8"), "{broken");
});
