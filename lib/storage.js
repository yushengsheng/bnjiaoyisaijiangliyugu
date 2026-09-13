const fs = require("node:fs/promises");
const path = require("node:path");

const DATA_DIR = process.env.EVENTLENS_DATA_DIR
  ? path.resolve(process.env.EVENTLENS_DATA_DIR)
  : path.join(__dirname, "..", "data");
const CAMPAIGNS_FILE = path.join(DATA_DIR, "campaigns.json");
const SNAPSHOTS_FILE = path.join(DATA_DIR, "snapshots.json");
const SNAPSHOT_HISTORY_FILE = path.join(DATA_DIR, "snapshot-history.json");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
const SEED_CAMPAIGNS_FILE = path.join(__dirname, "..", "data", "seed-campaigns.json");
const SEED_SNAPSHOTS_FILE = path.join(__dirname, "..", "data", "seed-snapshots.json");
const MAX_HISTORY_PER_CAMPAIGN = 500;

let writeQueue = Promise.resolve();
let seedCampaignsCache = null;
let seedSnapshotsCache = null;

function enqueueWrite(operation) {
  const run = writeQueue.then(operation, operation);
  writeQueue = run.catch(() => {});
  return run;
}

async function ensureDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function atomicWriteJson(file, value) {
  await ensureDir();
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const json = `${JSON.stringify(value, null, 2)}\n`;
  try {
    await fs.writeFile(tmp, json, { encoding: "utf8", mode: 0o600 });
    await fs.rename(tmp, file);
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
}

async function readSeed(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (_) {
    return structuredClone(fallback);
  }
}

async function getSeedCampaigns() {
  if (!seedCampaignsCache) seedCampaignsCache = await readSeed(SEED_CAMPAIGNS_FILE, []);
  return structuredClone(seedCampaignsCache);
}

async function getSeedSnapshots() {
  if (!seedSnapshotsCache) seedSnapshotsCache = await readSeed(SEED_SNAPSHOTS_FILE, {});
  return structuredClone(seedSnapshotsCache);
}

async function backUpCorruptFile(file) {
  const backup = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  await fs.copyFile(file, backup).catch(() => {});
  return backup;
}

async function readJson(file, fallback, { initialize = true } = {}) {
  await ensureDir();
  try {
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      const value = typeof fallback === "function" ? fallback() : structuredClone(fallback);
      if (initialize) await atomicWriteJson(file, value);
      return value;
    }
    if (error instanceof SyntaxError) {
      const backup = await backUpCorruptFile(file);
      throw new Error(`数据文件损坏，已保留备份：${backup}`);
    }
    throw error;
  }
}

function finiteNumber(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeCampaign(campaign) {
  if (!campaign || typeof campaign !== "object") throw new Error("活动数据必须是对象");
  const id = String(campaign.id || "").trim();
  const name = String(campaign.name || "").trim();
  if (!id || !/^[A-Za-z0-9._-]+$/.test(id)) throw new Error("活动 ID 无效");
  if (!name) throw new Error("活动名称不能为空");

  const pairs = Array.isArray(campaign.pairs)
    ? [...new Set(campaign.pairs.map(pair => String(pair).trim().toUpperCase()).filter(pair => /^[A-Z0-9]{1,20}\/[A-Z0-9]{2,10}$/.test(pair)))]
    : [];
  const pairMultipliers = Object.fromEntries(Object.entries(campaign.pairMultipliers || {}).flatMap(([pair, value]) => {
    const normalizedPair = String(pair).trim().toUpperCase();
    const multiplier = finiteNumber(value);
    return pairs.includes(normalizedPair) && multiplier !== null && multiplier > 0 && multiplier <= 10 ? [[normalizedPair, multiplier]] : [];
  }));
  const tiers = Array.isArray(campaign.tiers)
    ? campaign.tiers.map(tier => ({
        ...tier,
        name: String(tier.name || "").trim(),
        rankFrom: finiteNumber(tier.rankFrom),
        rankTo: finiteNumber(tier.rankTo),
        cutoffRank: finiteNumber(tier.cutoffRank),
        rewardPerUser: finiteNumber(tier.rewardPerUser),
        userCount: finiteNumber(tier.userCount),
        totalTierReward: finiteNumber(tier.totalTierReward),
        rewardToken: String(tier.rewardToken || campaign.rewardToken || "").trim().toUpperCase()
      })).filter(tier => tier.name && tier.rankFrom >= 1 && tier.rankTo >= tier.rankFrom)
    : [];

  const bonusRewards = Array.isArray(campaign.bonusRewards)
    ? campaign.bonusRewards.map(item => ({
        ...item,
        name: String(item.name || "分轮奖励").trim(),
        roundCount: Math.max(1, finiteNumber(item.roundCount, 1)),
        totalReward: Math.max(0, finiteNumber(item.totalReward, 0)),
        rewardToken: String(item.rewardToken || campaign.rewardToken || "").trim().toUpperCase(),
        details: Array.isArray(item.details) ? item.details : []
      })).filter(item => item.totalReward > 0 && item.rewardToken)
    : [];

  let otherReward = null;
  if (campaign.otherReward && typeof campaign.otherReward === "object") {
    const pool = finiteNumber(campaign.otherReward.pool);
    const cutoffRank = finiteNumber(campaign.otherReward.cutoffRank);
    const capPerUser = finiteNumber(campaign.otherReward.capPerUser);
    if (pool !== null && pool >= 0 && cutoffRank !== null && cutoffRank >= 0) {
      otherReward = {
        ...campaign.otherReward,
        pool,
        cutoffRank,
        capPerUser: capPerUser !== null && capPerUser >= 0 ? capPerUser : null,
        token: String(campaign.otherReward.token || campaign.rewardToken || "").trim().toUpperCase()
      };
    }
  }

  return {
    ...campaign,
    id,
    name,
    market: String(campaign.market || "现货"),
    token: String(campaign.token || "").trim().toUpperCase(),
    rewardToken: String(campaign.rewardToken || "").trim().toUpperCase(),
    rewardPool: String(campaign.rewardPool || "").trim(),
    rewardPoolAmount: finiteNumber(campaign.rewardPoolAmount),
    articleCode: String(campaign.articleCode || "").trim(),
    landingUrl: String(campaign.landingUrl || "").trim(),
    pairs,
    pairMultipliers,
    tiers,
    otherReward,
    bonusRewards,
    minVolumeUsd: Math.max(0, finiteNumber(campaign.minVolumeUsd, 0)),
    needsReview: Boolean(campaign.needsReview),
    updatedAt: campaign.updatedAt || new Date().toISOString()
  };
}

function deriveCampaignStatus(campaign, now = Date.now()) {
  if (campaign.status === "disabled" || campaign.status === "paused") return campaign.status;
  const start = campaign.startTime ? Date.parse(campaign.startTime) : NaN;
  const end = campaign.endTime ? Date.parse(campaign.endTime) : NaN;
  if (Number.isFinite(end) && end <= now) return "history";
  if (campaign.needsReview) return "needs-review";
  if (Number.isFinite(start) && start > now) return "upcoming";
  return "active";
}

async function getCampaigns() {
  const raw = await readJson(CAMPAIGNS_FILE, await getSeedCampaigns());
  if (!Array.isArray(raw)) throw new Error("campaigns.json 顶层必须是数组");
  return raw.map(item => {
    const normalized = normalizeCampaign(item);
    normalized.status = deriveCampaignStatus(normalized);
    return normalized;
  });
}

async function saveCampaigns(campaigns) {
  if (!Array.isArray(campaigns)) throw new Error("活动列表必须是数组");
  const normalized = campaigns.map(normalizeCampaign);
  await enqueueWrite(() => atomicWriteJson(CAMPAIGNS_FILE, normalized));
  return normalized;
}

function hasMeaningfulValue(value) {
  if (value === null || value === undefined || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  if (typeof value === "number") return value > 0;
  return true;
}

function mergeCampaignForUpsert(existing, incoming) {
  if (!existing) return incoming;
  const merged = { ...existing, ...incoming, id: existing.id };
  const stableFields = [
    "name", "market", "token", "articleCode", "rewardToken", "rewardPool", "rewardPoolAmount",
    "period", "startTime", "endTime", "landingUrl", "pairs", "pairMultipliers", "minVolumeUsd",
    "tiers", "otherReward", "bonusRewards", "cutoffLabel"
  ];
  for (const field of stableFields) {
    if (!hasMeaningfulValue(incoming[field]) && hasMeaningfulValue(existing[field])) merged[field] = existing[field];
  }
  if (Array.isArray(existing.pairs) && existing.pairs.length && Array.isArray(incoming.pairs) && incoming.pairs.length) {
    const incomingSet = new Set(incoming.pairs);
    if (!existing.pairs.every(pair => incomingSet.has(pair))) merged.pairs = [...existing.pairs];
  }
  merged.pairMultipliers = { ...(existing.pairMultipliers || {}), ...(incoming.pairMultipliers || {}) };
  if (!existing.needsReview && incoming.needsReview) {
    for (const field of stableFields) merged[field] = existing[field];
    merged.needsReview = false;
    merged.reviewReasons = existing.reviewReasons || [];
  }
  return normalizeCampaign(merged);
}

async function upsertCampaign(campaign) {
  const normalized = normalizeCampaign({ ...campaign, updatedAt: new Date().toISOString() });
  return enqueueWrite(async () => {
    const current = await readJson(CAMPAIGNS_FILE, await getSeedCampaigns());
    if (!Array.isArray(current)) throw new Error("campaigns.json 顶层必须是数组");
    const list = current.map(normalizeCampaign);
    const idx = list.findIndex(item => item.id === normalized.id);
    const saved = mergeCampaignForUpsert(idx >= 0 ? list[idx] : null, normalized);
    if (idx >= 0) list[idx] = saved;
    else list.unshift(saved);
    await atomicWriteJson(CAMPAIGNS_FILE, list);
    return saved;
  });
}

async function updateCampaign(id, patch) {
  const current = await getCampaignById(id);
  if (!current) return null;
  return upsertCampaign({ ...current, ...patch, id: current.id });
}

async function deleteCampaign(id) {
  const exactId = String(id || "").trim();
  if (!exactId) throw new Error("活动 ID 不能为空");
  return enqueueWrite(async () => {
    const campaigns = await readJson(CAMPAIGNS_FILE, await getSeedCampaigns());
    const next = campaigns.map(normalizeCampaign).filter(item => item.id !== exactId);
    if (next.length === campaigns.length) return { deleted: false, campaigns: next };

    const snapshots = await readJson(SNAPSHOTS_FILE, await getSeedSnapshots());
    for (const key of Object.keys(snapshots)) {
      if (key === exactId) delete snapshots[key];
    }
    const history = await readJson(SNAPSHOT_HISTORY_FILE, {});
    for (const key of Object.keys(history)) {
      if (key === exactId) delete history[key];
    }

    await atomicWriteJson(CAMPAIGNS_FILE, next);
    await atomicWriteJson(SNAPSHOTS_FILE, snapshots);
    await atomicWriteJson(SNAPSHOT_HISTORY_FILE, history);
    return { deleted: true, campaigns: next };
  });
}

async function getCampaignById(id) {
  const wanted = String(id || "").trim();
  if (!wanted) return null;
  const list = await getCampaigns();
  return list.find(item => item.id === wanted) || null;
}

async function getSnapshots() {
  const value = await readJson(SNAPSHOTS_FILE, await getSeedSnapshots());
  if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("snapshots.json 顶层必须是对象");
  return value;
}

function findExactKey(object, id) {
  const wanted = String(id);
  return Object.prototype.hasOwnProperty.call(object, wanted) ? wanted : null;
}

function normalizeSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") throw new Error("排行榜快照为空");
  if (snapshot.integrity?.complete !== true || snapshot.integrity.expectedRecords !== snapshot.integrity.actualRecords) {
    throw new Error("排行榜快照完整性校验失败");
  }
  const required = ["eligibleUserCount", "eligibleTradingVolume", "topRankUserCount", "topRankingTradingVolume", "otherEligibleUserCount", "otherEligibleTradingVolume"];
  const result = { ...snapshot };
  for (const key of required) {
    const n = finiteNumber(snapshot[key]);
    if (n === null || n < 0) throw new Error(`排行榜快照字段无效：${key}`);
    result[key] = n;
  }
  if (result.topRankUserCount + result.otherEligibleUserCount !== result.eligibleUserCount) {
    throw new Error("排行榜人数拆分校验失败");
  }
  const volumeDiff = Math.abs((result.topRankingTradingVolume + result.otherEligibleTradingVolume) - result.eligibleTradingVolume);
  const tolerance = Math.max(0.01, result.eligibleTradingVolume * 1e-8);
  if (volumeDiff > tolerance) throw new Error("排行榜交易量拆分校验失败");
  result.cutoff1000Volume = finiteNumber(snapshot.cutoff1000Volume);
  result.tierThresholds = snapshot.tierThresholds && typeof snapshot.tierThresholds === "object" ? snapshot.tierThresholds : {};
  result.collectedAt = snapshot.collectedAt || new Date().toISOString();
  result.sourceUpdatedAt = snapshot.sourceUpdatedAt || null;
  result.rankingUpdatedAt = result.sourceUpdatedAt;
  return result;
}

async function saveSnapshot(campaignId, snapshot) {
  const campaign = await getCampaignById(campaignId);
  if (!campaign) throw new Error(`未找到活动 [${campaignId}]`);
  const normalized = normalizeSnapshot(snapshot);

  return enqueueWrite(async () => {
    const all = await readJson(SNAPSHOTS_FILE, await getSeedSnapshots());
    const existingKey = findExactKey(all, campaign.id);
    if (existingKey && existingKey !== campaign.id) delete all[existingKey];
    const saved = { ...normalized, savedAt: new Date().toISOString() };
    all[campaign.id] = saved;

    const history = await readJson(SNAPSHOT_HISTORY_FILE, {});
    const historyKey = findExactKey(history, campaign.id);
    const entries = Array.isArray(history[historyKey || campaign.id]) ? history[historyKey || campaign.id] : [];
    if (historyKey && historyKey !== campaign.id) delete history[historyKey];
    const previous = entries[entries.length - 1];
    const sameSource = Boolean(previous) && previous.sourceUpdatedAt === saved.sourceUpdatedAt;
    const sameMetrics = previous &&
      previous.eligibleUserCount === saved.eligibleUserCount &&
      previous.eligibleTradingVolume === saved.eligibleTradingVolume &&
      previous.otherEligibleTradingVolume === saved.otherEligibleTradingVolume;
    if (!sameSource || !sameMetrics) entries.push(saved);
    history[campaign.id] = entries.slice(-MAX_HISTORY_PER_CAMPAIGN);

    await atomicWriteJson(SNAPSHOTS_FILE, all);
    await atomicWriteJson(SNAPSHOT_HISTORY_FILE, history);
    return saved;
  });
}

async function getSnapshot(campaignId) {
  const all = await getSnapshots();
  const key = findExactKey(all, campaignId);
  return key ? all[key] : null;
}

async function getSnapshotHistory(campaignId, limit = 100) {
  const all = await readJson(SNAPSHOT_HISTORY_FILE, {});
  const key = findExactKey(all, campaignId);
  const entries = key && Array.isArray(all[key]) ? all[key] : [];
  const safeLimit = Math.min(500, Math.max(1, Number(limit) || 100));
  return entries.slice(-safeLimit);
}

async function getSchedulerSettings() {
  const value = await readJson(SETTINGS_FILE, { autoUpdateEnabled: true });
  return { autoUpdateEnabled: value?.autoUpdateEnabled !== false };
}

async function saveSchedulerSettings(settings) {
  const normalized = { autoUpdateEnabled: settings?.autoUpdateEnabled !== false };
  await enqueueWrite(() => atomicWriteJson(SETTINGS_FILE, normalized));
  return normalized;
}

async function markSnapshotCheck(campaignId, error = null) {
  const campaign = await getCampaignById(campaignId);
  if (!campaign) return null;
  return enqueueWrite(async () => {
    const all = await readJson(SNAPSHOTS_FILE, await getSeedSnapshots());
    const key = findExactKey(all, campaign.id);
    if (!key) return null;
    all[key] = {
      ...all[key],
      lastCheckAt: new Date().toISOString(),
      lastCheckError: error ? String(error).slice(0, 500) : null
    };
    await atomicWriteJson(SNAPSHOTS_FILE, all);
    return all[key];
  });
}

module.exports = {
  DATA_DIR,
  getCampaigns,
  saveCampaigns,
  upsertCampaign,
  updateCampaign,
  deleteCampaign,
  getCampaignById,
  getSnapshots,
  saveSnapshot,
  getSnapshot,
  getSnapshotHistory,
  getSchedulerSettings,
  saveSchedulerSettings,
  markSnapshotCheck,
  normalizeCampaign,
  normalizeSnapshot,
  deriveCampaignStatus,
  mergeCampaignForUpsert
};
