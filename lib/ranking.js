const storage = require("./storage");
const binanceApi = require("./binance-api");

function asNonNegative(value, fallback = 0) {
  if (value === null || value === undefined || value === "") return fallback;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function round(value, digits) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  const scaled = value * factor;
  return Math.round(scaled + Number.EPSILON * Math.abs(scaled)) / factor;
}

function rewardForAddedVolume(pool, currentEligibleVolume, addedVolume, capPerUser = null) {
  if (!(pool > 0) || !(currentEligibleVolume >= 0) || !(addedVolume > 0)) return null;
  const uncapped = (pool * addedVolume) / (currentEligibleVolume + addedVolume);
  const capped = capPerUser !== null && Number.isFinite(capPerUser)
    ? Math.min(uncapped, Math.max(0, capPerUser))
    : uncapped;
  return { uncapped, capped, capApplied: capped < uncapped };
}

function computeRankingMetrics(campaign, rankingData, rewardTokenPrice = null, rewardPricesUsdt = {}) {
  const cutoffRank = asNonNegative(campaign.otherReward?.cutoffRank,
    Math.max(0, ...(campaign.tiers || []).map(tier => Number(tier.rankTo) || 0)) || 1000);
  const eligibleUserCount = asNonNegative(rankingData?.eligibleUserCount);
  const eligibleTradingVolume = asNonNegative(rankingData?.eligibleTradingVolume);
  const suppliedTopCount = rankingData?.topRankUserCount;
  const topRankUserCount = Math.min(
    cutoffRank,
    eligibleUserCount,
    suppliedTopCount === null || suppliedTopCount === undefined
      ? Math.min(cutoffRank, eligibleUserCount)
      : asNonNegative(suppliedTopCount)
  );
  const topRankingTradingVolume = asNonNegative(rankingData?.topRankingTradingVolume);
  const otherEligibleUserCount = Math.max(0, eligibleUserCount - topRankUserCount);
  const explicitTailVolume = rankingData?.otherEligibleTradingVolume;
  const otherEligibleTradingVolume = Math.max(0,
    explicitTailVolume === null || explicitTailVolume === undefined
      ? eligibleTradingVolume - topRankingTradingVolume
      : asNonNegative(explicitTailVolume)
  );

  const otherRewardPool = asNonNegative(campaign.otherReward?.pool);
  const otherRewardToken = String(campaign.otherReward?.token || campaign.rewardToken || "").toUpperCase();
  const otherRewardCap = asNonNegative(campaign.otherReward?.capPerUser, null);
  // Existing saved campaigns use proportional sharing; new imports retain the rule explicitly.
  const distribution = campaign.otherReward?.distribution || "proportional";
  let rewardEstimateStatus = "available";
  if (campaign.needsReview) rewardEstimateStatus = "rules-unverified";
  else if (!["proportional", "equal"].includes(distribution)) rewardEstimateStatus = "unsupported-distribution";
  else if (rankingData?.cutoffTied) rewardEstimateStatus = "rank-tie";
  else if (!(otherRewardPool > 0)) rewardEstimateStatus = "no-tail-pool";
  else if (otherEligibleUserCount <= 0) rewardEstimateStatus = "no-tail-users";
  else if (distribution === "proportional" && otherEligibleTradingVolume <= 0) rewardEstimateStatus = "no-tail-volume";
  const hasTailPoolData = rewardEstimateStatus === "available";
  const validPrice = Number.isFinite(Number(rewardTokenPrice)) && Number(rewardTokenPrice) > 0
    ? Number(rewardTokenPrice)
    : null;
  const prices = { [otherRewardToken]: validPrice, ...rewardPricesUsdt };
  const priceFor = token => {
    const price = asNonNegative(prices[token], null);
    return price > 0 ? price : null;
  };

  const tiers = (campaign.tiers || []).map(tier => {
    const thresholdVolumeUsd = asNonNegative(rankingData?.tierThresholds?.[tier.cutoffRank]
      ?? rankingData?.tiers?.find(item => item.cutoffRank === tier.cutoffRank)?.thresholdVolumeUsd
      ?? null, null);
    const tierToken = String(tier.rewardToken || otherRewardToken).toUpperCase();
    const tierPool = asNonNegative(tier.totalTierReward, null);
    const tierUserCount = asNonNegative(tier.userCount, null);
    const rewardPerUser = tierPool !== null && tierUserCount > 0
      ? tierPool / tierUserCount : asNonNegative(tier.rewardPerUser, null);
    const tierPrice = priceFor(tierToken);
    return {
      name: tier.name,
      rankFrom: tier.rankFrom,
      rankTo: tier.rankTo,
      cutoffRank: tier.cutoffRank,
      thresholdVolumeUsd,
      rewardPerUser: round(rewardPerUser, 8),
      rewardToken: tierToken,
      rewardUsdt: tierPrice !== null && rewardPerUser !== null
        ? round(rewardPerUser * tierPrice, 2)
        : null,
      userCount: tier.userCount
    };
  });

  const cutoffVolume = asNonNegative(rankingData?.cutoff1000Volume
    ?? tiers.find(tier => tier.cutoffRank === cutoffRank)?.thresholdVolumeUsd
    ?? null, null);
  // These cards estimate a new participant who stays in the tail pool. Eligibility
  // is supplied by the official leaderboard; do not reapply minVolumeUsd here.
  const estimate = addedVolume => {
    if (!hasTailPoolData) return { status: rewardEstimateStatus };
    if (cutoffRank > 0 && cutoffVolume === null) return { status: "unknown-cutoff" };
    if (cutoffRank > 0 && addedVolume >= cutoffVolume) return { status: "ranked-volume" };
    const reward = distribution === "equal"
      ? rewardForAddedVolume(otherRewardPool, otherEligibleUserCount, 1, otherRewardCap)
      : rewardForAddedVolume(otherRewardPool, otherEligibleTradingVolume, addedVolume, otherRewardCap);
    return { status: "available", ...reward };
  };
  const per1k = estimate(1000);
  const per10k = estimate(10000);
  const capVolume = hasTailPoolData && distribution === "proportional" && otherRewardCap !== null && otherRewardPool > otherRewardCap
    ? (otherRewardCap * otherEligibleTradingVolume) / (otherRewardPool - otherRewardCap)
    : null;
  const capReachedAtVolume = capVolume !== null &&
    (cutoffRank === 0 || (cutoffVolume !== null && capVolume < cutoffVolume)) ? capVolume : null;
  return {
    campaignId: campaign.id,
    dataStatus: eligibleUserCount > 0 ? "available" : "unavailable",
    sourceUpdatedAt: rankingData?.sourceUpdatedAt || null,
    collectedAt: rankingData?.collectedAt || rankingData?.savedAt || null,
    rankingUpdatedAt: rankingData?.sourceUpdatedAt || null,
    lastCheckAt: rankingData?.lastCheckAt || null,
    lastCheckError: rankingData?.lastCheckError || null,
    resourceId: rankingData?.resourceId || null,
    cutoffRank,
    eligibleUserCount,
    eligibleTradingVolume,
    topRankUserCount,
    topRankingTradingVolume,
    otherEligibleUserCount,
    otherEligibleTradingVolume,
    cutoff1000Volume: cutoffVolume,
    otherRewardPool,
    otherRewardToken,
    otherRewardCap,
    distribution,
    rewardEstimateStatus,
    rewardPer1kStatus: per1k.status,
    rewardPer10kStatus: per10k.status,
    capReachedAtVolume: round(capReachedAtVolume, 2),
    rewardPer1k: round(per1k?.capped, 8),
    rewardPer10k: round(per10k?.capped, 8),
    uncappedRewardPer1k: round(per1k?.uncapped, 8),
    uncappedRewardPer10k: round(per10k?.uncapped, 8),
    rewardPer1kCapApplied: Boolean(per1k?.capApplied),
    rewardPer10kCapApplied: Boolean(per10k?.capApplied),
    rewardPer1kUsdt: priceFor(otherRewardToken) !== null ? round(per1k.capped * priceFor(otherRewardToken), 4) : null,
    rewardPer10kUsdt: priceFor(otherRewardToken) !== null ? round(per10k.capped * priceFor(otherRewardToken), 2) : null,
    rewardPer10kUsdtUnrounded: per10k.status === "available" && priceFor(otherRewardToken) !== null
      ? per10k.capped * priceFor(otherRewardToken) : null,
    rewardTokenPrice: priceFor(otherRewardToken),
    rewardPricesUsdt: Object.fromEntries(Object.keys(prices).map(token => [token, priceFor(token)])),
    rewardPriceStatus: priceFor(otherRewardToken) !== null ? "live" : "unavailable",
    calculationBasis: distribution === "equal" ? "added-participant-included" : "added-volume-included",
    tiers
  };
}

async function getCampaignRanking(campaignId) {
  const campaign = await storage.getCampaignById(campaignId);
  if (!campaign) throw new Error(`未找到活动 [${campaignId}]`);
  const rewardToken = String(campaign.otherReward?.token || campaign.rewardToken || "").toUpperCase();
  const tokens = [...new Set([campaign.rewardToken, rewardToken,
    ...(campaign.tiers || []).map(tier => tier.rewardToken),
    ...(campaign.bonusRewards || []).map(item => item.rewardToken)]
    .filter(Boolean).map(token => String(token).toUpperCase()))];
  const prices = {};
  const errors = {};
  await Promise.all(tokens.map(async token => {
    if (["USDT", "USDC", "FDUSD"].includes(token)) { prices[token] = 1; return; }
    try { prices[token] = (await binanceApi.getTickerPrice(`${token}USDT`)).price; }
    catch (error) { prices[token] = null; errors[token] = error.message; }
  }));

  const snapshot = await storage.getSnapshot(campaign.id);
  const result = computeRankingMetrics(campaign, snapshot || {
    eligibleUserCount: 0,
    eligibleTradingVolume: 0,
    topRankUserCount: 0,
    topRankingTradingVolume: 0,
    otherEligibleUserCount: 0,
    otherEligibleTradingVolume: 0,
    tierThresholds: {},
    sourceUpdatedAt: null,
    collectedAt: null
  }, prices[rewardToken], prices);
  result.priceError = errors[rewardToken] || null;
  result.priceErrors = errors;
  return result;
}

module.exports = {
  computeRankingMetrics,
  getCampaignRanking,
  rewardForAddedVolume
};
