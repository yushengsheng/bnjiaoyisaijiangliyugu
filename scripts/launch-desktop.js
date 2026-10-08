const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { runtimeIdentity } = require("../lib/desktop");

const root = path.resolve(__dirname, "..");
const base = `http://127.0.0.1:${Number(process.env.PORT) || 3000}`;
const identity = runtimeIdentity(root);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const dataDir = process.env.EVENTLENS_DATA_DIR || path.join(root, "data");
fs.mkdirSync(dataDir, { recursive: true });
const logPath = path.join(dataDir, "desktop.log");

async function health() {
  try {
    const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000), cache: "no-store" });
    if (!response.ok) return { app: "unknown" };
    return await response.json();
  } catch (error) {
    if (error.cause?.code === "ECONNREFUSED") return null;
    throw new Error("无法确认本地端口状态，请稍后重试");
  }
}

async function launch({ openPage = url => spawnSync("/usr/bin/open", [url]) } = {}) {
  let current = await health();
  if (current && (current.app !== "eventlens-local" || current.projectId !== identity.projectId)) {
    throw new Error("端口已被其他服务或旧版服务占用。请先关闭原有 EventLens 终端窗口，再双击打开.app。");
  }
  if (current && (current.buildId !== identity.buildId || !current.desktop)) {
    const { token } = await (await fetch(`${base}/api/session`)).json();
    const response = await fetch(`${base}/api/desktop/stop`, { method: "POST", headers: { Origin: base, "X-EventLens-Token": token } });
    if (!response.ok) throw new Error("旧版服务未能退出，请关闭后重试");
    for (let i = 0; i < 50 && current; i++) { await delay(100); current = await health(); }
    if (current) throw new Error("旧版服务仍在关闭，请稍后重试");
  }
  if (!current) {
    const log = fs.openSync(logPath, "a");
    const child = spawn(process.execPath, [path.join(root, "server.js")], {
      cwd: root, detached: true, stdio: ["ignore", log, log],
      env: { ...process.env, EVENTLENS_DESKTOP: "1" }
    });
    fs.closeSync(log);
    child.on("error", error => fs.appendFileSync(logPath, `${error.message}\n`));
    child.unref();
    for (let i = 0; i < 100; i++) {
      await delay(100);
      current = await health();
      if (current) break;
    }
  }
  if (!current?.desktop || current.projectId !== identity.projectId || current.buildId !== identity.buildId) throw new Error("后台服务启动失败，请查看日志");
  const result = openPage(`${base}/?launch=${identity.buildId}`);
  if (result.status !== 0) throw new Error("无法打开默认浏览器");
}

if (require.main === module) launch().catch(error => {
  fs.appendFileSync(logPath, `${new Date().toISOString()} ${error.message}\n`);
  console.error(error.message);
  process.exitCode = 1;
});

module.exports = { launch };
