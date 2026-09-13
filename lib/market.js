const binanceApi = require("./binance-api");
const storage = require("./storage");

function parseRate(value, fallback, { min = 0, max = 1, name = "参数" } = {}) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    const error = new Error(`${name}必须在 ${min} 到 ${max} 之间`);
    error.statusCode = 400;
    throw error;
  }
  return number;
}

function calculatePairCost(bookTicker, options = {}) {
  const feeRate = parseRate(options.feeRate, 0.00075, { min: 0, max: 0.02, name: "基础费率" });
  const rebateRate = parseRate(options.rebateRate, 0.485, { min: 0, max: 1, name: "返佣比例" });
  const bidPrice = Number(bookTicker.bidPrice);
  const askPrice = Number(bookTicker.askPrice);
  const bidQty = Number(bookTicker.bidQty) || 0;
  const askQty = Number(bookTicker.askQty) || 0;
  if (!Number.isFinite(bidPrice) || !Number.isFinite(askPrice) || bidPrice <= 0 || askPrice <= 0 || askPrice < bidPrice) {
    throw new Error(`盘口数据无效：${bookTicker.symbol || "unknown"}`);
  }

  const midPrice = (bidPrice + askPrice) / 2;
  const spread = askPrice - bidPrice;
  const spreadPercent = (spread / midPrice) * 100;
  const actualFeeRate = feeRate * (1 - rebateRate);
  const volumeMultiplier = parseRate(options.volumeMultiplier, 1, { min: 0.1, max: 10, name: "交易量计入倍数" });
  const actualVolumePer1000Counted = 1000 / volumeMultiplier;
  const feeCostPer1000 = actualVolumePer1000Counted * actualFeeRate;
  const feeCostPer10k = feeCostPer1000 * 10;

  // 按用户要求使用买一/卖一简单估算。假设买卖两边合计形成目标交易量，
  // 因此每 1,000 U 实际交易量对应约 500 U 需要跨越完整买卖价差。
  // 若活动按倍数计入榜单，则先把榜单交易量折算为所需实际交易量。
  const spreadLossPer1000 = actualVolumePer1000Counted * (spread / (2 * midPrice));
  const spreadLossPer10k = spreadLossPer1000 * 10;

  return {
    symbol: bookTicker.symbol,
    pair: formatSymbolToPair(bookTicker.symbol),
    lastPrice: midPrice,
    bidPrice,
    bidQty,
    askPrice,
    askQty,
    midPrice,
    spread,
    spreadPercent,
    volumeMultiplier,
    actualVolumePer1000Counted,
    feeCostPer1000,
    feeCostPer10k,
    spreadLossPer1000,
    spreadLossPer10k,
    totalCostPer1000: feeCostPer1000 + spreadLossPer1000,
    totalCostPer10k: feeCostPer10k + spreadLossPer10k,
    source: "binance"
  };
}

function formatSymbolToPair(symbol = "") {
  const clean = String(symbol).toUpperCase();
  for (const quote of ["FDUSD", "USDT", "USDC", "BTC", "ETH", "BNB"]) {
    if (clean.endsWith(quote) && clean.length > quote.length) {
      return `${clean.slice(0, -quote.length)}/${quote}`;
    }
  }
  return clean;
}

async function getCampaignMarketAnalysis(campaignId, options = {}) {
  const campaign = await storage.getCampaignById(campaignId);
  if (!campaign) throw new Error(`未找到活动 [${campaignId}]`);
  const feeRate = parseRate(options.feeRate, 0.00075, { min: 0, max: 0.02, name: "基础费率" });
  const rebateRate = parseRate(options.rebateRate, 0.485, { min: 0, max: 1, name: "返佣比例" });
  const actualFeeRate = feeRate * (1 - rebateRate);

  const rewardToken = String(campaign.rewardToken || campaign.otherReward?.token || "").toUpperCase();
  const rewardPricesUsdt = {};
  let rewardPriceError = null;
  if (rewardToken === "USDT" || rewardToken === "USDC" || rewardToken === "FDUSD") {
    rewardPricesUsdt[rewardToken] = 1;
  } else if (rewardToken) {
    try {
      rewardPricesUsdt[rewardToken] = (await binanceApi.getTickerPrice(`${rewardToken}USDT`)).price;
    } catch (error) {
      rewardPricesUsdt[rewardToken] = null;
      rewardPriceError = error.message;
    }
  }

  const symbols = (campaign.pairs || []).map(pair => pair.replace("/", ""));
  const tickerResults = symbols.length ? await binanceApi.getBookTickers(symbols) : [];
  const markets = [];
  const unavailableMarkets = [];
  for (const result of tickerResults) {
    if (!result.ok) {
      unavailableMarkets.push({ symbol: result.symbol, pair: formatSymbolToPair(result.symbol), error: result.error });
      continue;
    }
    try {
      const pair = formatSymbolToPair(result.data.symbol || result.symbol);
      markets.push(calculatePairCost(result.data, { feeRate, rebateRate, volumeMultiplier: campaign.pairMultipliers?.[pair] || 1 }));
    } catch (error) {
      unavailableMarkets.push({ symbol: result.symbol, pair: formatSymbolToPair(result.symbol), error: error.message });
    }
  }

  const status = markets.length === 0 ? "unavailable" : unavailableMarkets.length ? "partial" : "live";
  return {
    source: markets.length ? "binance" : null,
    status,
    campaignId: campaign.id,
    updatedAt: markets.length ? new Date().toISOString() : null,
    feeRate,
    rebateRate,
    actualFeeRate,
    feeCostPer1000: 1000 * actualFeeRate,
    feeCostPer10k: 10000 * actualFeeRate,
    rewardPricesUsdt,
    rewardPriceError,
    markets,
    unavailableMarkets
  };
}

module.exports = {
  calculatePairCost,
  getCampaignMarketAnalysis,
  formatSymbolToPair,
  parseRate
};
