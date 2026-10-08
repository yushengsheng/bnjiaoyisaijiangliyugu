const http = require("node:http");
const url = require("node:url");
const path = require("node:path");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");

const storage = require("./lib/storage");
const binanceApi = require("./lib/binance-api");
const parser = require("./lib/parser");
const market = require("./lib/market");
const ranking = require("./lib/ranking");
const { CrawlerScheduler, crawlLeaderboard, campaignPatchFromSnapshot } = require("./lib/crawler");
const APP_VERSION = require("./package.json").version;
const { runtimeIdentity, createPageLifetime } = require("./lib/desktop");
const identity = runtimeIdentity();
const desktopMode = process.env.EVENTLENS_DESKTOP === "1";
let pageLifetime;
let requestShutdown;

const PORT = Number(process.env.PORT) || 3000;
const HOST = "127.0.0.1";
const PUBLIC_DIR = path.resolve(__dirname, "public");
const schedulerIntervalMinutes = Math.max(5, Number.parseInt(process.env.CRAWL_INTERVAL_MINUTES || "30", 10) || 30);
const scheduler = new CrawlerScheduler(schedulerIntervalMinutes * 60 * 1000);
const sessionToken = crypto.randomBytes(32).toString("base64url");

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
  "/api/scheduler/config"
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

function isAllowedOrigin(origin, hostHeader) {
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    const expectedHost = String(hostHeader || "").trim().toLowerCase();
    return parsed.protocol === "http:" &&
      ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname) &&
      parsed.host.toLowerCase() === expectedHost;
  } catch (_) {
    return false;
  }
}

function requireLocalRequest(req, res) {
  if (!isLoopbackAddress(req.socket.remoteAddress) || !isLocalHostHeader(req.headers.host)) {
    sendError(res, 403, "仅允许本机访问");
    return false;
  }
  return true;
}

function requireMutationAccess(req, res) {
  if (!isAllowedOrigin(req.headers.origin, req.headers.host)) {
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
        finish(resolve, JSON.parse(raw));
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

function createServer() {
  return http.createServer(async (req, res) => {
    if (!requireLocalRequest(req, res)) return;

    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname || "/";
    const query = parsedUrl.query;

    if (req.method === "OPTIONS") {
      if (!isAllowedOrigin(req.headers.origin, req.headers.host)) return sendError(res, 403, "拒绝跨站请求");
      res.writeHead(204, securityHeaders());
      return res.end();
    }

    if (MUTATION_PATHS.has(pathname) && !requireMutationAccess(req, res)) return;

    try {
      if (pathname === "/api/health" && req.method === "GET") {
        return sendJson(res, 200, { ok: true, app: "eventlens-local", version: APP_VERSION, ...identity, desktop: desktopMode });
      }

      if (pathname === "/api/session" && req.method === "GET") {
        return sendJson(res, 200, { token: sessionToken, desktop: desktopMode });
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
        await storage.upsertCampaign(campaign);

        let snapshot = null;
        let crawlWarning = null;
        try {
          snapshot = await crawlLeaderboard(campaign);
          if (snapshot) {
            await storage.saveSnapshot(campaign.id, snapshot);
            const campaignPatch = campaignPatchFromSnapshot(campaign, snapshot);
            if (Object.keys(campaignPatch).length) campaign = await storage.updateCampaign(campaign.id, campaignPatch);
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
          if (/^排行榜(?:快照|人数|交易量)/.test(error.message)) error.statusCode = 400;
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
  });
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
      console.log("  EventLens 本地交易赛分析服务已启动");
      console.log(`  访问地址: http://${HOST}:${PORT}`);
      console.log(`  排行榜自动更新: ${settings.autoUpdateEnabled ? `每 ${schedulerIntervalMinutes} 分钟` : "已关闭（仅手动）"}`);
      console.log("  服务仅监听本机回环地址，不接受局域网或公网访问");
      console.log("======================================================\n");
    });
  })().catch(error => {
    console.error("启动失败:", error);
    process.exit(1);
  });

  process.on("SIGINT", requestShutdown);
  process.on("SIGTERM", requestShutdown);
}

module.exports = server;
module.exports.createServer = createServer;
