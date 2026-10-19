const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { makeDataDir, sampleSnapshot } = require("./helpers");

process.env.EVENTLENS_DATA_DIR = makeDataDir();
const { createServer } = require("../server");

async function open(options) {
  const server = createServer(options);
  await new Promise(resolve => server.listen(0, "0.0.0.0", resolve));
  return server;
}

function request(server, pathname, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1", port: server.address().port, path: pathname, method,
      headers: { Host: `server.example:${server.address().port}`, ...headers }
    }, res => {
      let content = "";
      res.setEncoding("utf8");
      res.on("data", chunk => { content += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: content }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("服务器模式支持远程 Host 的页面、资源和 API，保留写令牌与同源校验", async () => {
  const server = await open({ remoteAccess: true, accessPassword: "" });
  try {
    assert.equal(server.address().address, "0.0.0.0");
    for (const route of ["/", "/app.js", "/styles.css", "/api/health", "/api/campaigns"]) {
      assert.equal((await request(server, route)).status, 200, route);
    }
    const session = JSON.parse((await request(server, "/api/session")).body);
    assert.equal(session.desktop, false);
    const headers = {
      "Content-Type": "application/json",
      "X-EventLens-Token": session.token,
      Origin: `http://server.example:${server.address().port}`
    };
    const body = JSON.stringify({ campaignId: "sample-campaign", snapshot: sampleSnapshot() });
    assert.equal((await request(server, "/api/ranking/update", { method: "POST", headers, body })).status, 200);
    assert.equal((await request(server, "/api/ranking/update", {
      method: "POST", headers: { ...headers, "X-EventLens-Token": "invalid" }, body
    })).status, 403);
    for (const origin of ["https://evil.example", "http://server.example:1"]) {
      assert.equal((await request(server, "/api/ranking/update", {
        method: "POST", headers: { ...headers, Origin: origin }, body
      })).status, 403);
      assert.equal((await request(server, "/api/health", { method: "OPTIONS", headers: { Origin: origin } })).status, 403);
    }
    assert.equal((await request(server, "/api/ranking/update", {
      method: "POST", headers: { ...headers, Origin: `https://server.example:${server.address().port}` }, body
    })).status, 200);
    assert.equal((await request(server, "/api/desktop/stop", { method: "POST", headers })).status, 404);
    assert.equal((await request(server, "/api/desktop/page")).status, 404);
    assert.equal((await request(server, "/../server.js")).status, 403);
    assert.equal((await request(server, "/api/health")).status, 200);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test("可选访问密码保护页面和全部接口，不泄漏会话令牌，正确认证后仍需写令牌", async () => {
  const password = crypto.randomBytes(24).toString("hex");
  const server = await open({ remoteAccess: true, accessPassword: password });
  try {
    for (const route of ["/", "/app.js", "/api/health", "/api/session", "/api/campaigns"]) {
      const response = await request(server, route);
      assert.equal(response.status, 401);
      assert.match(response.headers["www-authenticate"], /^Basic /);
      assert.equal(JSON.parse(response.body).token, undefined);
    }
    for (const authorization of ["Basic !!!", `Basic ${Buffer.from("other:wrong").toString("base64")}`]) {
      assert.equal((await request(server, "/api/session", { headers: { Authorization: authorization } })).status, 401);
    }
    const headers = { Authorization: `Basic ${Buffer.from(`eventlens:${password}`).toString("base64")}` };
    assert.equal((await request(server, "/", { headers })).status, 200);
    assert.equal((await request(server, "/api/session", { headers })).status, 200);
    assert.equal((await request(server, "/api/campaigns/delete", {
      method: "POST", headers: { ...headers, Origin: `http://server.example:${server.address().port}` }, body: "{}"
    })).status, 403);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test("默认本地模式继续拒绝远程 Host", async () => {
  const server = await open({ remoteAccess: false, accessPassword: "" });
  try { assert.equal((await request(server, "/api/health")).status, 403); }
  finally { await new Promise(resolve => server.close(resolve)); }
});

test("自定义网页用户名可以登录，默认用户名不能凭同一密码登录", async () => {
  const password = crypto.randomBytes(24).toString("hex");
  const server = await open({ remoteAccess: true, accessUsername: "webadmin", accessPassword: password });
  try {
    for (const [username, expectedStatus] of [["webadmin", 200], ["eventlens", 401]]) {
      const response = await request(server, "/api/session", {
        headers: { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` }
      });
      assert.equal(response.status, expectedStatus);
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test("安装器健康检查使用自定义账号，特殊字符密码不进入输出", { timeout: 15000 }, async () => {
  const password = 'space $HOME `id` "quote" \\ slash \'single\' %percent 中文';
  const server = await open({ remoteAccess: true, accessUsername: "webadmin", accessPassword: password });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "eventlens-install-health-"));
  const child = spawn("bash", ["-c", `
    source "$EVENTLENS_TEST_INSTALLER"
    NODE_BIN="$EVENTLENS_TEST_NODE"
    INSTALL_TEMP="$EVENTLENS_TEST_DIRECTORY"
    WEB_USERNAME=webadmin
    WEB_PASSWORD="$EVENTLENS_TEST_PASSWORD"
    WEB_PORT="$EVENTLENS_TEST_PORT"
    sleep() { return 1; }
    check_health
  `], {
    env: {
      ...process.env, EVENTLENS_TEST_INSTALLER: path.join(__dirname, "../install-linux.sh"),
      EVENTLENS_TEST_NODE: process.execPath, EVENTLENS_TEST_DIRECTORY: directory,
      EVENTLENS_TEST_PASSWORD: password, EVENTLENS_TEST_PORT: String(server.address().port)
    }, stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", data => { output += data; });
  child.stderr.on("data", data => { output += data; });
  const stopped = once(child, "exit");
  try {
    const [code] = await stopped;
    assert.equal(code, 0, "安装器认证健康检查失败");
    assert.equal(output.includes(password), false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await stopped;
    await new Promise(resolve => server.close(resolve));
  }
});

test("服务器启动命令优先于桌面模式，不启用桌面退出机制", { timeout: 15000 }, async () => {
  const reservation = http.createServer();
  await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const dataDir = makeDataDir();
  fs.writeFileSync(path.join(dataDir, "settings.json"), '{"autoUpdateEnabled":false}');
  const child = spawn(process.execPath, [path.join(__dirname, "../server.js"), "--server"], {
    env: { ...process.env, PORT: String(port), EVENTLENS_DATA_DIR: dataDir, EVENTLENS_DESKTOP: "1", EVENTLENS_ACCESS_PASSWORD: "" },
    stdio: "ignore"
  });
  const stopped = once(child, "exit");
  try {
    let response;
    for (let attempt = 0; attempt < 80; attempt++) {
      assert.equal(child.exitCode, null, "服务器进程提前退出");
      try {
        response = await fetch(`http://127.0.0.1:${port}/api/session`, { signal: AbortSignal.timeout(500) });
        if (response.ok) break;
      } catch (_) {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(response?.ok, "服务器未能启动");
    assert.equal((await response.json()).desktop, false);
    const remote = await request({ address: () => ({ port }) }, "/");
    assert.equal(remote.status, 200);
    assert.equal((await request({ address: () => ({ port }) }, "/api/desktop/stop", { method: "POST" })).status, 404);
    assert.equal(child.exitCode, null);
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
    await stopped;
  }
});
