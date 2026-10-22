// Linux 升级专用校验：配置只作为数据读取，绝不 source 或打印凭据。
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync, spawnSync } = require("node:child_process");

const runtimeFiles = ["campaigns.json", "snapshots.json", "snapshot-history.json", "settings.json", "prophet.json"];
const reject = message => { throw new Error(message); };

function parseEnvironment(text) {
  const result = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^[#;]/.test(line)) continue;
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!match || Object.hasOwn(result, match[1])) reject("原配置格式不受支持，未执行升级");
    let value = match[2].trim();
    if (value.startsWith('"')) {
      if (!/^"(?:[^"\\]|\\[\\"$`])*"$/.test(value)) reject("原配置引号格式不受支持，未执行升级");
      value = value.slice(1, -1).replace(/\\([\\"$`])/g, "$1");
    } else if (value.startsWith("'")) {
      if (!/^'[^']*'$/.test(value)) reject("原配置引号格式不受支持，未执行升级");
      value = value.slice(1, -1);
    } else if (/["'\\]/.test(value)) reject("原配置转义格式不受支持，未执行升级");
    if (/[\r\n\0]/.test(value)) reject("原配置包含不支持的字符，未执行升级");
    result[match[1]] = value;
  }
  return result;
}

function readConfig(file, dataDir) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) || stat.uid !== process.getuid()) {
    reject("原配置归属或权限不符合一键安装要求，未执行升级");
  }
  const config = parseEnvironment(fs.readFileSync(file, "utf8"));
  if (!/^\d{1,5}$/.test(config.PORT || "") || Number(config.PORT) < 1 || Number(config.PORT) > 65535 ||
      !config.EVENTLENS_ACCESS_USERNAME || !config.EVENTLENS_ACCESS_PASSWORD || config.EVENTLENS_DATA_DIR !== dataDir) {
    reject("原安装配置不完整或数据目录不匹配，未执行升级");
  }
  return config;
}

function checkInstall(appRoot, dataDir, configDir, unitFile) {
  for (const dir of [appRoot, path.join(appRoot, "app"), dataDir, configDir]) {
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) reject("原安装目录不匹配，未执行升级");
    if (dir !== dataDir && (stat.uid !== process.getuid() || (stat.mode & 0o022))) reject("原程序目录归属或权限不匹配");
  }
  const unitStat = fs.lstatSync(unitFile);
  if (!unitStat.isFile() || unitStat.isSymbolicLink() || unitStat.uid !== process.getuid() || (unitStat.mode & 0o022)) reject("原服务文件不匹配");
  const unit = fs.readFileSync(unitFile, "utf8");
  const expected = { User: "eventlens", Group: "eventlens", WorkingDirectory: `${appRoot}/app`,
    EnvironmentFile: `${configDir}/eventlens.env`, ExecStart: `${appRoot}/runtime/node/bin/node ${appRoot}/app/server.js --server` };
  for (const [key, value] of Object.entries(expected)) {
    const values = [...unit.matchAll(new RegExp(`^${key}=(.*)$`, "gm"))].map(m => m[1].trim());
    if (values.length !== 1 || values[0] !== value) reject("原服务关键配置已变更，未执行升级");
  }
  readConfig(path.join(configDir, "eventlens.env"), dataDir);
  const marker = path.join(appRoot, ".eventlens-installed");
  if (fs.existsSync(marker) || hasDanglingLink(marker)) {
    const stat = fs.lstatSync(marker);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o022)) reject("安装记录归属或类型不匹配");
    if (unit.split(/\r?\n/)[0] === "# Managed by EventLens Linux installer") return "managed";
    let record;
    try { record = JSON.parse(fs.readFileSync(marker, "utf8")); } catch (_) { /* 旧标记可能为空。 */ }
    if (record?.schema === 1 && record.app === "eventlens-local" && record.kind === "verified-legacy" && record.unitHash === fileState(unitFile)) return "adopted";
  }
  // 无标记的旧安装必须匹配固定布局，且在 shell 事务停止服务前另做真实进程及认证健康验证。
  for (const file of ["app/package.json", "app/server.js", "runtime/node/bin/node"]) {
    const stat = fs.lstatSync(path.join(appRoot, file));
    // 官方 Node tar 包可能保留构建用户 UID；运行时另由实际进程的 exe/cwd/参数验证，不改旧运行环境。
    if (!stat.isFile() || stat.isSymbolicLink() || (file !== "runtime/node/bin/node" && stat.uid !== process.getuid()) || (stat.mode & 0o022)) reject("旧程序文件归属或权限不匹配");
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(appRoot, "app/package.json"), "utf8"));
  if (pkg.name !== "eventlens-local" || !/^\d+\.\d+\.\d+$/.test(pkg.version) ||
      /^\s*(?:Environment|PassEnvironment|UnsetEnvironment|ExecStartPre|ExecStartPost|ExecStop|ExecStopPost|RootDirectory|RootImage)=/m.test(unit)) {
    reject("旧安装身份或额外服务配置不符合兼容升级要求");
  }
  return "legacy";
}

function hasDanglingLink(file) {
  try { return fs.lstatSync(file).isSymbolicLink(); } catch (_) { return false; }
}

function recordInstall(appRoot, unitFile) {
  const marker = path.join(appRoot, ".eventlens-installed");
  const temporary = `${marker}.${crypto.randomUUID()}.tmp`;
  let created = false;
  try {
    fs.writeFileSync(temporary, JSON.stringify({ schema: 1, app: "eventlens-local", kind: "verified-legacy", unitHash: fileState(unitFile) }) + "\n", { mode: 0o600, flag: "wx" });
    created = true;
    fs.renameSync(temporary, marker);
  } finally { if (created) fs.rmSync(temporary, { force: true }); }
}

function checkSource(root) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json")));
  if (pkg.name !== "eventlens-local" || !/^\d+\.\d+\.\d+$/.test(pkg.version) || Number(process.versions.node.split(".")[0]) < 22) {
    reject("安装包或 Node.js 版本不符合要求");
  }
  for (const dir of ["lib", "public"]) {
    for (const name of fs.readdirSync(path.join(root, dir))) {
      const file = path.join(root, dir, name);
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) reject("安装包包含不支持的文件");
      if (name.endsWith(".js") && spawnSync(process.execPath, ["--check", file], { stdio: "pipe" }).status !== 0) reject("安装包 JavaScript 语法校验失败");
    }
  }
  if (spawnSync(process.execPath, ["--check", path.join(root, "server.js")], { stdio: "pipe" }).status !== 0) reject("服务入口语法校验失败");
  const campaigns = JSON.parse(fs.readFileSync(path.join(root, "data/seed-campaigns.json")));
  const snapshots = JSON.parse(fs.readFileSync(path.join(root, "data/seed-snapshots.json")));
  if (!Array.isArray(campaigns) || !snapshots || Array.isArray(snapshots) || typeof snapshots !== "object") reject("安装包样本格式无效");
  return pkg.version;
}

function fileState(file) {
  if (!fs.existsSync(file)) return null;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) reject("运行文件类型不受支持");
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function captureState(dataDir, configFile, unitFile) {
  return Object.fromEntries([...runtimeFiles.map(name => path.join(dataDir, name)), configFile, unitFile].map(file => [file, fileState(file)]));
}

function verifyState(state, onlyConfiguration = false) {
  const files = Object.entries(state);
  for (const [file, hash] of onlyConfiguration ? files.slice(-2) : files) {
    if (fileState(file) !== hash) reject("原数据或配置发生变化，升级已停止");
  }
}

function ownsEndpoint(appRoot, port) {
  try {
    const pid = Number(execFileSync("systemctl", ["show", "-p", "MainPID", "--value", "eventlens.service"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim());
    if (!Number.isSafeInteger(pid) || pid < 1) return false;
    const proc = `/proc/${pid}`;
    if (fs.realpathSync(`${proc}/exe`) !== fs.realpathSync(`${appRoot}/runtime/node/bin/node`) ||
        fs.realpathSync(`${proc}/cwd`) !== fs.realpathSync(`${appRoot}/app`)) return false;
    const args = fs.readFileSync(`${proc}/cmdline`, "utf8").split("\0").filter(Boolean);
    if (args.length !== 3 || args[1] !== `${appRoot}/app/server.js` || args[2] !== "--server") return false;
    const listeners = execFileSync("ss", ["-H", "-ltnp", `sport = :${port}`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const owners = [...listeners.matchAll(/pid=(\d+),/g)].map(m => Number(m[1]));
    return owners.length > 0 && owners.every(owner => owner === pid);
  } catch (_) { return false; }
}

async function checkHealth(appRoot, dataDir, configFile, version, {
  attempts = 30, pause = ms => new Promise(resolve => setTimeout(resolve, ms)), fetchImpl = fetch, owns = ownsEndpoint
} = {}) {
  const config = readConfig(configFile, dataDir);
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (owns(appRoot, config.PORT)) {
      try {
        const response = await fetchImpl(`http://127.0.0.1:${config.PORT}/api/health`, {
          headers: { Authorization: `Basic ${Buffer.from(`${config.EVENTLENS_ACCESS_USERNAME}:${config.EVENTLENS_ACCESS_PASSWORD}`).toString("base64")}` },
          redirect: "error", signal: AbortSignal.timeout(2000)
        });
        const result = response.ok ? await response.json() : null;
        if (result?.ok === true && result.app === "eventlens-local" && result.version === version && result.desktop === false) return;
      } catch (_) { /* 不输出响应、网络诊断或认证信息。 */ }
    }
    if (attempt + 1 < attempts) await pause(1000);
  }
  reject("新版服务健康检查未通过");
}

async function main([command, ...args]) {
  if (command === "check-install") { process.stdout.write(checkInstall(...args)); return; }
  if (command === "record-install") return recordInstall(...args);
  if (command === "check-source") { process.stdout.write(checkSource(args[0])); return; }
  if (command === "snapshot") {
    fs.writeFileSync(args[3], JSON.stringify(captureState(...args.slice(0, 3))), { mode: 0o600 }); return;
  }
  if (command === "verify" || command === "verify-config") return verifyState(JSON.parse(fs.readFileSync(args[0])), command === "verify-config");
  if (command === "health") return checkHealth(...args);
  reject("未知升级校验操作");
}

if (require.main === module) main(process.argv.slice(2)).catch(() => {
  // 文件异常可能携带敏感路径，统一脱敏，不打印异常栈。
  process.stderr.write("升级校验未通过，原配置不会被重写。请在服务器本机检查安装与服务状态。\n");
  process.exitCode = 1;
});

module.exports = { parseEnvironment, readConfig, checkInstall, recordInstall, checkSource, captureState, verifyState, ownsEndpoint, checkHealth };
