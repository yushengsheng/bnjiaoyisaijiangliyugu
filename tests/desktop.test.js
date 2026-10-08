const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { createPageLifetime } = require("../lib/desktop");
const { makeDataDir } = require("./helpers");

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test("页面连接在刷新和多标签页关闭时正确计数，后台连接不依赖前端心跳", async () => {
  let stops = 0;
  const life = createPageLifetime(() => stops++, { startupMs: 200, idleMs: 100 });
  const server = http.createServer((req, res) => life.attach(req, res));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const controllers = [];
  async function page() {
    const controller = new AbortController();
    controllers.push(controller);
    const response = await fetch(base, { signal: controller.signal });
    await response.body.getReader().read();
    return controller;
  }
  try {
    const first = await page();
    const second = await page();
    first.abort();
    await sleep(250);
    assert.equal(stops, 0, "另一个页面仍打开，不应停服");
    second.abort();
    const refreshed = await page();
    await sleep(250);
    assert.equal(stops, 0, "页面刷新重连不应停服");
    refreshed.abort();
    await sleep(250);
    assert.equal(stops, 1);
  } finally {
    controllers.forEach(c => c.abort());
    life.dispose(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test("浏览器未打开也会超时退出，销毁后不会重复停服", async () => {
  let stops = 0;
  const life = createPageLifetime(() => stops++, { startupMs: 30 });
  await sleep(90);
  assert.equal(stops, 1);
  life.dispose();
  await sleep(60);
  assert.equal(stops, 1);
});

test("后台启动器替换旧常驻实例、重复打开复用，资源更新且关闭最后页面后退出", { timeout: 30000 }, async () => {
  const reservation = http.createServer();
  await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  process.env.PORT = String(port);
  process.env.EVENTLENS_DATA_DIR = makeDataDir();
  const fs = require("node:fs");
  const path = require("node:path");
  fs.writeFileSync(path.join(process.env.EVENTLENS_DATA_DIR, "settings.json"), '{"autoUpdateEnabled":false}');
  const { launch } = require("../scripts/launch-desktop");
  const base = `http://127.0.0.1:${port}`;
  const opened = [];
  const openPage = url => { opened.push(url); return { status: 0 }; };
  const { spawn } = require("node:child_process");
  const manual = spawn(process.execPath, [path.join(__dirname, "../server.js")], {
    env: { ...process.env, EVENTLENS_DESKTOP: "0" }, stdio: "ignore"
  });
  let controller;
  let token;
  try {
    let oldSession;
    for (let i = 0; i < 50; i++) {
      try { oldSession = await (await fetch(`${base}/api/session`)).json(); break; }
      catch (_) { await sleep(100); }
    }
    assert.equal(oldSession?.desktop, false);
    await launch({ openPage });
    const session = await (await fetch(`${base}/api/session`)).json();
    token = session.token;
    assert.notEqual(token, oldSession.token, "常驻模式应自动替换为后台页面模式");
    assert.equal(session.desktop, true);
    assert.equal((await fetch(`${base}/api/desktop/page?token=wrong`)).status, 403);
    assert.equal((await fetch(`${base}/api/desktop/stop`, { method: "POST" })).status, 403);
    controller = new AbortController();
    const connection = await fetch(`${base}/api/desktop/page?token=${token}`, { signal: controller.signal });
    await connection.body.getReader().read();
    await launch({ openPage });
    assert.equal((await (await fetch(`${base}/api/session`)).json()).token, token);
    assert.equal(opened.length, 2);
    assert.match(opened[0], /\?launch=[a-f0-9]+$/);
    const response = await fetch(base);
    assert.match(response.headers.get("cache-control"), /no-store/);
    const html = await response.text();
    for (const asset of ["styles.css", "app.js", "lifecycle.js"]) {
      assert.ok(html.includes(`${asset}?v=`));
      assert.match((await fetch(`${base}/${asset}`)).headers.get("cache-control"), /no-store/);
    }
    controller.abort();
    let stopped = false;
    for (let i = 0; i < 70; i++) {
      await sleep(200);
      try { await fetch(`${base}/api/health`); } catch (_) { stopped = true; break; }
    }
    assert.equal(stopped, true, "最后一个页面关闭后端口应释放");
  } finally {
    controller?.abort();
    if (token) await fetch(`${base}/api/desktop/stop`, { method: "POST", headers: { Origin: base, "X-EventLens-Token": token } }).catch(() => {});
    if (manual.exitCode === null) manual.kill("SIGTERM");
  }
});
