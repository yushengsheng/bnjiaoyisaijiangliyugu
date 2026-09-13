const BASE_API = process.env.BINANCE_API_BASE || "https://api.binance.com";
const CMS_BASES = (process.env.BINANCE_CMS_BASES || "https://www.binance.com/bapi/composite/v1/public/cms,https://www.icnguxncf.com/bapi/composite/v1/public/cms")
  .split(",")
  .map(value => value.trim().replace(/\/$/, ""))
  .filter(Boolean);

const memoryCache = new Map();

function getCached(key, ttlMs) {
  const item = memoryCache.get(key);
  return item && Date.now() - item.time < ttlMs ? item.data : null;
}

function setCached(key, data) {
  memoryCache.set(key, { data, time: Date.now() });
}

function cleanSymbol(symbol) {
  const raw = String(symbol || "").trim().toUpperCase();
  if (!/^[A-Z0-9]{1,20}(?:\/[A-Z0-9]{2,10})?$/.test(raw)) throw new Error(`无效交易对：${symbol}`);
  const clean = raw.replace("/", "");
  if (clean.length < 5 || clean.length > 24) throw new Error(`无效交易对：${symbol}`);
  return clean;
}

async function requestJson(targetUrl, options = {}, retries = 1) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Number(options.timeout) || 8000);
    try {
      const response = await fetch(targetUrl, {
        ...options,
        signal: controller.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 AppleWebKit/537.36 Chrome/128 Safari/537.36",
          clienttype: "web",
          lang: "zh-CN",
          accept: "application/json",
          ...(options.headers || {})
        }
      });
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
      const contentType = response.headers.get("content-type") || "";
      if (!contentType.includes("json")) throw new Error(`响应不是 JSON：${contentType || "unknown"}`);
      return await response.json();
    } catch (error) {
      lastError = error && error.name === "AbortError" ? new Error("请求超时") : error;
      if (attempt < retries) await new Promise(resolve => setTimeout(resolve, 350 * (attempt + 1)));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError || new Error("请求失败");
}

async function requestCms(pathname) {
  let lastError;
  for (const base of CMS_BASES) {
    try {
      return await requestJson(`${base}${pathname}`, { timeout: 10000 }, 1);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("公告服务不可用");
}

async function getAnnouncementList(catalogId = 93, pageNo = 1, pageSize = 20) {
  const catalog = Math.max(1, Number.parseInt(catalogId, 10) || 93);
  const page = Math.max(1, Number.parseInt(pageNo, 10) || 1);
  const size = Math.min(50, Math.max(1, Number.parseInt(pageSize, 10) || 20));
  const cacheKey = `list:${catalog}:${page}:${size}`;
  const cached = getCached(cacheKey, 10 * 60 * 1000);
  if (cached) return cached;

  const data = await requestCms(`/article/catalog/list/query?catalogId=${catalog}&pageNo=${page}&pageSize=${size}`);
  if (data.code !== "000000" || !data.data || !Array.isArray(data.data.articles)) {
    throw new Error(data.message || "公告列表格式异常");
  }
  setCached(cacheKey, data.data.articles);
  return data.data.articles;
}

async function getAnnouncementDetail(articleCode) {
  const cleanCode = String(articleCode || "").trim().replace(/^.*detail\//i, "").split(/[?#/]/)[0];
  if (!/^[a-f0-9]{32}$/i.test(cleanCode)) throw new Error("无效公告代码");
  const cacheKey = `detail:${cleanCode.toLowerCase()}`;
  const cached = getCached(cacheKey, 10 * 60 * 1000);
  if (cached) return cached;

  const data = await requestCms(`/article/detail/query?articleCode=${encodeURIComponent(cleanCode)}`);
  if (data.code !== "000000" || !data.data) throw new Error(data.message || "公告详情格式异常");
  setCached(cacheKey, data.data);
  return data.data;
}

async function getTickerPrice(symbol = "BNBUSDT") {
  const clean = cleanSymbol(symbol);
  const cacheKey = `price:${clean}`;
  const cached = getCached(cacheKey, 5000);
  if (cached) return cached;
  const query = new URLSearchParams({ symbol: clean });
  const data = await requestJson(`${BASE_API}/api/v3/ticker/price?${query}`, { timeout: 5000 }, 1);
  const price = Number(data.price);
  if (data.symbol !== clean || !Number.isFinite(price) || price <= 0) throw new Error(`价格响应无效：${clean}`);
  const result = { symbol: clean, price, updatedAt: new Date().toISOString(), source: "binance" };
  setCached(cacheKey, result);
  return result;
}

async function getTickerPrices(symbols = []) {
  const cleanList = [...new Set(symbols.map(cleanSymbol))];
  if (!cleanList.length) return {};
  const query = new URLSearchParams({ symbols: JSON.stringify(cleanList) });
  const list = await requestJson(`${BASE_API}/api/v3/ticker/price?${query}`, { timeout: 6000 }, 1);
  if (!Array.isArray(list)) throw new Error("批量价格响应格式异常");
  const result = {};
  for (const item of list) {
    const price = Number(item.price);
    if (cleanList.includes(item.symbol) && Number.isFinite(price) && price > 0) result[item.symbol] = price;
  }
  return result;
}

function validateBookTicker(data, clean) {
  if (!data || data.symbol !== clean) throw new Error(`盘口响应不匹配：${clean}`);
  const bidPrice = Number(data.bidPrice);
  const askPrice = Number(data.askPrice);
  if (!Number.isFinite(bidPrice) || !Number.isFinite(askPrice) || bidPrice <= 0 || askPrice <= 0 || askPrice < bidPrice) {
    throw new Error(`盘口数据无效：${clean}`);
  }
  return data;
}

async function getBookTicker(symbol) {
  const clean = cleanSymbol(symbol);
  const query = new URLSearchParams({ symbol: clean });
  return validateBookTicker(await requestJson(`${BASE_API}/api/v3/ticker/bookTicker?${query}`, { timeout: 5000 }, 1), clean);
}

async function getBookTickers(symbols = []) {
  const cleanList = [...new Set(symbols.map(cleanSymbol))];
  if (!cleanList.length) return [];
  try {
    const query = new URLSearchParams({ symbols: JSON.stringify(cleanList) });
    const list = await requestJson(`${BASE_API}/api/v3/ticker/bookTicker?${query}`, { timeout: 6000 }, 1);
    if (!Array.isArray(list)) throw new Error("批量盘口响应格式异常");
    const bySymbol = new Map(list.map(item => [item.symbol, item]));
    return cleanList.map(symbol => {
      try {
        return { ok: true, symbol, data: validateBookTicker(bySymbol.get(symbol), symbol) };
      } catch (error) {
        return { ok: false, symbol, error: error.message };
      }
    });
  } catch (_) {
    const results = new Array(cleanList.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(4, cleanList.length) }, async () => {
      while (cursor < cleanList.length) {
        const index = cursor++;
        const symbol = cleanList[index];
        try {
          results[index] = { ok: true, symbol, data: await getBookTicker(symbol) };
        } catch (error) {
          results[index] = { ok: false, symbol, error: error.message || "盘口不可用" };
        }
      }
    });
    await Promise.all(workers);
    return results;
  }
}

module.exports = {
  requestJson,
  getAnnouncementList,
  getAnnouncementDetail,
  getTickerPrice,
  getTickerPrices,
  getBookTicker,
  getBookTickers,
  cleanSymbol
};
