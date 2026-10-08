const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const storage = require("./storage");
const { validateLeaderboardUrl, validateLeaderboardHost, normalizeLeaderboardUrl, extractPairMultipliersFromTables } = require("./parser");

const SUMMARY_ENDPOINT = "/bapi/growth/v1/friendly/growth-paas/resource/summary/list";
const PAGE_LOAD_ATTEMPTS = 3;

function findBrowserPath() {
  const home = os.homedir();
  const candidates = process.platform === "darwin"
    ? [
        "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        `${home}/Applications/Brave Browser.app/Contents/MacOS/Brave Browser`,
        `${home}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`
      ]
    : process.platform === "win32"
      ? [
          path.join(process.env.LOCALAPPDATA || "", "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
          path.join(process.env.ProgramFiles || "C:\\Program Files", "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
          path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
          path.join(process.env.ProgramFiles || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
          path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe")
        ]
      : ["/usr/bin/brave-browser", "/usr/bin/brave", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  return candidates.find(candidate => candidate && fs.existsSync(candidate)) || null;
}

function getLeaderboardUrls(input) {
  const original = normalizeLeaderboardUrl(input);
  const fallbacks = ["www.binance.com", "www.icnguxncf.com"].map(hostname => {
    const parsed = new URL(original);
    parsed.hostname = hostname;
    return parsed.toString();
  });
  return [...new Set([original, ...fallbacks])];
}

function getRequestedSubTrack(input) {
  const parsed = validateLeaderboardUrl(input);
  const match = parsed.pathname.replace(/\/Main-Reward\/?$/i, "").match(/\/activity\/trading-competition\/(.+)$/i);
  const segments = match ? match[1].split("/").filter(Boolean) : [];
  return segments[1] || "";
}

function findConfiguredResourceId(appData, requestedSubTrack) {
  const wanted = String(requestedSubTrack || "").replace(/^\/+|\/+$/g, "").toLowerCase();
  if (!wanted || !appData || typeof appData !== "object") return null;
  const stack = [appData];
  const seen = new Set();
  while (stack.length) {
    const value = stack.pop();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    const uri = String(value.globalContent?.uri || "").replace(/^\/+|\/+$/g, "").toLowerCase();
    const id = Number(value.id);
    if (value.type === "TRADING_COMPETITION_ACTIVITY" && uri === wanted && Number.isInteger(id) && id > 0) return id;
    if (Array.isArray(value)) stack.push(...value);
    else stack.push(...Object.values(value));
  }
  return null;
}

function extractEligiblePairsFromPageText(text) {
  const source = String(text || "").replace(/\r/g, "");
  const section = source.match(/符合条件的交易对[\s\S]{0,2200}?(?=参与者在以下|如何参与|统计周期|数据上次更新时间)/i)?.[0] || "";
  const pairs = [...section.matchAll(/\b([A-Z0-9]{1,20})\s*\/\s*(USDT|USDC|FDUSD|BNB|BTC|ETH)\b/gi)]
    .map(match => `${match[1].toUpperCase()}/${match[2].toUpperCase()}`);
  return [...new Set(pairs)];
}

function extractResourceListData(response) {
  const data = response?.data;
  const list = data?.resourceSummaryList;
  const rawReportedVolume = data?.eligibleTradingVolume;
  return {
    records: Array.isArray(list?.data) ? list.data : [],
    total: Number(list?.total ?? data?.eligibleUserCount),
    reportedVolume: rawReportedVolume === null || rawReportedVolume === undefined ? null : Number(rawReportedVolume)
  };
}

function parseVolume(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = String(value ?? "").trim().replace(/[$,\s]/g, "");
  const match = text.match(/^(-?[\d.]+)([KMB万亿]?)$/i);
  if (!match) return null;
  const base = Number(match[1]);
  if (!Number.isFinite(base)) return null;
  const multipliers = { "": 1, K: 1e3, M: 1e6, B: 1e9, 万: 1e4, 亿: 1e8 };
  return base * multipliers[match[2].toUpperCase() || match[2]];
}

function toMicros(value) {
  const number = parseVolume(value);
  if (!Number.isFinite(number) || number < 0) return null;
  return BigInt(Math.round(number * 1_000_000));
}

function microsToNumber(value) {
  return Number(value) / 1_000_000;
}

function parseTimestampValue(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = value < 1e12 ? value * 1000 : value;
    const date = new Date(milliseconds);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (/^\d{10,13}$/.test(value.trim()) && Number.isFinite(numeric)) return parseTimestampValue(numeric);
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  return null;
}

function findSourceUpdatedAt(value) {
  if (!value || typeof value !== "object") return null;
  const preferredKeys = ["rankingUpdatedAt", "sourceUpdatedAt", "updateTime", "updatedTime", "updatedAt", "lastUpdateTime", "dataUpdateTime"];
  const containers = [
    value,
    value.data,
    value.metadata,
    value.data?.metadata,
    value.resourceSummaryList,
    value.data?.resourceSummaryList
  ];
  for (const container of containers) {
    if (!container || typeof container !== "object" || Array.isArray(container)) continue;
    for (const key of preferredKeys) {
      if (!Object.prototype.hasOwnProperty.call(container, key)) continue;
      const parsed = parseTimestampValue(container[key]);
      if (parsed) return parsed;
    }
  }
  return null;
}

function buildExactSnapshot({ resourceId, pages, cutoffRank = 1000, tierCutoffs = [], collectedAt = new Date().toISOString() }) {
  if (!resourceId || !Array.isArray(pages) || !pages.length) throw new Error("排行榜分页数据不完整");
  const first = extractResourceListData(pages[0]);
  if (!Number.isInteger(first.total) || first.total <= 0) throw new Error("排行榜未返回有效总人数");

  const records = [];
  const identities = new Set();
  let previousDisplayedRank = null;
  let previousVolume = null;
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
    const pageData = extractResourceListData(pages[pageIndex]);
    if (Number.isInteger(pageData.total) && pageData.total !== first.total) {
      throw new Error(`排行榜分页总人数不一致：第 ${pageIndex + 1} 页为 ${pageData.total}，首页为 ${first.total}`);
    }
    const pageRecords = pageData.records;
    for (let rowIndex = 0; rowIndex < pageRecords.length; rowIndex++) {
      const item = pageRecords[rowIndex];
      if (item.resourceId !== undefined && Number(item.resourceId) !== Number(resourceId)) {
        throw new Error(`排行榜记录 Resource ID 不匹配：${item.resourceId}`);
      }
      const displayedRank = Number(item.sequence ?? item.rank ?? item.ranking ?? item.position);
      const volume = parseVolume(item.grade ?? item.tradingVolume ?? item.volume ?? item.score);
      const micros = toMicros(volume);
      if (!Number.isFinite(volume) || volume < 0 || micros === null) {
        throw new Error(`排行榜交易量无效：第 ${pageIndex + 1} 页第 ${rowIndex + 1} 行`);
      }
      const identity = String(item.optInId || item.userId || "");
      if (!identity) throw new Error("排行榜缺少稳定参与者标识，无法校验分页重复");
      if (identities.has(identity)) throw new Error(`排行榜分页出现重复参与者：${identity.slice(0, 24)}`);
      const expectedPosition = records.length + 1;
      if (!Number.isInteger(displayedRank) || displayedRank < 1 || (expectedPosition === 1 && displayedRank !== 1) || (previousDisplayedRank !== null && displayedRank < previousDisplayedRank)) {
        throw new Error(`排行榜排名顺序异常：第 ${pageIndex + 1} 页第 ${rowIndex + 1} 行显示 ${Number.isFinite(displayedRank) ? displayedRank : "缺失"}`);
      }
      if (previousVolume !== null && volume > previousVolume + 0.000001) {
        throw new Error(`排行榜交易量顺序异常：第 ${pageIndex + 1} 页第 ${rowIndex + 1} 行交易量 ${volume} 高于上一名 ${previousVolume}`);
      }
      identities.add(identity);
      records.push({ position: expectedPosition, displayedRank, volume, micros });
      previousDisplayedRank = displayedRank;
      previousVolume = volume;
    }
  }

  if (records.length !== first.total) {
    const pageSizes = pages.map(page => extractResourceListData(page).records.length);
    throw new Error(`排行榜缺失：应有 ${first.total} 条，实际 ${records.length} 条；分页记录数 ${pageSizes.join(",")}`);
  }

  const exactTotalMicros = records.reduce((sum, item) => sum + item.micros, 0n);
  if (!Number.isInteger(Number(cutoffRank)) || Number(cutoffRank) < 0) throw new Error("排名分界必须是非负整数");
  const normalizedCutoff = Math.min(Number(cutoffRank), records.length);
  const topRecords = records.slice(0, normalizedCutoff);
  const tailRecords = records.slice(normalizedCutoff);
  const topMicros = topRecords.reduce((sum, item) => sum + item.micros, 0n);
  const tailMicros = tailRecords.reduce((sum, item) => sum + item.micros, 0n);
  const exactTotal = microsToNumber(exactTotalMicros);
  const topVolume = microsToNumber(topMicros);
  const tailVolume = microsToNumber(tailMicros);
  const thresholds = {};
  const requestedCutoffs = [...new Set([1, 2, 3, 4, 5, normalizedCutoff, ...tierCutoffs].map(Number).filter(Number.isInteger))];
  for (const rank of requestedCutoffs) {
    if (rank >= 1 && rank <= records.length) thresholds[rank] = records[rank - 1].volume;
  }

  const reportedTotal = Number.isFinite(first.reportedVolume) && first.reportedVolume >= 0 ? first.reportedVolume : null;
  const reportedMicros = reportedTotal === null ? null : toMicros(reportedTotal);
  const reportedDifferenceMicros = reportedMicros === null ? null : reportedMicros - exactTotalMicros;
  const reportedDifference = reportedDifferenceMicros === null ? null : microsToNumber(reportedDifferenceMicros);
  const reportedToleranceMicros = BigInt(Math.max(10_000, first.total));
  if (reportedDifferenceMicros !== null && (reportedDifferenceMicros < 0n ? -reportedDifferenceMicros : reportedDifferenceMicros) > reportedToleranceMicros) {
    throw new Error(`排行榜官方总量与逐条求和不一致：官方 ${reportedTotal}，本地 ${exactTotal}，差值 ${reportedDifference}`);
  }
  const sourceTimes = [...new Set(pages.map(findSourceUpdatedAt).filter(Boolean))];
  if (sourceTimes.length > 1) throw new Error("排行榜分页源时间不一致，请稍后重新完整抓取");
  const sourceUpdatedAt = sourceTimes[0] || null;
  return {
    resourceId: Number(resourceId),
    sourceUpdatedAt,
    collectedAt,
    rankingUpdatedAt: sourceUpdatedAt,
    eligibleUserCount: records.length,
    eligibleTradingVolume: exactTotal,
    reportedEligibleTradingVolume: reportedTotal,
    reportedVolumeDifference: reportedDifference,
    topRankUserCount: topRecords.length,
    topRankingTradingVolume: topVolume,
    otherEligibleUserCount: tailRecords.length,
    otherEligibleTradingVolume: tailVolume,
    cutoff1000Volume: normalizedCutoff === Number(cutoffRank) && normalizedCutoff > 0 ? records[normalizedCutoff - 1]?.volume ?? null : null,
    cutoffTied: topRecords.length > 0 && tailRecords.length > 0 &&
      topRecords.at(-1).displayedRank === tailRecords[0].displayedRank,
    tierThresholds: thresholds,
    integrity: {
      complete: true,
      expectedRecords: first.total,
      actualRecords: records.length,
      firstDisplayedRank: records[0].displayedRank,
      lastDisplayedRank: records[records.length - 1].displayedRank
    }
  };
}

async function crawlLeaderboard(campaignOrUrl, onProgress = null) {
  const campaign = typeof campaignOrUrl === "string"
    ? { id: "temporary", landingUrl: campaignOrUrl, tiers: [], otherReward: { cutoffRank: 1000 } }
    : campaignOrUrl;
  if (!campaign?.landingUrl) throw new Error("活动缺少排行榜链接");
  validateLeaderboardUrl(campaign.landingUrl);
  const previous = campaign.id ? await storage.getSnapshot(campaign.id).catch(() => null) : null;
  const preferredResourceId = Number(campaign.resourceId || previous?.resourceId) || null;
  const urls = getLeaderboardUrls(campaign.landingUrl);
  let lastError;
  for (let index = 0; index < urls.length; index++) {
    onProgress?.(index ? 15 : 5, index ? "正在尝试备用官方域名…" : "正在准备本地浏览器…");
    try {
      await validateLeaderboardHost(urls[index]);
      return await executeCrawlSingle(urls[index], campaign, preferredResourceId, onProgress);
    } catch (error) {
      lastError = error;
      console.warn(`[Crawler] ${urls[index]} 抓取失败: ${error.message}`);
    }
  }
  const finalError = lastError || new Error("排行榜抓取失败");
  if (!finalError.statusCode) finalError.statusCode = 502;
  throw finalError;
}

async function executeCrawlSingle(landingUrl, campaign, preferredResourceId, onProgress) {
  const browserPath = findBrowserPath();
  if (!browserPath) throw new Error("未检测到 Brave 或 Chrome");
  if (typeof WebSocket !== "function") throw new Error("排行榜采集需要 Node.js 22 或更高版本");

  const port = 9400 + Math.floor(Math.random() * 1000);
  const profile = path.join(os.tmpdir(), `eventlens-crawler-${process.pid}-${Date.now()}`);
  const args = [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    "--remote-debugging-address=127.0.0.1",
    "--disable-gpu",
    "--disable-background-networking",
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1600,1000",
    `--user-data-dir=${profile}`,
    "about:blank"
  ];
  const child = spawn(browserPath, args, { stdio: "ignore" });
  const stopChild = () => { try { child.kill("SIGKILL"); } catch (_) {} };
  process.once("exit", stopChild);
  try {
    let wsUrl = null;
    for (let attempt = 0; attempt < 40; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 250));
      if (child.exitCode !== null) throw new Error("浏览器启动失败");
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/list`);
        const tabs = response.ok ? await response.json() : [];
        wsUrl = tabs.find(tab => tab.type === "page")?.webSocketDebuggerUrl || null;
        if (wsUrl) break;
      } catch (_) {}
    }
    if (!wsUrl) throw new Error("无法连接本地浏览器调试端点");
    return await driveBrowserSession(wsUrl, landingUrl, campaign, preferredResourceId, onProgress);
  } finally {
    process.removeListener("exit", stopChild);
    stopChild();
    await new Promise(resolve => setTimeout(resolve, 100));
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}
  }
}

function driveBrowserSession(wsUrl, targetUrl, campaign, preferredResourceId, onProgress) {
  const requestedSubTrack = getRequestedSubTrack(targetUrl);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let messageId = 1;
    let settled = false;
    let phase = "initial";
    const pending = new Map();
    const initialIds = [];
    const postClickIds = [];

    let overallTimeout = null;
    const armOverallTimeout = timeoutMs => {
      clearTimeout(overallTimeout);
      overallTimeout = setTimeout(() => {
        const candidates = [...new Set([...postClickIds, ...initialIds])];
        finish(reject, new Error(`排行榜抓取超时：${targetUrl}；候选 Resource ID：${candidates.join(",") || "无"}`));
      }, timeoutMs);
    };

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(overallTimeout);
      for (const entry of pending.values()) entry.reject(new Error("浏览器会话已结束"));
      pending.clear();
      try { ws.close(); } catch (_) {}
      callback(value);
    };

    const send = (method, params = {}) => new Promise((res, rej) => {
      const id = messageId++;
      pending.set(id, { resolve: res, reject: rej });
      ws.send(JSON.stringify({ id, method, params }));
    });

    armOverallTimeout(120000);

    ws.onerror = () => finish(reject, new Error("浏览器调试连接失败"));
    ws.onmessage = event => {
      let message;
      try { message = JSON.parse(event.data); } catch (_) { return; }
      if (message.id && pending.has(message.id)) {
        const handler = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) handler.reject(new Error(message.error.message));
        else handler.resolve(message.result);
        return;
      }
      if (message.method === "Runtime.consoleAPICalled") {
        const args = message.params?.args || [];
        if (args[0]?.value === "__EVENTLENS_PAGE_COUNT__") {
          const pageCount = Number(args[1]?.value);
          if (Number.isFinite(pageCount) && pageCount > 0) armOverallTimeout(Math.min(600000, Math.max(120000, 60000 + pageCount * 1000)));
        }
        return;
      }
      if (message.method === "Network.requestWillBeSent") {
        const request = message.params?.request;
        if (!request?.url.includes(SUMMARY_ENDPOINT) || !request.postData) return;
        try {
          const payload = JSON.parse(request.postData);
          const resourceId = Number(payload.resourceId);
          if (!resourceId) return;
          const target = phase === "post-click" ? postClickIds : initialIds;
          if (!target.includes(resourceId)) target.push(resourceId);
        } catch (_) {}
      }
    };

    ws.onopen = async () => {
      try {
        await send("Network.enable");
        await send("Page.enable");
        await send("Runtime.enable");
        let uniqueIds = [];
        for (let loadAttempt = 0; loadAttempt < PAGE_LOAD_ATTEMPTS && !uniqueIds.length; loadAttempt++) {
          initialIds.length = 0;
          postClickIds.length = 0;
          phase = "initial";
          if (loadAttempt === 0) {
            onProgress?.(20, "正在打开活动页面…");
            await send("Page.navigate", { url: targetUrl });
          } else {
            onProgress?.(20 + loadAttempt * 5, `页面暂未返回排行榜，正在第 ${loadAttempt + 1} 次刷新…`);
            await send("Page.reload", { ignoreCache: true });
          }
          await new Promise(resolveDelay => setTimeout(resolveDelay, 8000));

          phase = "post-click";
          await send("Runtime.evaluate", {
            expression: `(() => {
              const elements = Array.from(document.querySelectorAll('button,[role="tab"],a,div'));
              const target = elements.find(element => {
                const text = (element.textContent || '').trim();
                return /^(主奖池|Main Reward|现货大赛)$/.test(text) && element.children.length <= 2;
              });
              if (target) target.click();
              window.scrollTo(0, Math.min(1000, document.body.scrollHeight));
              return Boolean(target);
            })()`,
            returnByValue: true
          });
          await new Promise(resolveDelay => setTimeout(resolveDelay, 8000));
          uniqueIds = [...new Set([...postClickIds, ...initialIds].filter(Number.isFinite))];
        }
        let configuredResourceId = null;
        let eligiblePairs = [];
        let eligiblePairMultipliers = {};
        if (requestedSubTrack) {
          try {
            const [appDataResult, pageTextResult, pageTablesResult] = await Promise.all([
              send("Runtime.evaluate", {
                expression: `document.getElementById('__APP_DATA')?.textContent || ''`,
                returnByValue: true
              }),
              send("Runtime.evaluate", {
                expression: `document.body?.innerText || ''`,
                returnByValue: true
              }),
              send("Runtime.evaluate", {
                expression: `Array.from(document.querySelectorAll('table'))
                  .filter(table => table.getClientRects().length > 0)
                  .map(table => Array.from(table.rows).map(row => Array.from(row.cells).map(cell => cell.innerText)))`,
                returnByValue: true
              })
            ]);
            const appDataText = appDataResult?.result?.value;
            if (appDataText) configuredResourceId = findConfiguredResourceId(JSON.parse(appDataText), requestedSubTrack);
            eligiblePairs = extractEligiblePairsFromPageText(pageTextResult?.result?.value);
            eligiblePairMultipliers = extractPairMultipliersFromTables(pageTablesResult?.result?.value);
          } catch (_) {}
        }
        if (configuredResourceId && !uniqueIds.includes(configuredResourceId)) uniqueIds.unshift(configuredResourceId);
        if (!uniqueIds.length) throw new Error(`活动页面连续加载 ${PAGE_LOAD_ATTEMPTS} 次仍未返回排行榜数据，请稍后重试`);
        onProgress?.(40, requestedSubTrack ? "正在绑定指定子赛道排行榜…" : "正在确认当前主排行榜数据源…");

        const tiers = campaign.tiers || [];
        const cutoffRank = campaign.otherReward?.cutoffRank ?? (Math.max(0, ...tiers.map(tier => Number(tier.rankTo) || 0)) || 1000);
        const evalResult = await send("Runtime.evaluate", {
          expression: `
            (async ({ ids, preferredId, configuredId, endpoint, cutoffRank, tierCutoffs }) => {
              const requestPage = async (resourceId, pageIndex, pageSize, retries = 2) => {
                let lastError = null;
                for (let attempt = 0; attempt <= retries; attempt++) {
                  const controller = new AbortController();
                  const timeout = setTimeout(() => controller.abort(), 12000);
                  try {
                    const response = await fetch(endpoint, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json', clienttype: 'web' },
                      body: JSON.stringify({ resourceId, leaderboardType: 'USER', pageIndex, pageSize }),
                      signal: controller.signal
                    });
                    if (!response.ok) {
                      const requestError = new Error('HTTP ' + response.status + '，Resource ID ' + resourceId + '，第 ' + pageIndex + ' 页');
                      requestError.statusCode = response.status;
                      throw requestError;
                    }
                    const json = await response.json();
                    if (!json || !json.data || !json.data.resourceSummaryList) throw new Error('排行榜响应格式异常：Resource ID ' + resourceId + '，第 ' + pageIndex + ' 页');
                    return json;
                  } catch (error) {
                    lastError = error?.name === 'AbortError'
                      ? new Error('排行榜分页请求超时：Resource ID ' + resourceId + '，第 ' + pageIndex + ' 页')
                      : error;
                    if (attempt < retries) {
                      const delay = error?.statusCode === 429
                        ? 1500 * (2 ** attempt) + Math.floor(Math.random() * 500)
                        : 350 * (attempt + 1);
                      await new Promise(resolve => setTimeout(resolve, delay));
                    }
                  } finally {
                    clearTimeout(timeout);
                  }
                }
                throw lastError || new Error('分页请求失败');
              };

              const valid = [];
              for (const resourceId of ids) {
                try {
                  const first = await requestPage(resourceId, 1, 100, 1);
                  const list = first.data.resourceSummaryList;
                  const total = Number(list.total ?? first.data.eligibleUserCount ?? 0);
                  const size = Array.isArray(list.data) ? list.data.length : 0;
                  if (total > 0 && size > 0) valid.push({ resourceId, first, total, effectivePageSize: size });
                } catch (_) {}
              }
              if (!valid.length) throw new Error('候选 Resource ID 均没有公开排行榜');
              let selected = configuredId ? valid.find(item => item.resourceId === configuredId) : null;
              if (configuredId && !selected) throw new Error('指定子赛道 Resource ID 暂无公开排行榜');
              if (!selected && preferredId) selected = valid.find(item => item.resourceId === preferredId);
              if (!selected) {
                const postClickSet = new Set(${JSON.stringify(postClickIds)});
                const postClickValid = valid.filter(item => postClickSet.has(item.resourceId));
                if (postClickValid.length === 1) selected = postClickValid[0];
                else if (valid.length === 1) selected = valid[0];
                else throw new Error('发现多个公开排行榜，无法安全判断主榜 Resource ID');
              }

              let seed = selected;
              for (let snapshotAttempt = 0; snapshotAttempt < 2; snapshotAttempt++) {
                const pageCount = Math.ceil(seed.total / seed.effectivePageSize);
                console.debug('__EVENTLENS_PAGE_COUNT__', pageCount);
                const pages = new Array(pageCount);
                pages[0] = seed.first;
                let cursor = 2;
                const workers = Array.from({ length: Math.min(6, Math.max(0, pageCount - 1)) }, async () => {
                  while (cursor <= pageCount) {
                    const pageIndex = cursor++;
                    pages[pageIndex - 1] = await requestPage(seed.resourceId, pageIndex, seed.effectivePageSize, 2);
                    await new Promise(resolve => setTimeout(resolve, 50 + Math.floor(Math.random() * 40)));
                  }
                });
                await Promise.all(workers);
                const totals = pages.map(page => Number(page?.data?.resourceSummaryList?.total ?? page?.data?.eligibleUserCount));
                if (totals.every(total => total === seed.total)) {
                  return { resourceId: seed.resourceId, pages, cutoffRank, tierCutoffs };
                }
                if (snapshotAttempt === 0) {
                  const refreshedFirst = await requestPage(seed.resourceId, 1, seed.effectivePageSize, 2);
                  const refreshedList = refreshedFirst.data.resourceSummaryList;
                  const refreshedTotal = Number(refreshedList.total ?? refreshedFirst.data.eligibleUserCount ?? 0);
                  const refreshedSize = Array.isArray(refreshedList.data) ? refreshedList.data.length : 0;
                  if (!(refreshedTotal > 0) || !(refreshedSize > 0)) throw new Error('排行榜人数变化后首页刷新失败');
                  seed = { ...seed, first: refreshedFirst, total: refreshedTotal, effectivePageSize: refreshedSize };
                  continue;
                }
                throw new Error('排行榜抓取期间总人数持续变化，请稍后重试');
              }
              throw new Error('排行榜完整分页重试失败');
            })(${JSON.stringify({
              ids: uniqueIds,
              preferredId: preferredResourceId,
              configuredId: configuredResourceId,
              endpoint: SUMMARY_ENDPOINT,
              cutoffRank,
              tierCutoffs: tiers.map(tier => tier.cutoffRank).filter(Boolean)
            })})`,
          awaitPromise: true,
          returnByValue: true
        });
        if (evalResult?.exceptionDetails) {
          throw new Error(evalResult.exceptionDetails.exception?.description || evalResult.exceptionDetails.text || "页面排行榜请求失败");
        }
        const result = evalResult?.result;
        if (result?.subtype === "error") throw new Error(result.description || "页面排行榜请求失败");
        const value = result?.value;
        if (!value?.pages?.length) throw new Error("未返回完整排行榜分页");
        onProgress?.(85, `已获取 ${value.pages.length} 页，正在进行完整性校验…`);
        const snapshot = buildExactSnapshot({
          resourceId: value.resourceId,
          pages: value.pages,
          cutoffRank: value.cutoffRank,
          tierCutoffs: value.tierCutoffs,
          collectedAt: new Date().toISOString()
        });
        if (eligiblePairs.length) snapshot.eligiblePairs = eligiblePairs;
        if (Object.keys(eligiblePairMultipliers).length) snapshot.eligiblePairMultipliers = eligiblePairMultipliers;
        onProgress?.(100, `完整抓取 ${snapshot.eligibleUserCount.toLocaleString("en-US")} 条排行榜记录`);
        finish(resolve, snapshot);
      } catch (error) {
        finish(reject, error);
      }
    };
  });
}

function campaignPatchFromSnapshot(campaign, snapshot) {
  const patch = {};
  if (snapshot.resourceId && campaign.resourceId !== snapshot.resourceId) patch.resourceId = snapshot.resourceId;
  if (Array.isArray(snapshot.eligiblePairs) && snapshot.eligiblePairs.length) {
    const existingPairs = Array.isArray(campaign.pairs) ? campaign.pairs : [];
    const extractedSet = new Set(snapshot.eligiblePairs);
    const isSafeSuperset = !existingPairs.length || existingPairs.every(pair => extractedSet.has(pair));
    if (isSafeSuperset && JSON.stringify(existingPairs) !== JSON.stringify(snapshot.eligiblePairs)) patch.pairs = snapshot.eligiblePairs;
    if (isSafeSuperset) {
      const multipliers = Object.fromEntries(Object.entries(snapshot.eligiblePairMultipliers || {}).filter(([pair, value]) =>
        extractedSet.has(pair) && Number.isFinite(value) && value > 0 && value <= 10));
      if (Object.keys(multipliers).length && Object.entries(multipliers).some(([pair, value]) => campaign.pairMultipliers?.[pair] !== value)) {
        patch.pairMultipliers = { ...(campaign.pairMultipliers || {}), ...multipliers };
      }
    }
  }
  return patch;
}

function findCampaignForImmediate(campaigns, targetCampaignId = null) {
  return targetCampaignId
    ? campaigns.find(item => item.id === String(targetCampaignId)) || null
    : campaigns.find(item => item.status === "active") || null;
}

class CrawlerScheduler {
  constructor(intervalMs = 30 * 60 * 1000) {
    this.intervalMs = Math.max(5 * 60 * 1000, Number(intervalMs) || 30 * 60 * 1000);
    this.timer = null;
    this.isRunning = false;
    this.lastRunTime = null;
    this.nextRunTime = null;
    this.lastStatus = "待命";
    this.progress = { active: false, percent: 0, text: "待命" };
  }

  start() {
    this.stop();
    this.nextRunTime = new Date(Date.now() + this.intervalMs).toISOString();
    this.timer = setInterval(() => {
      this.nextRunTime = new Date(Date.now() + this.intervalMs).toISOString();
      this.runBatch();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.nextRunTime = null;
  }

  getStatus() {
    return {
      enabled: Boolean(this.timer),
      intervalMinutes: Math.round(this.intervalMs / 60000),
      lastRunTime: this.lastRunTime,
      nextRunTime: this.nextRunTime,
      isRunning: this.isRunning,
      lastStatus: this.lastStatus,
      progress: this.progress
    };
  }

  async runImmediate(targetCampaignId = null) {
    if (this.isRunning) throw new Error("已有排行榜抓取任务正在执行");
    const campaigns = await storage.getCampaigns();
    const campaign = findCampaignForImmediate(campaigns, targetCampaignId);
    if (!campaign) throw new Error(targetCampaignId ? `未找到活动 [${targetCampaignId}]` : "没有可更新的进行中活动");
    if (!campaign.landingUrl) throw new Error("活动缺少排行榜链接");

    this.isRunning = true;
    this.lastRunTime = new Date().toISOString();
    this.lastStatus = `正在更新 ${campaign.name}`;
    this.progress = { active: true, percent: 5, text: "正在准备本地浏览器…" };
    try {
      const snapshot = await crawlLeaderboard(campaign, (percent, text) => {
        this.progress = { active: true, percent, text };
      });
      await storage.saveSnapshot(campaign.id, snapshot);
      const campaignPatch = campaignPatchFromSnapshot(campaign, snapshot);
      if (Object.keys(campaignPatch).length) await storage.updateCampaign(campaign.id, campaignPatch);
      this.lastStatus = `更新完成：${campaign.name}`;
      this.progress = { active: false, percent: 100, text: "排行榜完整性校验通过" };
      return snapshot;
    } catch (error) {
      await storage.markSnapshotCheck(campaign.id, error.message).catch(() => {});
      this.lastStatus = `更新失败：${error.message}`;
      this.progress = { active: false, percent: 0, text: this.lastStatus };
      throw error;
    } finally {
      this.isRunning = false;
    }
  }

  async runBatch() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.lastRunTime = new Date().toISOString();
    this.lastStatus = "正在检查进行中活动";
    let success = 0;
    let failed = 0;
    try {
      const campaigns = (await storage.getCampaigns()).filter(item => item.status === "active" && item.landingUrl);
      for (const campaign of campaigns) {
        try {
          const snapshot = await crawlLeaderboard(campaign);
          await storage.saveSnapshot(campaign.id, snapshot);
          const campaignPatch = campaignPatchFromSnapshot(campaign, snapshot);
          if (Object.keys(campaignPatch).length) await storage.updateCampaign(campaign.id, campaignPatch);
          success++;
        } catch (error) {
          failed++;
          await storage.markSnapshotCheck(campaign.id, error.message).catch(() => {});
          console.error(`[Scheduler] ${campaign.id}: ${error.message}`);
        }
      }
      this.lastStatus = `检查完成：成功 ${success}，失败 ${failed}`;
    } catch (error) {
      this.lastStatus = `更新异常：${error.message}`;
    } finally {
      this.isRunning = false;
    }
  }
}

module.exports = {
  findBrowserPath,
  getLeaderboardUrls,
  crawlLeaderboard,
  CrawlerScheduler,
  buildExactSnapshot,
  parseVolume,
  findSourceUpdatedAt,
  extractResourceListData,
  toMicros,
  microsToNumber,
  PAGE_LOAD_ATTEMPTS,
  getRequestedSubTrack,
  findConfiguredResourceId,
  extractEligiblePairsFromPageText,
  campaignPatchFromSnapshot,
  findCampaignForImmediate
};
