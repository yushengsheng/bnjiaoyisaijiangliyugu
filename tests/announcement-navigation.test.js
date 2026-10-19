const test = require("node:test");
const assert = require("node:assert/strict");
const { LIST_URL, readAnnouncement, resolveLeaderboardUrl } = require("../lib/binance-navigation");

test("导航始终打开指定公告入口，并在页面跳转后读取当前来源的公告接口", async () => {
  const commands = [];
  let attempts = 0;
  const expected = { origin: "https://latest.example", data: { code: "000000", data: { articles: [{ code: "c".repeat(32) }] } } };
  const result = await readAnnouncement(async (method, params) => {
    commands.push([method, params]);
    if (method !== "Runtime.evaluate") return {};
    attempts++;
    if (attempts === 1) throw new Error("Execution context destroyed");
    if (attempts === 2) return { result: { value: null } };
    return { result: { value: expected } };
  }, "/article/catalog/list/query?catalogId=93", { pause: async () => {} });
  assert.deepEqual(result, expected);
  assert.equal(LIST_URL, "https://www.bsmkweb.cc/zh-CN/support/announcement/list/93");
  assert.deepEqual(commands[1], ["Page.navigate", { url: LIST_URL }]);
  assert.equal(attempts, 3);
  const evaluate = commands.find(([method]) => method === "Runtime.evaluate")[1];
  assert.match(evaluate.expression, /location\.origin/);
  assert.match(evaluate.expression, /catalog\/list\/query\?catalogId=93/);
  assert.equal(evaluate.awaitPromise, true);
});

test("导航一直停留在 Loading 或返回非 JSON 时超时报错", async () => {
  await assert.rejects(readAnnouncement(async () => ({ result: { value: null } }), "/article/detail/query", {
    timeoutMs: 5, pause: () => new Promise(resolve => setTimeout(resolve, 2))
  }), /bsmkweb\.cc.*未能返回公告数据/);
});

test("旧活动域名失效时只跟随导航的新域名，完整保留活动与子赛道路径", async () => {
  const source = "https://old-domain.com/zh-CN/activity/trading-competition/202609tradersleague4/Spot-Carnival-Waves-Round2";
  const navigations = [];
  const validated = [];
  for (const hostname of ["www.current-domain.com", "www.next-domain.com"]) {
    const resolved = await resolveLeaderboardUrl(async (method, params) => {
      if (method === "Page.navigate") { navigations.push(params.url); return {}; }
      return { result: { value: { href: `https://${hostname}/`, ready: "complete", app: true } } };
    }, source, { pause: async () => {}, validateTarget: async url => { validated.push(url); } });
    const target = new URL(resolved);
    assert.equal(target.hostname, hostname);
    assert.equal(target.pathname, new URL(source).pathname);
  }
  assert.deepEqual(navigations, [LIST_URL, LIST_URL]);
  assert.equal(validated.length, 2);
});

test("动态抓榜目标仍校验公网地址，拒绝导航至内网", async () => {
  await assert.rejects(resolveLeaderboardUrl(async method => method === "Page.navigate" ? {} : {
    result: { value: { href: "https://private-domain.com/", ready: "complete", app: true } }
  }, "https://old-domain.com/activity/trading-competition/test/Main-Reward", {
    pause: async () => {}, validateTarget: async () => { throw new Error("活动域名解析到本机或内网地址，无法抓取"); }
  }), /内网地址/);
});

test("跳过已加载完成的脚本中转页，等待真实币安应用后再选择抓榜域名", async () => {
  let attempts = 0;
  const resolved = await resolveLeaderboardUrl(async method => {
    if (method === "Page.navigate") return {};
    attempts++;
    return { result: { value: attempts < 3
      ? { href: "https://intermediate-site.com/jsredirect/zh-CN/support/announcement/list/93", ready: "complete", app: false }
      : { href: "https://actual-site.com/zh-CN/support/announcement/list/93", ready: "interactive", app: true }
    } };
  }, "https://old-domain.com/activity/trading-competition/test/Main-Reward", {
    pause: async () => {}, validateTarget: async () => {}
  });
  assert.equal(attempts, 4);
  assert.equal(new URL(resolved).hostname, "actual-site.com");
});

test("导航未跳转时不使用存储的旧域名兜底", async () => {
  await assert.rejects(resolveLeaderboardUrl(async method => method === "Page.navigate" ? {} : {
    result: { value: { href: LIST_URL, ready: "complete", app: false } }
  }, "https://old-domain.com/activity/trading-competition/test/Main-Reward", {
    timeoutMs: 5, pause: () => new Promise(resolve => setTimeout(resolve, 2))
  }), /未能提供当前可用的抓榜域名/);
});
