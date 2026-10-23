const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const tls = require('node:tls');
const http = require('node:http');
const { readTlsConfig, loadTlsOptions } = require('../lib/tls');
const { checkHealth } = require('../lib/linux-upgrade');
const { makeDataDir } = require('./helpers');
process.env.EVENTLENS_DATA_DIR = makeDataDir();
const { createServer } = require('../server');
const version = require('../package.json').version;
const { certificates } = require('./tls-fixture');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eventlens-tls-'));
const fixtures = certificates(dir);
const fixture = fixtures[0];
const cfg = { cert: fixture.cert, key: fixture.key, host: '203.0.113.10' };
const auth = 'Basic ' + Buffer.from('fixture:synthetic-password').toString('base64');
function get(server, { host = cfg.host, headers = {}, pathname = '/api/health', method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: '127.0.0.1', port: server.address().port, path: pathname, method,
      ca: fs.readFileSync(path.join(dir, 'ca.pem')), agent: false,
      checkServerIdentity: (_, cert) => tls.checkServerIdentity(host, cert),
      headers: { Host: `${cfg.host}:${server.address().port}`, ...headers }
    }, response => {
      let body = ''; response.on('data', b => { body += b; });
      response.on('end', () => resolve({ status: response.statusCode, body, cert: response.socket.getPeerCertificate().fingerprint256 }));
    }); req.on('error', reject); req.end(body);
  });
}
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('HTTPS 配置必须完整，验证 IP、私钥权限与密钥匹配；错误时不回退 HTTP', () => {
  assert.equal(readTlsConfig({}), null);
  for (const env of [{ EVENTLENS_TLS_CERT: cfg.cert }, { EVENTLENS_TLS_CERT: cfg.cert, EVENTLENS_TLS_KEY: cfg.key },
    { EVENTLENS_TLS_CERT: 'relative', EVENTLENS_TLS_KEY: cfg.key, EVENTLENS_TLS_HOST: cfg.host }]) assert.throws(() => readTlsConfig(env), /配置/);
  assert.ok(loadTlsOptions(cfg).cert);
  for (const invalid of [{ ...cfg, host: '203.0.113.11' }, { ...cfg, key: fixtures[1].key }, { ...cfg, cert: path.join(dir, 'absent') }]) {
    assert.throws(() => createServer({ remoteAccess: true, tlsConfig: invalid }), /HTTPS/);
  }
  fs.chmodSync(cfg.key, 0o644);
  assert.throws(() => loadTlsOptions(cfg), /权限/);
  fs.chmodSync(cfg.key, 0o600);
});

test('真实 HTTPS 支持 IP 证书、密码保护、同源写令牌，并拒绝明文 HTTP', async () => {
  const server = createServer({ remoteAccess: true, accessUsername: 'fixture', accessPassword: 'synthetic-password', tlsConfig: cfg });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    assert.equal((await get(server)).status, 401);
    for (const route of ['/', '/app.js', '/api/health', '/api/session']) {
      assert.equal((await get(server, { headers: { Authorization: auth }, pathname: route })).status, 200);
    }
    await assert.rejects(get(server, { host: '203.0.113.11', headers: { Authorization: auth } }), /IP|Hostname|altnames/i);
    const token = JSON.parse((await get(server, { headers: { Authorization: auth }, pathname: '/api/session' })).body).token;
    const mutation = { pathname: '/api/scheduler/config', method: 'POST', body: '{"autoUpdateEnabled":false}',
      headers: { Authorization: auth, 'Content-Type': 'application/json', Origin: `https://${cfg.host}:${server.address().port}` } };
    assert.equal((await get(server, mutation)).status, 403);
    mutation.headers['X-EventLens-Token'] = token;
    assert.equal((await get(server, mutation)).status, 200);
    mutation.headers.Origin = 'https://other.example';
    assert.equal((await get(server, mutation)).status, 403);
    await assert.rejects(new Promise((resolve, reject) => {
      const request = http.get({ hostname: '127.0.0.1', port: server.address().port, path: '/api/health' }, resolve);
      request.on('error', reject);
    }));
    const configFile = path.join(dir, 'environment');
    const env = `PORT=${server.address().port}\nEVENTLENS_DATA_DIR=${dir}\nEVENTLENS_ACCESS_USERNAME=fixture\nEVENTLENS_ACCESS_PASSWORD=synthetic-password\nEVENTLENS_TLS_CERT=${cfg.cert}\nEVENTLENS_TLS_KEY=${cfg.key}\nEVENTLENS_TLS_HOST=${cfg.host}\n`;
    fs.writeFileSync(configFile, env, { mode: 0o600 });
    await checkHealth('fixture', dir, configFile, version, { attempts: 1, owns: () => true });
    let requests = 0;
    const count = () => { requests++; };
    server.on('request', count);
    const changed = { ...cfg, cert: fixtures[1].cert, key: fixtures[1].key };
    server.setSecureContext(loadTlsOptions(changed));
    await assert.rejects(checkHealth('fixture', dir, configFile, version, { attempts: 1, owns: () => true }));
    assert.equal(requests, 0, '证书不匹配时不得发送认证头');
    server.off('request', count);
    server.setSecureContext(loadTlsOptions(cfg));
    fs.writeFileSync(configFile, env.replace(cfg.host, '203.0.113.11'));
    await assert.rejects(checkHealth('fixture', dir, configFile, version, { attempts: 1, owns: () => true }));
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('证书热加载成功后使用新证书，加载失败继续使用原证书', async () => {
  const live = { ...cfg, cert: path.join(dir, 'live-cert.pem'), key: path.join(dir, 'live-key.pem') };
  fs.copyFileSync(cfg.cert, live.cert); fs.copyFileSync(cfg.key, live.key); fs.chmodSync(live.key, 0o600);
  const server = createServer({ remoteAccess: true, tlsConfig: live, accessPassword: '' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const first = (await get(server)).cert;
    fs.copyFileSync(fixtures[1].cert, live.cert); fs.copyFileSync(fixtures[1].key, live.key);
    server.reloadTls();
    const second = (await get(server)).cert;
    assert.notEqual(first, second);
    fs.writeFileSync(live.key, 'damaged synthetic key');
    assert.throws(() => server.reloadTls(), /HTTPS/);
    assert.equal((await get(server)).cert, second);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
