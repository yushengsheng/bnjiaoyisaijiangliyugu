const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createManager } = require('../lib/linux-https');
const { readConfig } = require('../lib/linux-upgrade');
const { certificates } = require('./tls-fixture');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eventlens-acme-tests-'));
const certs = certificates(directory);
test.after(() => fs.rmSync(directory, { recursive: true, force: true }));

function fixture(mode = '') {
  const dir = fs.mkdtempSync(path.join(directory, 'case-'));
  const appRoot = path.join(dir, 'application');
  const configDir = path.join(dir, 'config');
  const dataDir = path.join(dir, 'data');
  const systemDir = path.join(dir, 'units');
  const unitFile = path.join(systemDir, 'eventlens.service');
  for (const folder of [appRoot, path.join(appRoot, 'app'), path.join(appRoot, 'runtime/node/bin'), configDir, dataDir, systemDir]) fs.mkdirSync(folder, { recursive: true });
  fs.chmodSync(configDir, 0o700);
  fs.writeFileSync(path.join(appRoot, '.eventlens-installed'), 'done');
  fs.writeFileSync(path.join(appRoot, 'runtime/node/bin/node'), 'synthetic runtime');
  fs.writeFileSync(path.join(appRoot, 'app/package.json'), '{"name":"eventlens-local","version":"2.2.1"}');
  fs.writeFileSync(unitFile, `# Managed by EventLens Linux installer\nUser=eventlens\nGroup=eventlens\nWorkingDirectory=${appRoot}/app\nEnvironmentFile=${configDir}/eventlens.env\nExecStart=${appRoot}/runtime/node/bin/node ${appRoot}/app/server.js --server\n`);
  const configFile = path.join(configDir, 'eventlens.env');
  const original = `PORT=38583\nNODE_ENV=production\nEVENTLENS_DATA_DIR=${dataDir}\nEVENTLENS_ACCESS_USERNAME=synthetic-user\nEVENTLENS_ACCESS_PASSWORD="synthetic $ \\\" password"\nEXTRA=unchanged\n`;
  fs.writeFileSync(configFile, original, { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, 'sentinel'), 'original data');
  const certbot = path.join(dir, 'certbot'); fs.writeFileSync(certbot, 'synthetic executable', { mode: 0o755 });
  let issued = 0;
  let renewCert = null;
  let healthFailure = false;
  const calls = [];
  const active = new Set(['eventlens.service']);
  const healthConfigs = [];
  const manager = createManager({ appRoot, configDir, dataDir, systemDir, unitFile,
    serviceGid: process.getgid() || 1, certbotCandidates: [certbot],
    run(command, args) {
      calls.push([command, args]);
      if (command === certbot) {
        if (args[0] === '--help') return mode === 'old-certbot' ? 'old' : '--ip-address --required-profile';
        if (mode === 'acme-failure') throw new Error('synthetic issuance error');
        if (args[0] === 'certonly') {
          issued++;
          assert.ok(args.includes('shortlived')); assert.ok(args.includes('--ip-address'));
        }
        const certDir = path.join(configDir, 'acme/live/eventlens-ip');
        fs.mkdirSync(certDir, { recursive: true });
        const certificate = renewCert || certs[0];
        fs.copyFileSync(certificate.cert, path.join(certDir, 'fullchain.pem'));
        fs.copyFileSync(certificate.key, path.join(certDir, 'privkey.pem'));
        return '';
      }
      if (command === 'ss') return mode === 'busy-80' ? 'synthetic-listener' : '';
      if (command === 'systemctl') {
        if (args[0] === 'is-active') { if (active.has(args[2])) return ''; throw new Error('inactive'); }
        if (args[0] === 'enable') { if (mode === 'timer-failure') throw new Error('synthetic failure'); active.add(args[2]); }
        if (args[0] === 'disable') active.delete(args[2]);
        return '';
      }
      throw new Error('unexpected synthetic command');
    },
    async health() {
      const c = readConfig(configFile, dataDir); healthConfigs.push(c);
      assert.equal(c.PORT, '38583');
      if (healthFailure || (mode === 'restart-failure' && c.EVENTLENS_TLS_HOST)) throw new Error('synthetic health failure');
    }
  });
  return { manager, appRoot, configDir, configFile, dataDir, systemDir, original, calls, active, healthConfigs,
    get issued() { return issued; }, renewWith(cert) { renewCert = cert; }, set healthFailure(v) { healthFailure = v; } };
}

test('显式启用可信 IP 证书及双次日续期，保留原端口、账号、配置和数据；不限制来源 IP', async () => {
  const f = fixture();
  await f.manager.enable('203.0.113.10');
  const c = readConfig(f.configFile, f.dataDir);
  assert.equal(c.PORT, '38583'); assert.equal(c.EXTRA, 'unchanged');
  assert.equal(c.EVENTLENS_ACCESS_USERNAME, 'synthetic-user');
  assert.equal(c.EVENTLENS_TLS_HOST, '203.0.113.10');
  assert.equal(fs.statSync(c.EVENTLENS_TLS_KEY).mode & 0o777, 0o640);
  assert.equal(fs.statSync(f.configDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(f.configFile).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(path.join(f.dataDir, 'sentinel'), 'utf8'), 'original data');
  assert.equal(f.active.has('eventlens-cert-renew.timer'), true);
  assert.match(fs.readFileSync(path.join(f.systemDir, 'eventlens-cert-renew.timer'), 'utf8'), /00,12:00:00/);
  assert.doesNotMatch(fs.readFileSync(path.join(f.systemDir, 'eventlens-cert-renew.service'), 'utf8'), /IPAddressAllow|IPAddressDeny|iptables|ufw/);
  const backup = path.join(f.appRoot, 'backups', fs.readdirSync(path.join(f.appRoot, 'backups'))[0], 'config.before');
  assert.equal(fs.readFileSync(backup, 'utf8'), f.original);
});

for (const mode of ['old-certbot', 'busy-80', 'acme-failure', 'restart-failure', 'timer-failure', 'unit-conflict']) {
  test(`HTTPS ${mode} 失败不丢原配置或原数据`, async () => {
    const f = fixture(mode);
    if (mode === 'unit-conflict') fs.symlinkSync(path.join(directory, 'absent'), path.join(f.systemDir, 'eventlens-cert-renew.service'));
    await assert.rejects(f.manager.enable('203.0.113.10'));
    assert.equal(fs.readFileSync(f.configFile, 'utf8'), f.original);
    assert.equal(fs.readFileSync(path.join(f.dataDir, 'sentinel'), 'utf8'), 'original data');
    assert.equal(f.active.has('eventlens-cert-renew.timer'), false);
    if (['old-certbot', 'busy-80', 'unit-conflict'].includes(mode)) assert.equal(f.issued, 0);
  });
}

test('续期仅在新证书有效时热加载，失败恢复旧证书；服务原先停止时不会擅自启动', async () => {
  const f = fixture(); await f.manager.enable('203.0.113.10');
  const current = path.join(f.appRoot, 'tls/current');
  const first = fs.readlinkSync(current);
  const reloads = () => f.calls.filter(([command, args]) => command === 'systemctl' && args[0] === 'kill').length;
  await f.manager.renew(); assert.equal(fs.readlinkSync(current), first); assert.equal(reloads(), 0);
  f.renewWith(certs[1]); f.healthFailure = true;
  await assert.rejects(f.manager.renew(), /恢复原证书/);
  assert.equal(fs.readlinkSync(current), first); assert.equal(reloads(), 2);
  f.healthFailure = false;
  await f.manager.renew(); assert.notEqual(fs.readlinkSync(current), first); assert.equal(reloads(), 3);
  f.active.delete('eventlens.service'); f.renewWith(certs[0]);
  await f.manager.renew(); assert.equal(reloads(), 3);
  assert.equal(f.active.has('eventlens.service'), false);
});
