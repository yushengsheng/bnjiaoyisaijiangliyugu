const http = require("node:http");
const https = require("node:https");
const { readTlsConfig, loadTlsOptions } = require("./lib/tls");
const url = require("node:url");
const path = require("node:path");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");

const storage = require("./lib/storage");
const binanceApi = require("./lib/binance-api");
const parser = require("./lib/parser");
const market = require("./lib/market");
const ranking = require("./lib/ranking");
const prophet = require("./lib/prophet");
const { CrawlerScheduler } = require("./lib/crawler");
const APP_VERSION = require("./package.json").version;
const { runtimeIdentity, createPageLifetime } = require("./lib/desktop");
const identity = runtimeIdentity();
const serverMode = process.argv.includes("--server") || process.env.EVENTLENS_SERVER === "1";
const desktopMode = !serverMode && process.env.EVENTLENS_DESKTOP === "1";
let pageLifetime;
let requestShutdown;

const PORT = Number(process.env.PORT) || 3000;
const HOST = serverMode ? "0.0.0.0" : "127.0.0.1";
const PUBLIC_DIR = path.resolve(__dirname, "public");
const schedulerIntervalMinutes = Math.max(5, Number.parseInt(process.env.CRAWL_INTERVAL_MINUTES || "30", 10) || 30);
const scheduler = new CrawlerScheduler(schedulerIntervalMinutes * 60 * 1000);
const sessionToken = crypto.randomBytes(32).toString("base64url");
let prophetRefreshing = false;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

const MUTATION_PATHS = new Set([
  "/api/desktop/stop",
  "/api/campaigns/add-by-url",
  "/api/campaigns/delete",
  "/api/announcements/parse",
  "/api/ranking/update",
  "/api/scheduler/trigger",
  "/api/scheduler/config",
  "/api/prophet/refresh",
  "/api/prophet/ranks"
]);

function securityHeaders(contentType = "application/json; charset=utf-8") {
  return {
    "Content-Type": contentType,
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Content-Security-Policy": "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
  };
}

function sendJson(res, statusCode, data) {
  const json = JSON.stringify(data);
  res.writeHead(statusCode, {
    ...securityHeaders(),
    "Cache-Control": "no-store, max-age=0",
    "Pragma": "no-cache"
  });
  res.end(json);
}

function compareCampaignEnd(a, b, direction) {
  const left = Date.parse(a.endTime);
  const right = Date.parse(b.endTime);
  if (!Number.isFinite(left)) return Number.isFinite(right) ? 1 : 0;
  if (!Number.isFinite(right)) return -1;
  return direction * (left - right);
}

function sendError(res, statusCode, message, detail = null) {
  const body = { error: message };
  if (detail && process.env.NODE_ENV !== "production") body.detail = String(detail);
  sendJson(res, statusCode, body);
}

function isLoopbackAddress(address = "") {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function isLocalHostHeader(host = "") {
  const normalized = String(host).trim().toLowerCase();
  return /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(normalized);
}

function isAllowedOrigin(origin, hostHeader, remoteAccess = false) {
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    const expectedHost = String(hostHeader || "").trim().toLowerCase();
    return (remoteAccess ? ["http:", "https:"].includes(parsed.protocol) : parsed.protocol === "http:") &&
      (remoteAccess || ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)) &&
      parsed.host.toLowerCase() === expectedHost;
  } catch (_) {
    return false;
  }
}

function requireLocalRequest(req, res, remoteAccess = false) {
  if (!remoteAccess && (!isLoopbackAddress(req.socket.remoteAddress) || !isLocalHostHeader(req.headers.host))) {
    sendError(res, 403, "仅允许本机访问");
    return false;
  }
  return true;
}

function requireMutationAccess(req, res, remoteAccess = false) {
  if (!isAllowedOrigin(req.headers.origin, req.headers.host, remoteAccess)) {
    sendError(res, 403, "拒绝跨站写操作");
    return false;
  }
  const provided = String(req.headers["x-eventlens-token"] || "");
  const expected = Buffer.from(sessionToken);
  const actual = Buffer.from(provided);
  if (actual.byteLength !== expected.byteLength || !crypto.timingSafeEqual(expected, actual)) {
    sendError(res, 403, "本地会话令牌无效，请刷新页面");
    return false;
  }
  return true;
}

function requireAccessPassword(req, res, password, username) {
  if (!password) return true;
  const authorization = String(req.headers.authorization || "");
  const match = authorization.match(/^Basic ([A-Za-z0-9+/]+={0,2})$/i);
  const supplied = match ? Buffer.from(match[1], "base64") : Buffer.alloc(0);
  const expected = Buffer.from(`${username}:${password}`);
  if (supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected)) return true;
  res.writeHead(401, {
    ...securityHeaders(),
    "Cache-Control": "no-store",
    "WWW-Authenticate": 'Basic realm="EventLens", charset="UTF-8"'
  });
  res.end(JSON.stringify({ error: "请输入访问用户名和密码" }));
  return false;
}

async function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    req.setEncoding("utf8");
    req.on("data", chunk => {
      if (settled) return;
      raw += chunk;
      if (Buffer.byteLength(raw, "utf8") > 1_000_000) {
        const error = new Error("请求体超过 1MB 限制");
        error.statusCode = 413;
        finish(reject, error);
      }
    });
    req.on("end", () => {
      if (settled) return;
      if (!raw) return finish(resolve, {});
      try {
        const body = JSON.parse(raw);
        if (!body || Array.isArray(body) || typeof body !== "object") throw new Error("请求体必须是 JSON 对象");
        finish(resolve, body);
      } catch (_) {
        const error = new Error("无效的 JSON 请求体");
        error.statusCode = 400;
        finish(reject, error);
      }
    });
    req.on("error", error => finish(reject, error));
  });
}

async function getRequiredCampaign(campaignId, res) {
  const campaign = await storage.getCampaignById(campaignId);
  if (!campaign) {
    sendError(res, 404, `未找到活动 [${campaignId}]`);
    return null;
  }
  return campaign;
}

function requiresExactSubTrack(campaign) {
  if (!campaign?.landingUrl) return false;
  try {
    const meta = parser.extractCampaignMetaFromUrl(campaign.landingUrl);
    return /tradersleague|traders[-_ ]?league|交易者联赛/i.test(`${meta.mainId} ${campaign.name || ""}`);
  } catch (_) {
    return false;
  }
}

function createServer({
  remoteAccess = serverMode,
  accessPassword = process.env.EVENTLENS_ACCESS_PASSWORD || "",
  accessUsername = process.env.EVENTLENS_ACCESS_USERNAME || "eventlens",
  tlsConfig = remoteAccess ? readTlsConfig() : null
} = {}) {
  const listener = async (req, res) => {
    if (!requireLocalRequest(req, res, remoteAccess)) return;
    if (!requireAccessPassword(req, res, accessPassword, accessUsername)) return;

    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname || "/";
    const query = parsedUrl.query;

    if (remoteAccess && pathname.startsWith("/api/desktop/")) return sendError(res, 404, "服务器模式不提供桌面生命周期接口");

    if (req.method === "OPTIONS") {
      if (!isAllowedOrigin(req.headers.origin, req.headers.host, remoteAccess)) return sendError(res, 403, "拒绝跨站请求");
      res.writeHead(204, securityHeaders());
      return res.end();
    }

    if (MUTATION_PATHS.has(pathname) && !requireMutationAccess(req, res, remoteAccess)) return;

    try {
      if (pathname === "/api/health" && req.method === "GET") {
        return sendJson(res, 200, { ok: true, app: "eventlens-local", version: APP_VERSION, ...identity, desktop: desktopMode });
      }

      if (pathname === "/api/session" && req.method === "GET") {
        return sendJson(res, 200, { token: sessionToken, desktop: !remoteAccess && desktopMode });
      }

      if (pathname === "/api/prophet" && req.method === "GET") {
        return sendJson(res, 200, { snapshot: await storage.getProphetSnapshot(), refreshing: prophetRefreshing });
      }
      if (pathname === "/api/prophet/refresh" && req.method === "POST") {
        await parseBody(req);
        if (prophetRefreshing) return sendError(res, 429, "神算子正在刷新，请勿重复提交");
        prophetRefreshing = true;
        try {
          const snapshot = await prophet.collect();
          await storage.saveProphetSnapshot(snapshot);
          return sendJson(res, 200, { snapshot });
        } finally { prophetRefreshing = false; }
      }
      if (pathname === "/api/prophet/ranks" && req.method === "POST") {
        const body = await parseBody(req);
        if (prophetRefreshing) return sendError(res, 429, "神算子正在获取数据，请稍后重试");
        prophetRefreshing = true;
        try {
          const snapshot = await storage.getProphetSnapshot();
          if (body.board === "weekly" && body.weekIndex !== snapshot?.week?.weekIndex) {
            return sendError(res, 409, "周榜周次已变化，请先刷新榜单再查看明细");
          }
          return sendJson(res, 200, await prophet.getRanks(body));
        } finally { prophetRefreshing = false; }
      }

      if (pathname === "/api/desktop/page" && req.method === "GET") {
        req.headers["x-eventlens-token"] = query.token;
        if (!requireMutationAccess(req, res)) return;
        if (!pageLifetime) { res.writeHead(204, securityHeaders()); return res.end(); }
        return pageLifetime.attach(req, res);
      }
      if (pathname === "/api/desktop/stop" && req.method === "POST") {
        if (!requestShutdown) return sendError(res, 409, "当前服务由测试程序管理");
        sendJson(res, 200, { ok: true });
        setImmediate(requestShutdown);
        return;
      }

      if (pathname === "/api/campaigns/add-by-url" && req.method === "POST") {
        const body = await parseBody(req);
        if (!body.url) return sendError(res, 400, "请输入币安排行榜链接");
        let campaign;
        try {
          campaign = await parser.createCampaignFromLeaderboardUrl(body.url);
        } catch (error) {
          error.statusCode = 400;
          throw error;
        }
        campaign = await storage.upsertCampaign(campaign);

        let snapshot = null;
        let crawlWarning = null;
        try {
          // 与手动刷新、定时采集共用互斥，并按落库后保留的规则采集。
          snapshot = await scheduler.runImmediate(campaign.id);
          if (snapshot) {
            campaign = await storage.getCampaignById(campaign.id);
          } else crawlWarning = "活动已录入，但暂未读取到公开排行榜数据";
        } catch (error) {
          crawlWarning = error.message;
          await storage.markSnapshotCheck(campaign.id, error.message);
        }

        return sendJson(res, 200, {
          success: true,
          campaign,
          snapshot,
          warning: crawlWarning,
          message: crawlWarning ? `已录入 ${campaign.name}；${crawlWarning}` : `已录入并更新 ${campaign.name}`
        });
      }

      if (pathname === "/api/campaigns/delete" && req.method === "POST") {
        const body = await parseBody(req);
        if (!body.id) return sendError(res, 400, "缺少活动 ID");
        const result = await storage.deleteCampaign(body.id);
        if (!result.deleted) return sendError(res, 404, "活动不存在");
        return sendJson(res, 200, { success: true, message: "活动已删除" });
      }

      if (pathname === "/api/campaigns" && req.method === "GET") {
        const all = await storage.getCampaigns();
        // 仅合并展示，不写入交易赛存储或调度队列；损坏的积分快照也不阻断交易赛列表。
        all.push(prophet.getActivity(await storage.getProphetSnapshot().catch(() => null)));
        return sendJson(res, 200, {
          source: "local-file",
          groups: {
            active: all.filter(c => c.status === "active" || c.status === "upcoming" || c.status === "needs-review")
              .sort((a, b) => compareCampaignEnd(a, b, 1)),
            history: all.filter(c => c.status === "history")
              .sort((a, b) => compareCampaignEnd(a, b, -1))
          }
        });
      }

      if (pathname === "/api/prices" && req.method === "GET") {
        const symbol = String(query.symbol || "BNBUSDT").toUpperCase();
        try {
          return sendJson(res, 200, await binanceApi.getTickerPrice(symbol));
        } catch (error) {
          return sendError(res, 503, "实时价格暂不可用", error.message);
        }
      }

      if (pathname === "/api/binance/market" && req.method === "GET") {
        if (!query.campaignId) return sendError(res, 400, "缺少 campaignId 参数");
        const campaign = await getRequiredCampaign(query.campaignId, res);
        if (!campaign) return;
        const data = await market.getCampaignMarketAnalysis(campaign.id, {
          feeRate: query.feeRate,
          rebateRate: query.rebateRate
        });
        return sendJson(res, 200, data);
      }

      if (pathname === "/api/binance/ranking" && req.method === "GET") {
        if (!query.campaignId) return sendError(res, 400, "缺少 campaignId 参数");
        const campaign = await getRequiredCampaign(query.campaignId, res);
        if (!campaign) return;
        return sendJson(res, 200, await ranking.getCampaignRanking(campaign.id));
      }

      if (pathname === "/api/ranking/history" && req.method === "GET") {
        if (!query.campaignId) return sendError(res, 400, "缺少 campaignId 参数");
        const campaign = await getRequiredCampaign(query.campaignId, res);
        if (!campaign) return;
        const entries = await storage.getSnapshotHistory(campaign.id, query.limit);
        return sendJson(res, 200, { campaignId: campaign.id, entries });
      }

      if (pathname === "/api/announcements/list" && req.method === "GET") {
        try {
          const list = await binanceApi.getAnnouncementList(93, 1, 20);
          return sendJson(res, 200, { articles: list });
        } catch (error) {
          return sendError(res, 503, "获取币安活动公告列表失败", error.message);
        }
      }

      if (pathname === "/api/announcements/parse" && req.method === "POST") {
        const body = await parseBody(req);
        if (!body.urlOrCode) return sendError(res, 400, "请输入公告链接或 articleCode");
        const articleCode = parser.parseArticleCode(body.urlOrCode);
        if (!articleCode) return sendError(res, 400, "公告链接或 articleCode 无效");
        let articleDetail;
        try {
          articleDetail = await binanceApi.getAnnouncementDetail(articleCode);
        } catch (error) {
          error.statusCode = 503;
          throw error;
        }
        const parsedCampaign = parser.parseAnnouncement(articleDetail);
        if (requiresExactSubTrack(parsedCampaign)) {
          return sendError(res, 400, "该公告包含多个独立赛道，请粘贴具体 Round/子赛道排行榜链接，避免保存错误规则");
        }
        await storage.upsertCampaign(parsedCampaign);
        return sendJson(res, 200, {
          success: true,
          campaign: parsedCampaign,
          message: parsedCampaign.needsReview
            ? `已录入 ${parsedCampaign.name}，部分规则需要人工核对`
            : `成功解析并录入活动：${parsedCampaign.name}`
        });
      }

      if (pathname === "/api/ranking/update" && req.method === "POST") {
        const body = await parseBody(req);
        if (!body.campaignId || !body.snapshot) return sendError(res, 400, "参数不完整");
        const campaign = await getRequiredCampaign(body.campaignId, res);
        if (!campaign) return;
        try {
          const saved = await storage.saveSnapshot(campaign.id, body.snapshot);
          return sendJson(res, 200, { success: true, snapshot: saved });
        } catch (error) {
          if (/^(?:排行榜(?:快照|人数|交易量)|前1000名)/.test(error.message)) error.statusCode = 400;
          throw error;
        }
      }

      if (pathname === "/api/scheduler/status" && req.method === "GET") {
        return sendJson(res, 200, scheduler.getStatus());
      }

      if (pathname === "/api/scheduler/config" && req.method === "POST") {
        const body = await parseBody(req);
        if (typeof body.autoUpdateEnabled !== "boolean") return sendError(res, 400, "autoUpdateEnabled 必须是布尔值");
        const settings = await storage.saveSchedulerSettings({ autoUpdateEnabled: body.autoUpdateEnabled });
        if (settings.autoUpdateEnabled) scheduler.start();
        else scheduler.stop();
        return sendJson(res, 200, { success: true, settings, status: scheduler.getStatus() });
      }

      if (pathname === "/api/scheduler/trigger" && req.method === "POST") {
        const body = await parseBody(req);
        if (scheduler.isRunning) return sendError(res, 429, "当前已有排行榜抓取任务正在执行");
        const targetCampaign = body.campaignId
          ? await getRequiredCampaign(body.campaignId, res)
          : (await storage.getCampaigns()).find(item => item.status === "active") || null;
        if (!targetCampaign) {
          if (body.campaignId) return;
          return sendError(res, 404, "没有可更新的进行中活动");
        }
        const snapshot = await scheduler.runImmediate(targetCampaign.id);
        if (!snapshot) return sendError(res, 502, "未读取到有效排行榜，已保留上一次成功数据");

        const rankingData = await ranking.getCampaignRanking(targetCampaign.id);
        const marketData = await market.getCampaignMarketAnalysis(targetCampaign.id, {
          feeRate: body.feeRate,
          rebateRate: body.rebateRate
        }).catch(() => null);
        return sendJson(res, 200, {
          success: true,
          snapshot,
          rankingData,
          marketData,
          status: scheduler.getStatus(),
          message: "排行榜已更新"
        });
      }

      if (!['GET', 'HEAD'].includes(req.method)) return sendError(res, 405, "请求方法不支持");

      let decodedPath;
      try {
        decodedPath = decodeURIComponent(pathname);
      } catch (_) {
        return sendError(res, 400, "无效的 URL 路径");
      }
      const relativePath = decodedPath === "/" ? "index.html" : decodedPath.replace(/^\/+/, "");
      const filePath = path.resolve(PUBLIC_DIR, relativePath);
      if (filePath !== PUBLIC_DIR && !filePath.startsWith(`${PUBLIC_DIR}${path.sep}`)) {
        return sendError(res, 403, "禁止访问 public 目录之外的文件");
      }

      try {
        let finalPath = filePath;
        const stat = await fs.stat(finalPath);
        if (stat.isDirectory()) finalPath = path.join(finalPath, "index.html");
        const contentType = MIME_TYPES[path.extname(finalPath).toLowerCase()] || "application/octet-stream";
        let content = await fs.readFile(finalPath);
        if (contentType.startsWith("text/html")) {
          content = content.toString().replace(/(href|src)="(styles\.css|app\.js|lifecycle\.js)"/g,
            (_, attr, file) => `${attr}="${file}?v=${identity.buildId}"`);
        }
        res.writeHead(200, {
          ...securityHeaders(contentType),
          "Cache-Control": "no-store, max-age=0"
        });
        if (req.method === "HEAD") return res.end();
        return res.end(content);
      } catch (error) {
        if (error.code === "ENOENT" || error.code === "ENOTDIR") return sendError(res, 404, "页面或接口未找到");
        throw error;
      }
    } catch (error) {
      const statusCode = error.statusCode || 500;
      if (statusCode === 502 || statusCode === 503) console.warn(`[Upstream] ${error.message}`);
      else if (statusCode >= 500) console.error("Server Error:", error);
      return sendError(res, statusCode, error.statusCode ? error.message : "服务器内部错误", error.message);
    }
  };
  if (!tlsConfig) return http.createServer(listener);
  const server = https.createServer(loadTlsOptions(tlsConfig), listener);
  server.reloadTls = () => server.setSecureContext(loadTlsOptions(tlsConfig));
  return server;
}

const server = createServer();
server.scheduler = scheduler;
server.sessionToken = sessionToken;

if (require.main === module) {
  let shuttingDown = false;
  requestShutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    scheduler.stop();
    pageLifetime?.dispose();
    server.close();
    server.closeAllConnections();
    const deadline = setTimeout(() => process.exit(0), 5000);
    deadline.unref();
    await storage.waitForWrites();
    process.exit(0);
  };
  if (desktopMode) pageLifetime = createPageLifetime(requestShutdown);
  (async () => {
    const settings = await storage.getSchedulerSettings();
    if (settings.autoUpdateEnabled) scheduler.start();
    server.listen(PORT, HOST, () => {
      console.log("\n======================================================");
      console.log(`  EventLens ${serverMode ? "服务器" : "本地"}交易赛分析服务已启动`);
      console.log(serverMode ? `  访问地址: ${server.reloadTls ? "https" : "http"}://<服务器IP>:${PORT}` : `  访问地址: http://${HOST}:${PORT}`);
      console.log(`  排行榜自动更新: ${settings.autoUpdateEnabled ? `每 ${schedulerIntervalMinutes} 分钟` : "已关闭（仅手动）"}`);
      console.log(serverMode ? `  已开放远程访问；访问密码${process.env.EVENTLENS_ACCESS_PASSWORD ? "已设置" : "未设置"}` : "  服务仅监听本机回环地址，不接受局域网或公网访问");
      console.log("======================================================\n");
    });
  })().catch(error => {
    console.error("启动失败:", error);
    process.exit(1);
  });

  if (server.reloadTls) process.on("SIGHUP", () => {
    try { server.reloadTls(); console.log("HTTPS 证书已重新加载"); }
    catch (_) { console.error("HTTPS 证书重新加载失败，继续使用原证书；请在本机检查证书文件"); }
  });
  process.on("SIGINT", requestShutdown);
  process.on("SIGTERM", requestShutdown);
}

module.exports = server;
module.exports.createServer = createServer;
