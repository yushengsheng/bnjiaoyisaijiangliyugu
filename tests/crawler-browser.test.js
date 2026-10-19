const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const parser = require("../lib/parser");

function launchProbe(platform, exitCode = null) {
  const launches = [];
  const removedProfiles = [];
  const exitHandlers = new Set();
  let stops = 0;
  let endpointRequests = 0;
  const dependencies = {
    "node:child_process": {
      spawn(browser, args, options) {
        launches.push({ browser, args, options });
        return { exitCode, kill() { stops++; return true; } };
      }
    },
    "node:fs": { existsSync: () => true, rmSync: profile => removedProfiles.push(profile) },
    "node:os": { ...os, homedir: () => "/isolated-home" },
    "./storage": { getSnapshot: async () => null },
    "./parser": { ...parser, validateLeaderboardHost: async () => {} },
    "./binance-navigation": require("../lib/binance-navigation")
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../lib/crawler.js"), "utf8"), {
    module,
    URL,
    require: name => dependencies[name] || require(name),
    process: {
      platform, pid: 24680, env: { HOME: "/isolated-home" },
      once: (event, handler) => exitHandlers.add(handler),
      removeListener: (event, handler) => exitHandlers.delete(handler)
    },
    setTimeout: callback => queueMicrotask(callback),
    WebSocket: class { constructor() { throw new Error("launch probe complete"); } },
    fetch: async () => {
      endpointRequests++;
      return { ok: true, json: async () => [{ type: "page", webSocketDebuggerUrl: "ws://127.0.0.1/probe" }] };
    },
    console: { warn() {} }
  }, { filename: "crawler.js" });
  return { crawler: module.exports, launches, removedProfiles, exitHandlers, stops: () => stops, endpointRequests: () => endpointRequests };
}

for (const platform of ["darwin", "linux", "win32"]) {
  test(`${platform} 临时爬虫启动参数隔离钥匙串且不修改 HOME 或个人资料`, async () => {
    const probe = launchProbe(platform);
    await assert.rejects(probe.crawler.crawlLeaderboard(
      "https://www.binance.com/activity/trading-competition/probe/Main-Reward"
    ), /launch probe complete/);
    assert.equal(probe.launches.length, 1, "只使用导航入口，不回退已废弃的固定镜像");
    for (const { args, options } of probe.launches) {
      assert.equal(args.includes("--use-mock-keychain"), platform === "darwin");
      assert.equal(args.includes("--password-store=basic"), platform === "darwin");
      assert.ok(args.includes("--headless=new"));
      assert.ok(args.includes("--remote-debugging-address=127.0.0.1"));
      const profile = args.find(arg => arg.startsWith("--user-data-dir="));
      assert.ok(profile);
      assert.ok(profile.startsWith(`--user-data-dir=${path.join(os.tmpdir(), "eventlens-crawler-24680-")}`));
      assert.equal(args.at(-1), "about:blank");
      assert.equal(options.env, undefined, "必须保留测试隔离环境，不切回真实 HOME");
    }
    assert.equal(probe.stops(), probe.launches.length);
    assert.equal(probe.removedProfiles.length, probe.launches.length);
    assert.equal(probe.exitHandlers.size, 0);
  });
}

test("浏览器启动失败仍回收临时子进程与资料目录", async () => {
  const probe = launchProbe("darwin", 1);
  await assert.rejects(probe.crawler.crawlLeaderboard(
    "https://www.binance.com/activity/trading-competition/probe/Main-Reward"
  ), /浏览器启动失败/);
  assert.equal(probe.endpointRequests(), 0);
  assert.equal(probe.stops(), probe.launches.length);
  assert.equal(probe.removedProfiles.length, probe.launches.length);
  assert.equal(probe.exitHandlers.size, 0);
});

for (const platform of ["darwin", "linux", "win32"]) {
  test(`${platform} 公告导航浏览器同样隔离钥匙串且回收临时资料`, async () => {
    const launches = [];
    const removed = [];
    const handlers = new Set();
    const dependencies = {
      "node:child_process": { spawn(browser, args, options) {
        launches.push({ browser, args, options });
        return { exitCode: 1, on() {}, kill() { throw new Error("已退出的实例不应再次终止"); } };
      } },
      "node:fs/promises": { mkdtemp: async prefix => prefix + "probe", rm: async profile => removed.push(profile) },
      "./crawler": { findBrowserPath: () => "/isolated-browser" }
    };
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../lib/binance-navigation.js"), "utf8"), {
      module, URL, require: name => dependencies[name] || require(name),
      process: { platform, once: (event, handler) => handlers.add(handler), removeListener: (event, handler) => handlers.delete(handler) },
      WebSocket: class {}, setTimeout, clearTimeout
    });
    await assert.rejects(module.exports.withBrowserPage(async () => {}), /浏览器启动失败/);
    assert.equal(launches.length, 1);
    assert.equal(launches[0].args.includes("--use-mock-keychain"), platform === "darwin");
    assert.equal(launches[0].args.includes("--password-store=basic"), platform === "darwin");
    assert.equal(launches[0].options.env, undefined);
    assert.equal(removed.length, 1);
    assert.equal(handlers.size, 0);
  });
}
