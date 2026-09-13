const storage = require("./storage");
const binanceApi = require("./binance-api");

function asNonNegative(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function rewardForAddedVolume(pool, currentEligibleVolume, addedVolume, capPerUser = null) {
  if (!(pool > 0) || !(currentEligibleVolume >= 0) || !(addedVolume > 0)) return null;
  const uncapped = (pool * addedVolume) / (currentEligibleVolume + addedVolume);
  const capped = capPerUser !== null && Number.isFinite(capPerUser)
    ? Math.min(uncapped, Math.max(0, capPerUser))
    : uncapped;
  return { uncapped, capped, capApplied: capped < uncapped };
}

function computeRankingMetrics(campaign, rankingData, rewardTokenPrice = null) {
  const cutoffRank = asNonNegative(campaign.otherReward?.cutoffRank, 1000) || 1000;
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
  const capValue = Number(campaign.otherReward?.capPerUser);
  const otherRewardCap = Number.isFinite(capValue) && capValue >= 0 ? capValue : null;
  const rewardEstimateStatus = !(otherRewardPool > 0)
    ? "no-tail-pool"
    : otherEligibleUserCount <= 0
      ? "no-tail-users"
      : otherEligibleTradingVolume <= 0 ? "no-tail-volume" : "available";
  const hasTailPoolData = rewardEstimateStatus === "available";
  const per1k = hasTailPoolData ? rewardForAddedVolume(otherRewardPool, otherEligibleTradingVolume, 1000, otherRewardCap) : null;
  const per10k = hasTailPoolData ? rewardForAddedVolume(otherRewardPool, otherEligibleTradingVolume, 10000, otherRewardCap) : null;
  const validPrice = Number.isFinite(Number(rewardTokenPrice)) && Number(rewardTokenPrice) > 0
    ? Number(rewardTokenPrice)
    : null;

  const tiers = (campaign.tiers || []).map(tier => {
    const thresholdVolumeUsd = rankingData?.tierThresholds?.[tier.cutoffRank]
      ?? rankingData?.tiers?.find(item => item.cutoffRank === tier.cutoffRank)?.thresholdVolumeUsd
      ?? null;
    const tierToken = String(tier.rewardToken || otherRewardToken).toUpperCase();
    const rewardPerUser = Number.isFinite(Number(tier.rewardPerUser)) ? Number(tier.rewardPerUser) : null;
    const tierPrice = tierToken === otherRewardToken ? validPrice : null;
    return {
      name: tier.name,
      rankFrom: tier.rankFrom,
      rankTo: tier.rankTo,
      cutoffRank: tier.cutoffRank,
      thresholdVolumeUsd,
      rewardPerUser,
      rewardToken: tierToken,
      rewardUsdt: tierPrice !== null && rewardPerUser !== null
        ? Number((rewardPerUser * tierPrice).toFixed(2))
        : null,
      userCount: tier.userCount
    };
  });

  const cutoffVolume = rankingData?.cutoff1000Volume
    ?? tiers.find(tier => tier.cutoffRank === cutoffRank)?.thresholdVolumeUsd
    ?? null;
  const capReachedAtVolume = hasTailPoolData && otherRewardCap !== null && otherRewardPool > otherRewardCap
    ? (otherRewardCap * otherEligibleTradingVolume) / (otherRewardPool - otherRewardCap)
    : null;

  const round = (value, digits) => {
    if (value === null || value === undefined) return null;
    const factor = 10 ** digits;
    const scaled = value * factor;
    return Math.round(scaled + Number.EPSILON * Math.abs(scaled)) / factor;
  };
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
    rewardEstimateStatus,
    capReachedAtVolume: round(capReachedAtVolume, 2),
    rewardPer1k: round(per1k?.capped, 8),
    rewardPer10k: round(per10k?.capped, 8),
    uncappedRewardPer1k: round(per1k?.uncapped, 8),
    uncappedRewardPer10k: round(per10k?.uncapped, 8),
    rewardPer1kCapApplied: Boolean(per1k?.capApplied),
    rewardPer10kCapApplied: Boolean(per10k?.capApplied),
    rewardPer1kUsdt: validPrice !== null && per1k ? round(per1k.capped * validPrice, 4) : null,
    rewardPer10kUsdt: validPrice !== null && per10k ? round(per10k.capped * validPrice, 2) : null,
    rewardTokenPrice: validPrice,
    rewardPriceStatus: validPrice !== null ? "live" : "unavailable",
    calculationBasis: "added-volume-included",
    tiers
  };
}

async function getCampaignRanking(campaignId) {
  const campaign = await storage.getCampaignById(campaignId);
  if (!campaign) throw new Error(`未找到活动 [${campaignId}]`);
  const rewardToken = String(campaign.otherReward?.token || campaign.rewardToken || "").toUpperCase();
  let tokenPrice = null;
  let priceError = null;
  if (["USDT", "USDC", "FDUSD"].includes(rewardToken)) {
    tokenPrice = 1;
  } else if (rewardToken) {
    try {
      tokenPrice = (await binanceApi.getTickerPrice(`${rewardToken}USDT`)).price;
    } catch (error) {
      tokenPrice = null;
      priceError = error.message;
    }
  }

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
  }, tokenPrice);
  result.priceError = priceError;
  return result;
}

module.exports = {
  computeRankingMetrics,
  getCampaignRanking,
  rewardForAddedVolume
};
