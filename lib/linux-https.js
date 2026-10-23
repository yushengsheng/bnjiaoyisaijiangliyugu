// Linux 可选 IP 证书管理。仅显式启用时申请证书；所有子进程输出留在本机。
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const { execFileSync } = require("node:child_process");
const { readConfig, checkInstall, checkHealth } = require("./linux-upgrade");
const { loadTlsOptions } = require("./tls");
const fail = message => { throw Object.assign(new Error(message), { publicMessage: true }); };

function createManager({ appRoot = "/opt/eventlens", dataDir = "/var/lib/eventlens", configDir = "/etc/eventlens",
  unitFile = "/etc/systemd/system/eventlens.service", systemDir = "/etc/systemd/system", serviceGid,
  certbotCandidates = ["/snap/bin/certbot", "/usr/bin/certbot", "/usr/local/bin/certbot"],
  run = (command, args) => execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 300000 }),
  health = checkHealth
} = {}) {
  const configFile = path.join(configDir, "eventlens.env");
  const certDir = path.join(configDir, "acme/live/eventlens-ip");
  const tlsDir = path.join(appRoot, "tls");
  const current = path.join(tlsDir, "current");
  const timerName = "eventlens-cert-renew.timer";
  const serviceName = "eventlens-cert-renew.service";
  const version = () => JSON.parse(fs.readFileSync(path.join(appRoot, "app/package.json"))).version;
  const active = name => { try { run("systemctl", ["is-active", "--quiet", name]); return true; } catch (_) { return false; } };
  const privateDir = dir => {
    if (fs.existsSync(dir)) {
      const stat = fs.lstatSync(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o022)) fail("证书目录归属或权限不安全");
    } else fs.mkdirSync(dir, { mode: 0o700 });
  };
  const atomic = (file, data, mode = 0o600) => {
    const temp = `${file}.${require("node:crypto").randomUUID()}.tmp`;
    try { fs.writeFileSync(temp, data, { flag: "wx", mode }); fs.renameSync(temp, file); }
    finally { fs.rmSync(temp, { force: true }); }
  };
  const pointer = () => {
    try {
      const stat = fs.lstatSync(current);
      const target = fs.readlinkSync(current);
      if (!stat.isSymbolicLink() || !/^cert-[a-zA-Z0-9]+$/.test(target)) fail("证书指针不受支持");
      return target;
    } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  };
  const switchTo = target => {
    const temporary = `${current}.${require("node:crypto").randomUUID()}.tmp`;
    try {
      if (target) { fs.symlinkSync(target, temporary); fs.renameSync(temporary, current); }
      else fs.unlinkSync(current);
    } finally { fs.rmSync(temporary, { force: true }); }
  };
  function certbot() {
    for (const command of certbotCandidates) {
      if (!fs.existsSync(command)) continue;
      const stat = fs.statSync(command);
      if (stat.uid !== process.getuid() || (stat.mode & 0o022)) continue;
      const help = run(command, ["--help", "all"]);
      if (help.includes("--ip-address") && help.includes("--required-profile")) return command;
    }
    fail("需要支持 IP 证书的新版 Certbot，请先按官方说明安装，再重试；未改变原网页配置");
  }
  const acmePaths = () => ["--config-dir", path.join(configDir, "acme"), "--work-dir", path.join(configDir, "acme-work"), "--logs-dir", path.join(configDir, "acme-logs")];
  function prepare() {
    checkInstall(appRoot, dataDir, configDir, unitFile);
    for (const name of ["acme", "acme-work", "acme-logs"]) privateDir(path.join(configDir, name));
    privateDir(tlsDir);
  }
  function stage(host) {
    const dir = fs.mkdtempSync(path.join(tlsDir, "cert-"));
    try {
      const gid = serviceGid ?? Number(run("id", ["-g", "eventlens"]).trim());
      if (!Number.isSafeInteger(gid) || gid < 1) fail("无法识别服务组");
      fs.chownSync(tlsDir, process.getuid(), gid); fs.chmodSync(tlsDir, 0o750);
      fs.chownSync(dir, process.getuid(), gid); fs.chmodSync(dir, 0o750);
      for (const [file, mode] of [["fullchain.pem", 0o644], ["privkey.pem", 0o640]]) {
        const destination = path.join(dir, file);
        fs.writeFileSync(destination, fs.readFileSync(path.join(certDir, file)), { mode, flag: "wx" });
        fs.chownSync(destination, process.getuid(), gid);
      }
      loadTlsOptions({ cert: path.join(dir, "fullchain.pem"), key: path.join(dir, "privkey.pem"), host });
      return path.basename(dir);
    } catch (error) { fs.rmSync(dir, { recursive: true, force: true }); throw error; }
  }
  // 只写本程序自己的 timer；不会覆盖别人的同名 unit。
  const exists = file => { try { fs.lstatSync(file); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } };
  function timerUnits() {
    const marker = "# Managed by EventLens HTTPS\n";
    const service = marker + `[Unit]\nDescription=Renew EventLens IP certificate\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=oneshot\nUser=root\nUMask=0077\nExecStart=/usr/bin/flock -n /run/lock/eventlens-install.lock ${appRoot}/runtime/node/bin/node ${appRoot}/app/lib/linux-https.js renew\n`;
    const timer = marker + `[Unit]\nDescription=Check EventLens certificate twice daily\n\n[Timer]\nOnCalendar=*-*-* 00,12:00:00\nRandomizedDelaySec=1h\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n`;
    const entries = [[serviceName, service], [timerName, timer]].map(([name, content]) => ({ file: path.join(systemDir, name), content }));
    for (const entry of entries) if (exists(entry.file)) {
      const stat = fs.lstatSync(entry.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o022) || fs.readFileSync(entry.file, "utf8") !== entry.content) fail("续期服务同名配置已存在且不匹配，未覆盖");
    }
    return entries;
  }
  async function enable(host) {
    if (net.isIP(host) !== 4) fail("请提供稳定的服务器公网 IPv4，不能填写客户端来源 IP");
    prepare();
    const config = readConfig(configFile, dataDir);
    if (config.EVENTLENS_TLS_HOST && config.EVENTLENS_TLS_HOST !== host) fail("已配置其他证书地址，未覆盖原 HTTPS 配置");
    const units = timerUnits(); // 在签发前检查同名冲突。
    const command = certbot();
    if (!active("eventlens.service")) fail("首次启用 HTTPS 需要原服务正在运行");
    await health(appRoot, dataDir, configFile, version());
    if (run("ss", ["-H", "-ltn", "sport = :80"]).trim()) fail("证书 HTTP-01 验证需要空闲的 TCP 80；未停止原服务或修改端口");
    run(command, ["certonly", "--non-interactive", "--agree-tos", "--register-unsafely-without-email", "--standalone", "--preferred-challenges", "http", "--required-profile", "shortlived", "--ip-address", host, "--cert-name", "eventlens-ip", "--server", "https://acme-v02.api.letsencrypt.org/directory", ...acmePaths()]);
    const previous = pointer();
    const next = stage(host);
    const original = fs.readFileSync(configFile);
    const backups = path.join(appRoot, "backups"); privateDir(backups);
    const backup = fs.mkdtempSync(path.join(backups, "https-"));
    fs.writeFileSync(path.join(backup, "config.before"), original, { mode: 0o600, flag: "wx" });
    const created = [];
    let timerStarted = false;
    try {
      switchTo(next);
      const retained = original.toString("utf8").split(/\r?\n/).filter(line => !/^EVENTLENS_TLS_(?:CERT|KEY|HOST)=/.test(line)).join("\n").trimEnd();
      atomic(configFile, `${retained}\nEVENTLENS_TLS_CERT=${current}/fullchain.pem\nEVENTLENS_TLS_KEY=${current}/privkey.pem\nEVENTLENS_TLS_HOST=${host}\n`);
      run("systemctl", ["restart", "eventlens.service"]);
      await health(appRoot, dataDir, configFile, version());
      for (const entry of units) if (!exists(entry.file)) { atomic(entry.file, entry.content, 0o644); created.push(entry.file); }
      run("systemctl", ["daemon-reload"]);
      timerStarted = !active(timerName);
      run("systemctl", ["enable", "--now", timerName]);
      if (!active(timerName)) fail("自动续期 timer 未运行");
    } catch (error) {
      if (timerStarted) try { run("systemctl", ["disable", "--now", timerName]); } catch (_) { /* 本机检查 */ }
      for (const file of created) fs.unlinkSync(file);
      atomic(configFile, original); switchTo(previous);
      try { run("systemctl", ["daemon-reload"]); run("systemctl", ["restart", "eventlens.service"]); await health(appRoot, dataDir, configFile, version()); }
      catch (_) { fail("HTTPS 启用失败，已保留原配置备份；服务恢复检查未通过，请在本机检查"); }
      fail("HTTPS 启用失败，已恢复原配置和原服务");
    }
  }
  async function renew() {
    prepare();
    const config = readConfig(configFile, dataDir);
    if (!config.EVENTLENS_TLS_HOST || config.EVENTLENS_TLS_CERT !== `${current}/fullchain.pem` || config.EVENTLENS_TLS_KEY !== `${current}/privkey.pem`) fail("HTTPS 不是本程序管理的证书，未续期或覆盖");
    run(certbot(), ["renew", "--non-interactive", "--cert-name", "eventlens-ip", ...acmePaths()]);
    if (["fullchain.pem", "privkey.pem"].every(file => fs.readFileSync(path.join(certDir, file)).equals(fs.readFileSync(path.join(current, file))))) return;
    const previous = pointer();
    const next = stage(config.EVENTLENS_TLS_HOST);
    const running = active("eventlens.service");
    switchTo(next);
    const reload = () => run("systemctl", ["kill", "--kill-whom=main", "--signal=HUP", "eventlens.service"]);
    try { if (running) { reload(); await health(appRoot, dataDir, configFile, version()); } }
    catch (_) {
      switchTo(previous);
      if (running) try { reload(); } catch (_) { /* 保留旧证书，timer 下次重试 */ }
      fail("新证书加载检查失败，已恢复原证书；续期任务下次重试");
    }
  }
  return { enable, renew };
}

if (require.main === module) (async () => {
  if (process.getuid?.() !== 0) fail("HTTPS 配置需要管理员权限");
  const manager = createManager();
  if (process.argv[2] === "enable" && process.argv.length === 4) await manager.enable(process.argv[3]);
  else if (process.argv[2] === "renew" && process.argv.length === 3) await manager.renew();
  else fail("HTTPS 参数无效");
  process.stdout.write("HTTPS 操作完成；原网页端口、账号和数据保持不变。\n");
})().catch(error => {
  // Certbot 诊断、真实服务器地址及文件路径不进入输出。
  process.stderr.write(`HTTPS 操作失败：${error.publicMessage ? error.message : "证书申请或服务操作失败，请在本机检查证书验证端口及 Certbot 状态"}\n`);
  process.exitCode = 1;
});
module.exports = { createManager };
