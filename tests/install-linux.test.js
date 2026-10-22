const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const { spawnSync, execFileSync } = require("node:child_process");

const root = path.join(__dirname, "..");
const installer = path.join(root, "install-linux.sh");
const version = require("../package.json").version;
const temporary = () => fs.mkdtempSync(path.join(os.tmpdir(), "eventlens-installer-test-"));
const source = 'source "$EVENTLENS_TEST_SCRIPT"\n';

function shell(script, vars = {}) {
  return spawnSync("bash", ["-c", source + script], {
    encoding: "utf8", env: { ...process.env, EVENTLENS_TEST_SCRIPT: installer, ...vars }
  });
}

test("Linux 安装脚本语法和参数校验有效，不执行安装或输出密码", () => {
  execFileSync("bash", ["-n", installer]);
  execFileSync("bash", ["-n", path.join(root, "scripts/package-linux.sh")]);
  const password = crypto.randomBytes(24).toString("hex");
  const output = execFileSync("bash", [installer, "--check", "203.0.113.10", "3000", "webadmin", password], { encoding: "utf8" });
  assert.match(output, /未下载、未安装、未启动/);
  assert.equal(output.includes(password), false);
  const traced = spawnSync("bash", ["-x", installer, "--check", "203.0.113.10", "3000", "webadmin", password], { encoding: "utf8" });
  assert.equal(traced.status, 0);
  assert.equal((traced.stdout + traced.stderr).includes(password), false);
  const invalid = [
    ["999.1.1.1", "3000", "webadmin"],
    ["203.0.113.10", "0", "webadmin"],
    ["203.0.113.10", "65536", "webadmin"],
    ["203.0.113.10", "3000;exit", "webadmin"],
    ["203.0.113.10", "3000", "bad:user"],
    ["203.0.113.10", "3000", "webadmin", "line1\nline2"]
  ];
  for (const args of invalid) {
    const result = spawnSync("bash", [installer, "--check", ...args], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /安装失败/);
  }
});

test("保存的账号密码保留特殊字符，配置仅管理员可读且服务由普通用户运行", () => {
  for (const port of [3000, 80]) {
  const dir = temporary();
  const password = 'space $HOME `id` "double" \\ backslash \'single\' #hash %percent 中文';
  const result = shell(`
    say() { :; }
    install() { mkdir -p "$CONFIG_DIR"; chmod 700 "$CONFIG_DIR"; }
    systemctl() { printf '%s\\n' "$*" >>"$EVENTLENS_TEST_DIR/calls"; }
    CONFIG_DIR="$EVENTLENS_TEST_DIR/config"
    UNIT_FILE="$EVENTLENS_TEST_DIR/service"
    APP_ROOT=/opt/eventlens
    NODE_BIN=/opt/eventlens/runtime/node/bin/node
    DATA_DIR=/var/lib/eventlens
    WEB_PORT="$EVENTLENS_TEST_PORT"
    WEB_USERNAME=webadmin
    WEB_PASSWORD="$EVENTLENS_TEST_PASSWORD"
    umask 077
    write_configuration
    source "$CONFIG_DIR/eventlens.env"
    printf '%s' "$EVENTLENS_ACCESS_PASSWORD" >"$EVENTLENS_TEST_DIR/recovered"
  `, { EVENTLENS_TEST_DIR: dir, EVENTLENS_TEST_PASSWORD: password, EVENTLENS_TEST_PORT: String(port) });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(dir, "recovered"), "utf8"), password);
  assert.equal(fs.statSync(path.join(dir, "config/eventlens.env")).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(dir, "config")).mode & 0o777, 0o700);
  assert.match(fs.readFileSync(path.join(dir, "service"), "utf8"), /User=eventlens\nGroup=eventlens/);
  assert.match(fs.readFileSync(path.join(dir, "service"), "utf8"), /server\.js --server/);
  assert.equal(fs.readFileSync(path.join(dir, "service"), "utf8").includes("AmbientCapabilities=CAP_NET_BIND_SERVICE"), port < 1024);
  assert.match(fs.readFileSync(path.join(dir, "calls"), "utf8"), /enable --now eventlens\.service/);
  assert.equal((result.stdout + result.stderr).includes(password), false);
  }
});

test("已有数据或外部同名服务会阻止安装，原文件保持不变", () => {
  for (const kind of ["data", "service", "installed"]) {
    const dir = temporary();
    const state = path.join(dir, "state");
    const app = path.join(dir, "app");
    const unit = path.join(dir, "unit");
    fs.mkdirSync(state);
    fs.mkdirSync(app);
    if (kind === "data") fs.writeFileSync(path.join(state, "snapshots.json"), "existing snapshot");
    if (kind === "service") fs.writeFileSync(unit, "unrelated service");
    if (kind === "installed") fs.writeFileSync(path.join(app, ".eventlens-installed"), "done");
    const result = shell(`
      APP_ROOT="$EVENTLENS_TEST_DIR/app"
      DATA_DIR="$EVENTLENS_TEST_DIR/state"
      CONFIG_DIR="$EVENTLENS_TEST_DIR/config"
      UNIT_FILE="$EVENTLENS_TEST_DIR/unit"
      getent() { return 1; }
      check_existing_install
    `, { EVENTLENS_TEST_DIR: dir });
    assert.notEqual(result.status, 0);
    if (kind === "data") assert.equal(fs.readFileSync(path.join(state, "snapshots.json"), "utf8"), "existing snapshot");
    if (kind === "service") assert.equal(fs.readFileSync(unit, "utf8"), "unrelated service");
    if (kind === "installed") assert.equal(fs.readFileSync(path.join(app, ".eventlens-installed"), "utf8"), "done");
  }
});

test("单文件 Linux 安装包自带完整源码并校验内容，篡改后拒绝执行", () => {
  execFileSync("bash", [path.join(root, "scripts/package-linux.sh")], { cwd: root });
  const archive = path.join(root, "dist", `EventLens-Linux-v${version}.run`);
  const content = fs.readFileSync(archive);
  const marker = Buffer.from("\n__EVENTLENS_ARCHIVE_BELOW__\n");
  const position = content.indexOf(marker);
  assert.ok(position > 0);
  const header = content.subarray(0, position).toString("utf8");
  const payload = content.subarray(position + marker.length);
  assert.equal(crypto.createHash("sha256").update(payload).digest("hex"), header.match(/EXPECTED_HASH=([a-f0-9]{64})/)[1]);
  const dir = temporary();
  const tarFile = path.join(dir, "source.tar");
  fs.writeFileSync(tarFile, zlib.gunzipSync(payload));
  execFileSync("tar", ["-xf", tarFile, "-C", dir]);
  for (const file of ["server.js", "lib/binance-navigation.js", "lib/prophet.js", "lib/linux-upgrade.js", "public/prophet.js", "public/prophet.css", "public/prophet.html", "public/index.html", "install-linux.sh", "upgrade-linux.sh", "LINUX-安装教程.md"]) {
    assert.equal(fs.readFileSync(path.join(dir, file)).equals(fs.readFileSync(path.join(root, file))), true, file);
  }
  assert.deepEqual(fs.readdirSync(path.join(dir, "data")).sort(), ["seed-campaigns.json", "seed-snapshots.json"]);
  const checked = execFileSync("bash", [archive, "--check", "203.0.113.10", "3000", "webadmin"], { encoding: "utf8" });
  assert.match(checked, /参数检查通过/);
  const password = crypto.randomBytes(24).toString("hex");
  const traced = spawnSync("bash", ["-x", archive, "--check", "203.0.113.10", "3000", "webadmin", password], { encoding: "utf8" });
  assert.equal(traced.status, 0);
  assert.equal((traced.stdout + traced.stderr).includes(password), false);
  const tampered = Buffer.from(content);
  tampered[tampered.length - 1] ^= 1;
  const corrupted = path.join(dir, "corrupted.run");
  fs.writeFileSync(corrupted, tampered);
  const result = spawnSync("bash", [corrupted, "--help"], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /安装包校验失败/);
});
