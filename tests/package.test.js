const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawn } = require("node:child_process");
const net = require("node:net");

const root = path.join(__dirname, "..");
const version = require("../package.json").version;

test("启动器无用户专属绝对路径且要求 Node 22", () => {
  for (const file of ["start.sh", "start.bat", "Open-EventLens.command", "双击打开.command"]) {
    const content = fs.readFileSync(path.join(root, file), "utf8");
    assert.doesNotMatch(content, /\/Users\/ys|C:\\Users\\ys/);
  }
  assert.equal(require("../package.json").engines.node, ">=22.0.0");
});

test("Release ZIP 包含原生启动器源码且保留其他版本归档", () => {
  const previousArchive = path.join(root, "dist", `EventLens-Local-vpreservation-test-${process.pid}.zip`);
  fs.mkdirSync(path.dirname(previousArchive), { recursive: true });
  fs.writeFileSync(previousArchive, "archive-preservation-fixture");
  try {
    execFileSync(path.join(root, "scripts/package-release.sh"), { cwd: root });
    assert.equal(fs.readFileSync(previousArchive, "utf8"), "archive-preservation-fixture");
  } finally { fs.rmSync(previousArchive, { force: true }); }
  const archive = path.join(root, "dist", `EventLens-Local-v${version}.zip`);
  assert.equal(fs.existsSync(archive), true);
  const listing = execFileSync("unzip", ["-Z1", archive], { encoding: "utf8" });
  assert.match(listing, /server\.js/);
  assert.match(listing, /seed-campaigns\.json/);
  assert.match(listing, /Open-EventLens\.command/);
  assert.match(listing, /\.app\/Contents\/MacOS\/EventLens/);
  assert.match(listing, /scripts\/launch-desktop\.js/);
  assert.match(listing, /install-linux\.sh/);
  assert.match(listing, /upgrade-linux\.sh/);
  assert.match(listing, /lib\/linux-upgrade\.js/);
  assert.match(listing, /LINUX-/);
  assert.match(listing, /scripts\/macos-launcher\.m/);
  assert.match(listing, /scripts\/build-macos-launcher\.sh/);
  for (const file of ["lib/prophet.js", "public/prophet.js", "public/prophet.css", "public/prophet.html"]) {
    assert.ok(listing.split("\n").includes(`EventLens-Local-v${version}/${file}`), file);
  }
  assert.doesNotMatch(listing, /manifest\.json|background\.js|data\/(campaigns|snapshots|snapshot-history|settings|prophet)\.json/);
  assert.doesNotMatch(listing, /data\/\.manual-update-/);

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "eventlens-package-"));
  try {
    execFileSync("unzip", ["-q", archive, "-d", temp]);
    const folder = path.join(temp, `EventLens-Local-v${version}`);
    for (const dir of ["lib", "public"]) {
      for (const name of fs.readdirSync(path.join(root, dir))) {
        assert.deepEqual(fs.readFileSync(path.join(folder, dir, name)), fs.readFileSync(path.join(root, dir, name)), `${dir}/${name}`);
      }
    }
    execFileSync(process.execPath, ["--check", "server.js"], { cwd: folder });
    assert.equal(fs.existsSync(path.join(folder, "双击打开.command")), true);
    assert.equal(fs.statSync(path.join(folder, "start.sh")).mode & 0o111, 0o111);
    assert.equal(fs.statSync(path.join(folder, "双击打开.app/Contents/MacOS/EventLens")).mode & 0o111, 0o111);
    if (process.platform === "darwin") {
      execFileSync("/usr/bin/codesign", ["--verify", "--strict", path.join(folder, "双击打开.app")]);
    }
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("发布 ZIP 的中文路径使用标准 UTF-8 标记且本地与目录头一致", () => {
  const buffer = fs.readFileSync(path.join(root, "dist", `EventLens-Local-v${version}.zip`));
  const end = buffer.lastIndexOf(Buffer.from("504b0506", "hex"));
  assert.ok(end >= 0);
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const names = [];
  for (let index = 0; index < count; index++) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength);
    const local = buffer.readUInt32LE(offset + 42);
    assert.equal(buffer.readUInt32LE(local), 0x04034b50);
    assert.equal(buffer.readUInt16LE(offset + 8) & 0x800, 0x800, name.toString("utf8"));
    assert.equal(buffer.readUInt16LE(local + 6) & 0x800, 0x800);
    assert.deepEqual(buffer.subarray(local + 30, local + 30 + buffer.readUInt16LE(local + 26)), name);
    names.push(new TextDecoder("utf-8", { fatal: true }).decode(name));
    offset += 46 + nameLength + buffer.readUInt16LE(offset + 30) + buffer.readUInt16LE(offset + 32);
  }
  assert.ok(names.includes(`EventLens-Local-v${version}/双击打开.app/Contents/Info.plist`));
  assert.ok(names.includes(`EventLens-Local-v${version}/双击打开.command`));
});

test("解压后的发布包在中文与特殊字符目录中真实启动并初始化种子数据", { timeout: 15000 }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "eventlens-release-boot-"));
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  let child;
  let exit;
  let output = "";
  try {
    execFileSync("unzip", ["-q", path.join(root, "dist", `EventLens-Local-v${version}.zip`), "-d", temp]);
    const folder = path.join(temp, "发布 验证 ' $ ` & 项目");
    fs.renameSync(path.join(temp, `EventLens-Local-v${version}`), folder);
    const env = { ...process.env, PORT: String(port), EVENTLENS_DESKTOP: "0" };
    delete env.EVENTLENS_DATA_DIR;
    child = spawn(process.execPath, ["server.js"], { cwd: folder, env, stdio: ["ignore", "pipe", "pipe"] });
    exit = new Promise(resolve => child.once("exit", resolve));
    child.stdout.on("data", data => { output += data; });
    child.stderr.on("data", data => { output += data; });
    const base = `http://127.0.0.1:${port}`;
    let health;
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) });
        health = await response.json();
        break;
      } catch (_) { await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    assert.equal(health?.app, "eventlens-local", output);
    assert.equal(health.version, version);
    const groups = (await (await fetch(`${base}/api/campaigns`)).json()).groups;
    assert.ok(groups.active.length + groups.history.length > 0);
    assert.equal([...groups.active, ...groups.history].filter(item => item.kind === "prophet").length, 1);
    const page = await (await fetch(base)).text();
    assert.match(page, /id="rankSummaryGrid" class="rank-summary-grid"/);
    assert.match(page, /app\.js\?v=/);
    assert.match(page, /id="seasonRankSearch"/);
    assert.match(page, /id="weeklyRankSearch"/);
    for (const file of ["prophet.js", "prophet.css", "prophet.html"]) {
      const response = await fetch(`${base}/${file}`);
      assert.equal(response.status, 200);
      assert.equal(await response.text(), fs.readFileSync(path.join(root, "public", file), "utf8"));
    }
    assert.deepEqual(await (await fetch(`${base}/api/prophet`)).json(), { snapshot: null, refreshing: false });
    assert.ok(fs.existsSync(path.join(folder, "data/campaigns.json")));
    assert.ok(fs.existsSync(path.join(folder, "data/settings.json")));
  } finally {
    if (child && child.exitCode === null) { child.kill("SIGTERM"); await exit; }
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
