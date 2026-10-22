const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const { spawnSync, execFileSync } = require("node:child_process");
const upgrade = require("../lib/linux-upgrade");
const root = path.join(__dirname, "..");
const version = require("../package.json").version;
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "eventlens-upgrade-test-"));
const quote = value => `'${value.replace(/'/g, `'"'"'`)}'`;
const envQuote = value => '"' + value.replace(/[\\"$`]/g, value => "\\" + value) + '"';
const unix = { skip: process.platform === "win32" };

function config(dir, port = 38583) {
  const file = path.join(dir, "private-config");
  const password = 'fixture $HOME `id` "quote" \\ 中文';
  fs.writeFileSync(file, `PORT=${port}\nNODE_ENV=production\nEVENTLENS_DATA_DIR=${envQuote(dir)}\nEVENTLENS_ACCESS_USERNAME=fixture\nEVENTLENS_ACCESS_PASSWORD=${envQuote(password)}\n`, { mode: 0o600 });
  return { file, password };
}

test("升级解析原端口和带特殊字符的账号配置，不执行配置内容", unix, () => {
  const dir = temp();
  try {
    const { file, password } = config(dir);
    fs.appendFileSync(file, "EXTRA=$(this_is_literal_not_a_command)\n");
    const value = upgrade.readConfig(file, dir);
    assert.equal(value.PORT, "38583");
    assert.equal(value.EVENTLENS_ACCESS_PASSWORD, password);
    assert.equal(value.EXTRA, "$(this_is_literal_not_a_command)");
    for (const text of ['PORT=1\nPORT=2', 'PORT="unterminated', 'not-an-assignment']) assert.throws(() => upgrade.parseEnvironment(text));
    fs.chmodSync(file, 0o644);
    assert.throws(() => upgrade.readConfig(file, dir), /权限/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("升级健康检查只向原服务发送认证，验证真实HTTP版本且不接受其他端口所有者", unix, async () => {
  const dir = temp();
  let received = 0;
  const server = http.createServer((req, res) => {
    received++;
    assert.equal(req.url, "/api/health");
    assert.equal(req.headers.authorization, `Basic ${Buffer.from(`fixture:${fixture.password}`).toString("base64")}`);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true, app: "eventlens-local", version, desktop: false }));
  });
  let fixture;
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    fixture = config(dir, server.address().port);
    await assert.rejects(upgrade.checkHealth("fixture", dir, fixture.file, version, { attempts: 1, owns: () => false }));
    assert.equal(received, 0);
    await upgrade.checkHealth("fixture", dir, fixture.file, version, { attempts: 1, owns: () => true });
    assert.equal(received, 1);
    await assert.rejects(upgrade.checkHealth("fixture", dir, fixture.file, "0.0.0", { attempts: 1, owns: () => true }));
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("升级校验覆盖原数据和配置，拒绝数据替换及文件链接", unix, () => {
  const dir = temp();
  try {
    const { file } = config(dir);
    const unit = path.join(dir, "unit");
    fs.writeFileSync(unit, "fixture unit");
    const state = upgrade.captureState(dir, file, unit);
    upgrade.verifyState(state);
    fs.writeFileSync(path.join(dir, "prophet.json"), "{}");
    assert.throws(() => upgrade.verifyState(state), /发生变化/);
    upgrade.verifyState(state, true);
    fs.unlinkSync(path.join(dir, "prophet.json"));
    fs.symlinkSync(unit, path.join(dir, "snapshots.json"));
    assert.throws(() => upgrade.captureState(dir, file, unit), /文件类型/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

function installation(mode = "success", active = true) {
  const dir = temp();
  const app = path.join(dir, "installation");
  const data = path.join(dir, "data");
  const cfg = path.join(dir, "config");
  const unit = path.join(dir, "unit");
  for (const folder of [app, data, cfg, path.join(app, "app"), path.join(app, "runtime/node/bin"), path.join(dir, "temporary")]) fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(app, ".eventlens-installed"), "done");
  fs.writeFileSync(path.join(app, "app/package.json"), JSON.stringify({ name: "eventlens-local", version: "2.1.2" }));
  fs.writeFileSync(path.join(app, "app/server.js"), "// old application sentinel\n");
  const conf = config(data);
  fs.renameSync(conf.file, path.join(cfg, "eventlens.env"));
  fs.writeFileSync(unit, `# Managed by EventLens Linux installer\n[Service]\nUser=eventlens\nGroup=eventlens\nWorkingDirectory=${app}/app\nEnvironmentFile=${cfg}/eventlens.env\nExecStart=${app}/runtime/node/bin/node ${app}/app/server.js --server\n`);
  for (const name of ["campaigns.json", "snapshots.json", "snapshot-history.json", "settings.json", "prophet.json"]) fs.writeFileSync(path.join(data, name), JSON.stringify({ original: name, autoUpdateEnabled: false }));
  const originals = Object.fromEntries(fs.readdirSync(data).map(name => [name, fs.readFileSync(path.join(data, name))]));
  const originalConfig = fs.readFileSync(path.join(cfg, "eventlens.env"));
  if (mode.startsWith("legacy")) {
    fs.unlinkSync(path.join(app, ".eventlens-installed"));
    fs.writeFileSync(unit, fs.readFileSync(unit, "utf8").replace("# Managed by EventLens Linux installer\n", ""));
  }
  if (mode === "legacy-inline") fs.appendFileSync(unit, 'Environment="PORT=1"\n');
  if (mode === "legacy-other-app") fs.writeFileSync(path.join(app, "app/package.json"), '{"name":"other-app","version":"2.1.2"}');
  const originalUnit = fs.readFileSync(unit);
  const runtime = path.join(app, "runtime/node/bin/node");
  fs.writeFileSync(runtime, `#!/bin/bash\nif [[ "$2" == health ]]; then\n  v=$(${quote(process.execPath)} -p 'require(process.argv[1]).version' ${quote(path.join(app, "app/package.json"))})\n  if [[ ${quote(mode)} == bad-health && "$v" != 2.1.2 ]]; then exit 1; fi\n  if [[ ${quote(mode)} == legacy-bad-health ]]; then exit 1; fi\n  printf '%s\\n' "$v" >>${quote(path.join(dir, "health-versions"))}\n  exit 0\nfi\nexec ${quote(process.execPath)} "$@"\n`, { mode: 0o755 });
  const activeFile = path.join(dir, "active");
  fs.writeFileSync(activeFile, active ? "1" : "0");
  if (mode === "external") fs.writeFileSync(unit, "unrelated service\n");
  if (mode === "bad-permissions") fs.chmodSync(path.join(cfg, "eventlens.env"), 0o644);
  const installer = path.join(dir, "installer.sh");
  // 仅测试副本绕过宿主机 root 判断；文件布局和升级事务使用真实实现。
  fs.writeFileSync(installer, fs.readFileSync(path.join(root, "install-linux.sh"), "utf8").replaceAll("[[ $EUID -eq 0 ]]", "[[ 1 -eq 1 ]]"));
  const script = `source ${quote(installer)}
APP_ROOT=${quote(app)} DATA_DIR=${quote(data)} CONFIG_DIR=${quote(cfg)} UNIT_FILE=${quote(unit)}
EVENTLENS_SOURCE=${quote(root)} INSTALL_TEMP=${quote(path.join(dir, "temporary"))}
UPGRADE_MODE=1
systemctl() {
  printf '%s\\n' "$*" >>${quote(path.join(dir, "calls"))}
  case "$1" in
    show) case "$3" in FragmentPath) printf '%s\\n' "$UNIT_FILE";; DropInPaths) ${mode === "dropin" ? "printf 'fixture-override\\n'" : ":"};; esac;;
    is-active) [[ $(cat ${quote(activeFile)}) == 1 ]];;
    stop) printf 0 >${quote(activeFile)};;
    start) printf 1 >${quote(activeFile)};;
    *) return 1;;
  esac
}
umask 077
trap cleanup EXIT
upgrade_application
`;
  const result = spawnSync("/bin/bash", ["-e", "-c", script], { encoding: "utf8" });
  return { dir, app, data, cfg, unit, result, originals, originalConfig, originalUnit, activeFile, password: conf.password };
}

for (const active of [true, false]) test(`升级事务保留38583和全部原数据，原服务${active ? "运行" : "停止"}状态不变`, unix, () => {
  const f = installation("success", active);
  try {
    assert.equal(f.result.status, 0, f.result.stderr);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.app, "app/package.json"))).version, version);
    for (const [name, contents] of Object.entries(f.originals)) assert.deepEqual(fs.readFileSync(path.join(f.data, name)), contents);
    assert.deepEqual(fs.readFileSync(path.join(f.cfg, "eventlens.env")), f.originalConfig);
    assert.deepEqual(fs.readFileSync(f.unit), f.originalUnit);
    assert.equal(fs.readFileSync(f.activeFile, "utf8"), active ? "1" : "0");
    const backup = path.join(f.app, "backups", fs.readdirSync(path.join(f.app, "backups"))[0]);
    assert.equal(JSON.parse(fs.readFileSync(path.join(backup, "app/package.json"))).version, "2.1.2");
    assert.equal(fs.statSync(backup).mode & 0o777, 0o700);
    assert.ok(fs.existsSync(path.join(backup, "data.tar.gz")));
    assert.equal((f.result.stdout + f.result.stderr).includes(f.password), false);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test("新版健康失败自动恢复旧程序，原账号和快照不回写、不清空", unix, () => {
  const f = installation("bad-health");
  try {
    assert.notEqual(f.result.status, 0);
    assert.match(f.result.stderr, /已恢复旧程序/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.app, "app/package.json"))).version, "2.1.2");
    assert.equal(fs.readFileSync(path.join(f.app, "app/server.js"), "utf8"), "// old application sentinel\n");
    assert.deepEqual(fs.readFileSync(path.join(f.cfg, "eventlens.env")), f.originalConfig);
    for (const [name, contents] of Object.entries(f.originals)) assert.deepEqual(fs.readFileSync(path.join(f.data, name)), contents);
    assert.equal(fs.readFileSync(f.activeFile, "utf8"), "1");
    assert.equal((f.result.stdout + f.result.stderr).includes(f.password), false);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

for (const mode of ["external", "bad-permissions", "dropin"]) test(`不兼容原安装 ${mode} 在停止服务前拒绝升级`, unix, () => {
  const f = installation(mode);
  try {
    assert.notEqual(f.result.status, 0);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.app, "app/package.json"))).version, "2.1.2");
    assert.equal(fs.readFileSync(f.activeFile, "utf8"), "1");
    const calls = fs.existsSync(path.join(f.dir, "calls")) ? fs.readFileSync(path.join(f.dir, "calls"), "utf8") : "";
    assert.doesNotMatch(calls, /stop|start/);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test("升级参数不接受覆盖端口或账号，错误和bash跟踪不打印多余参数", () => {
  const secret = crypto.randomBytes(20).toString("hex");
  const result = spawnSync("bash", ["-x", path.join(root, "install-linux.sh"), "--upgrade", secret], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.equal((result.stdout + result.stderr).includes(secret), false);
  assert.match(result.stderr, /不需要/);
});

for (const corrupt of [false, true]) test(`远程升级下载校验${corrupt ? "拒绝篡改包" : "通过后才执行--upgrade"}`, unix, () => {
  const dir = temp();
  try {
    const bin = path.join(dir, "bin"); fs.mkdirSync(bin);
    const marker = path.join(dir, "executed");
    const archive = path.join(dir, `EventLens-Linux-v${version}.run`);
    fs.writeFileSync(archive, `#!/bin/bash\nprintf '%s' "$1" >${quote(marker)}\n`);
    const hash = crypto.createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
    const sums = path.join(dir, "SHA256SUMS");
    fs.writeFileSync(sums, `${corrupt ? "0".repeat(64) : hash}  ${path.basename(archive)}\n`);
    fs.writeFileSync(path.join(bin, "curl"), `#!/bin/bash\nurl=; out=\nwhile [[ $# -gt 0 ]]; do if [[ "$1" == -o ]]; then out=$2; shift 2; elif [[ "$1" == https:* ]]; then url=$1; shift; else shift; fi; done\ncase "$url" in */v${version}/SHA256SUMS) cp ${quote(sums)} "$out";; */v${version}/${path.basename(archive)}) cp ${quote(archive)} "$out";; *) exit 1;; esac\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, "sha256sum"), `#!/bin/bash\nexec ${quote(process.execPath)} -e 'const f=require("fs"),c=require("crypto"),p=process.argv[1]; console.log(c.createHash("sha256").update(f.readFileSync(p)).digest("hex")+"  "+p)' "$1"\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, "sudo"), '#!/bin/bash\nexec "$@"\n', { mode: 0o755 });
    const result = spawnSync("bash", [path.join(root, "upgrade-linux.sh")], { encoding: "utf8", env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH } });
    if (corrupt) { assert.notEqual(result.status, 0); assert.equal(fs.existsSync(marker), false); }
    else { assert.equal(result.status, 0, result.stderr); assert.equal(fs.readFileSync(marker, "utf8"), "--upgrade"); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("README与Linux教程的一段升级命令语法有效，latest入口配套脚本仍固定到正式版本", () => {
  for (const file of ["README.md", "LINUX-安装教程.md"]) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    const command = source.split("\n").find(line => line.startsWith("bash -c 'set -e; d=$(mktemp -d)"));
    assert.ok(command);
    assert.equal(spawnSync("bash", ["-n", "-c", command]).status, 0);
    assert.ok(command.includes("/releases/latest/download/upgrade-linux.sh"));
    assert.ok(fs.readFileSync(path.join(root, "upgrade-linux.sh"), "utf8").includes(`VERSION=${version}`));
  }
});

for (const downloadFails of [false, true]) test(`一段升级命令${downloadFails ? "下载失败不执行" : "执行下载脚本并传回退出码"}且清理临时目录`, unix, () => {
  const dir = temp();
  try {
    const bin = path.join(dir, "bin"); fs.mkdirSync(bin);
    const output = path.join(dir, "destination");
    fs.writeFileSync(path.join(bin, "curl"), `#!/bin/bash\nwhile [[ $# -gt 0 ]]; do if [[ "$1" == -o ]]; then out=$2; shift 2; else shift; fi; done\nprintf '%s' "$out" >${quote(output)}\n${downloadFails ? "exit 22" : "printf 'exit 37\\n' >\"$out\""}\n`, { mode: 0o755 });
    const command = fs.readFileSync(path.join(root, "README.md"), "utf8").split("\n").find(l => l.startsWith("bash -c 'set -e; d=$(mktemp -d)"));
    const result = spawnSync("bash", ["-c", command], { encoding: "utf8", env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH } });
    assert.equal(result.status, downloadFails ? 22 : 37, result.stderr);
    assert.equal(fs.existsSync(path.dirname(fs.readFileSync(output, "utf8"))), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("安装升级互斥锁被占用时，不进入升级事务", unix, () => {
  const dir = temp();
  try {
    const installer = path.join(dir, "installer.sh");
    fs.writeFileSync(installer, fs.readFileSync(path.join(root, "install-linux.sh"), "utf8")
      .replaceAll("[[ $EUID -eq 0 ]]", "[[ 1 -eq 1 ]]")
      .replace("exec 9>/run/lock/eventlens-install.lock", `exec 9>${quote(path.join(dir, "lock"))}`));
    const marker = path.join(dir, "should-not-run");
    const result = spawnSync("bash", ["-e", "-c", `source ${quote(installer)}\ndetect_platform() { :; }\nflock() { return 1; }\nupgrade_application() { touch ${quote(marker)}; }\nupgrade_main\n`], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.equal(fs.existsSync(marker), false);
    assert.match(result.stderr, /另一个安装或升级任务/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});


test("缺少安装标记和服务注释的旧安装先验证旧服务，升级后生成可持续识别的记录", unix, () => {
  const f = installation("legacy");
  try {
    assert.equal(f.result.status, 0, f.result.stderr);
    assert.deepEqual(fs.readFileSync(f.unit), f.originalUnit);
    assert.deepEqual(fs.readFileSync(path.join(f.cfg, "eventlens.env")), f.originalConfig);
    for (const [name, contents] of Object.entries(f.originals)) assert.deepEqual(fs.readFileSync(path.join(f.data, name)), contents);
    const marker = path.join(f.app, ".eventlens-installed");
    assert.equal(JSON.parse(fs.readFileSync(marker)).kind, "verified-legacy");
    assert.equal(fs.statSync(marker).mode & 0o777, 0o600);
    assert.equal(upgrade.checkInstall(f.app, f.data, f.cfg, f.unit), "adopted");
    assert.deepEqual(fs.readFileSync(path.join(f.dir, "health-versions"), "utf8").trim().split("\n"), ["2.1.2", version]);
    assert.equal((f.result.stdout + f.result.stderr).includes(f.password), false);
    fs.appendFileSync(f.unit, 'Environment="PORT=1"\n');
    assert.throws(() => upgrade.checkInstall(f.app, f.data, f.cfg, f.unit));
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

for (const mode of ["legacy-bad-health", "legacy-inline", "legacy-other-app"]) test(`旧安装 ${mode} 校验失败时不停止服务、不创建记录`, unix, () => {
  const f = installation(mode);
  try {
    assert.notEqual(f.result.status, 0);
    assert.equal(fs.readFileSync(f.activeFile, "utf8"), "1");
    assert.equal(fs.existsSync(path.join(f.app, ".eventlens-installed")), false);
    const calls = fs.existsSync(path.join(f.dir, "calls")) ? fs.readFileSync(path.join(f.dir, "calls"), "utf8") : "";
    assert.doesNotMatch(calls, /stop|start/);
    for (const [name, contents] of Object.entries(f.originals)) assert.deepEqual(fs.readFileSync(path.join(f.data, name)), contents);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test("首次识别旧安装不擅自启动停止中的服务", unix, () => {
  const f = installation("legacy", false);
  try {
    assert.notEqual(f.result.status, 0);
    assert.equal(fs.readFileSync(f.activeFile, "utf8"), "0");
    assert.equal(fs.existsSync(path.join(f.app, ".eventlens-installed")), false);
    const calls = fs.readFileSync(path.join(f.dir, "calls"), "utf8");
    assert.doesNotMatch(calls, /stop|start/);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test("识别记录不包含凭据，校验通过后即使旧服务停止也可继续识别", unix, () => {
  const f = installation("legacy");
  try {
    assert.equal(f.result.status, 0, f.result.stderr);
    fs.writeFileSync(f.activeFile, "0");
    assert.equal(upgrade.checkInstall(f.app, f.data, f.cfg, f.unit), "adopted");
    const marker = path.join(f.app, ".eventlens-installed");
    assert.equal(fs.readFileSync(marker, "utf8").includes(f.password), false);
    fs.unlinkSync(marker);
    fs.symlinkSync(path.join(f.dir, "missing"), marker);
    assert.throws(() => upgrade.checkInstall(f.app, f.data, f.cfg, f.unit));
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test("兼容官方 Node tar 保留的构建 UID，但仍拒绝可被其他用户写入的运行时", unix, () => {
  const f = installation("legacy");
  const original = fs.lstatSync;
  try {
    assert.equal(f.result.status, 0, f.result.stderr);
    fs.unlinkSync(path.join(f.app, ".eventlens-installed"));
    const runtime = path.join(f.app, "runtime/node/bin/node");
    fs.lstatSync = (file, ...args) => {
      const stat = original(file, ...args);
      if (path.resolve(file) === runtime) stat.uid = process.getuid() + 1;
      return stat;
    };
    assert.equal(upgrade.checkInstall(f.app, f.data, f.cfg, f.unit), "legacy");
    fs.chmodSync(runtime, 0o777);
    assert.throws(() => upgrade.checkInstall(f.app, f.data, f.cfg, f.unit), /权限/);
  } finally { fs.lstatSync = original; fs.rmSync(f.dir, { recursive: true, force: true }); }
});
