const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { SOURCE_URL, SEASON_ID, API_PATH, resolveProphetOrigin, createSourceResolver } = require("../lib/prophet-navigation");
const { validatePublicHttpsHost, validateLeaderboardHost } = require("../lib/parser");
const page = origin => `${origin}/zh-CN/prophet/leaderboard?seasonId=${SEASON_ID}`;

test("神算子打开用户指定入口，跳转稳定且同源赛季接口验证成功后才采用来源", async () => {
  const commands = [];
  const validated = [];
  let polls = 0;
  const result = await resolveProphetOrigin(async (method, params) => {
    commands.push([method, params]);
    if (method === "Page.navigate") return {};
    if (params.awaitPromise) return { result: { value: true } };
    if (++polls === 1) throw new Error("Execution context destroyed");
    return { result: { value: page("https://current.com") } };
  }, { pause: async () => {}, validateTarget: async href => { validated.push(href); } });
  assert.equal(result, "https://current.com");
  assert.deepEqual(commands[0], ["Page.navigate", { url: SOURCE_URL }]);
  assert.equal(SOURCE_URL, "https://www.bsmkweb.cc/zh-CN/prophet/leaderboard?seasonId=prophet_1019_s1");
  assert.deepEqual(validated, [page("https://current.com")]);
  const expression = commands.find(([, p]) => p.awaitPromise)[1].expression;
  assert.match(expression, /credentials: "omit"/);
  assert.match(expression, /redirect: "error"/);
  assert.match(expression, /location.origin === origin/);
});

test("无效中转页每来源最多验证一次，不回退固定旧域名，继续等最终有效来源", async () => {
  let polls = 0;
  let probes = 0;
  const result = await resolveProphetOrigin(async (method, params) => {
    if (method === "Page.navigate") return {};
    if (params.awaitPromise) return { result: { value: ++probes > 1 } };
    return { result: { value: page(++polls < 5 ? "https://intermediate.com" : "https://latest.com") } };
  }, { pause: async () => {}, validateTarget: async () => {} });
  assert.equal(result, "https://latest.com");
  assert.equal(probes, 2);
  await assert.rejects(resolveProphetOrigin(async (method, params) => {
    if (method === "Page.navigate") return {};
    return { result: { value: params.awaitPromise ? false : SOURCE_URL } };
  }, { timeoutMs: 8, pause: () => new Promise(resolve => setTimeout(resolve, 2)), validateTarget: async () => {} }), /未能提供/);
});

test("不探测无关路径或其他赛季，目标必须在接口探测前通过公网验证", async () => {
  for (const href of ["https://current.com/", page("https://current.com").replace(SEASON_ID, "other")]) {
    let probes = 0;
    await assert.rejects(resolveProphetOrigin(async (method, params) => {
      if (method === "Page.navigate") return {};
      if (params.awaitPromise) probes++;
      return { result: { value: href } };
    }, { timeoutMs: 8, pause: () => new Promise(resolve => setTimeout(resolve, 2)), validateTarget: async () => { probes++; } }), /未能提供/);
    assert.equal(probes, 0);
  }
  let probes = 0;
  await assert.rejects(resolveProphetOrigin(async (method, params) => {
    if (method === "Page.navigate") return {};
    if (params.awaitPromise) probes++;
    return { result: { value: page("https://private.com") } };
  }, { pause: async () => {}, validateTarget: async () => { throw new Error("内网目标"); } }), /内网/);
  assert.equal(probes, 0);
});

test("公网检查复用原安全约束，交易赛路径校验仍不可绕过", async () => {
  const publicDns = async () => [{ address: "8.8.8.8" }];
  assert.equal((await validatePublicHttpsHost(page("https://public.com"), publicDns)).origin, "https://public.com");
  await assert.rejects(validateLeaderboardHost(page("https://public.com"), publicDns), /不是币安交易赛/);
  for (const origin of ["http://public.com", "https://user:fake@public.com", "https://public.com:8443", "https://127.0.0.1", "https://host.local"]) {
    await assert.rejects(validatePublicHttpsHost(page(origin), publicDns));
  }
  for (const addresses of [[], [{ address: "127.0.0.1" }], [{ address: "::1" }], [{ address: "8.8.8.8" }, { address: "192.168.1.1" }]]) {
    await assert.rejects(validatePublicHttpsHost(page("https://public.com"), async () => addresses), /内网/);
  }
});

test("浏览器接口探测验证真实响应格式和同源，不接受重定向/伪成功/跳转中的页面", async () => {
  let expression;
  await resolveProphetOrigin(async (method, params) => {
    if (method === "Page.navigate") return {};
    if (params.awaitPromise) { expression = params.expression; return { result: { value: true } }; }
    return { result: { value: page("https://current.com") } };
  }, { pause: async () => {}, validateTarget: async () => {} });
  for (const mode of ["valid", "html", "redirected", "wrong-code", "wrong-period", "missing-weeks", "changed-origin", "failed"]) {
    const location = { origin: "https://current.com" };
    let requests = 0;
    const result = await vm.runInNewContext(expression, { URL, AbortSignal, location, fetch: async (url, options) => {
      requests++;
      assert.equal(url.href, `https://current.com${API_PATH}query`);
      assert.equal(options.redirect, "error");
      assert.equal(options.credentials, "omit");
      assert.equal(JSON.parse(options.body).seasonId, SEASON_ID);
      if (mode === "failed") throw new Error("offline");
      if (mode === "changed-origin") location.origin = "https://next.com";
      return { ok: true, url: mode === "redirected" ? "https://other.com/" : url.href,
        headers: { get: () => mode === "html" ? "text/html" : "application/json" },
        json: async () => ({ success: true, code: mode === "wrong-code" ? "bad" : "000000", data: {
          seasonStartTime: 1000, seasonEndTime: mode === "wrong-period" ? 1000 : 2000,
          weekInfos: mode === "missing-weeks" ? [] : [{ weekIndex: 1 }]
        } }) };
    } });
    assert.equal(result, mode === "valid", mode);
    assert.equal(requests, 1);
  }
});

test("来源缓存五分钟、合并初始化，失败清理且不泄漏底层信息", async () => {
  let time = 0;
  let opens = 0;
  let fail = false;
  const source = createSourceResolver({ now: () => time, openPage: async task => {
    opens++;
    if (fail) throw new Error("private-diagnostic");
    return task();
  }, resolve: async () => `https://current${opens}.com` });
  assert.deepEqual(await Promise.all([source.getOrigin(), source.getOrigin()]), ["https://current1.com", "https://current1.com"]);
  assert.equal(opens, 1);
  time = 299999;
  assert.equal(await source.getOrigin(), "https://current1.com");
  time = 300000;
  assert.equal(await source.getOrigin(), "https://current2.com");
  source.invalidate("https://current1.com");
  assert.equal(await source.getOrigin(), "https://current2.com");
  source.invalidate("https://current2.com");
  fail = true;
  await assert.rejects(source.getOrigin(), error => error.statusCode === 502 && !error.message.includes("private-diagnostic"));
  fail = false;
  assert.equal(await source.getOrigin(), "https://current4.com");
});
