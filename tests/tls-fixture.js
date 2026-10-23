// 测试专用的临时 CA 和 IP 证书；不会信任到系统、访问 CA 或使用真实私钥。
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
function certificates(dir) {
  const openssl = args => execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' });
  openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2', '-subj', '/CN=EventLens Test CA']);
  fs.writeFileSync(path.join(dir, 'extensions'), 'subjectAltName=IP:203.0.113.10\nextendedKeyUsage=serverAuth\n');
  return [1, 2].map(n => {
    openssl(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${n}.key`, '-out', `${n}.csr`, '-subj', '/CN=EventLens synthetic fixture']);
    openssl(['x509', '-req', '-in', `${n}.csr`, '-CA', 'ca.pem', '-CAkey', 'ca.key', '-set_serial', `${n}`, '-out', `${n}.pem`, '-days', '2', '-extfile', 'extensions']);
    fs.chmodSync(path.join(dir, `${n}.key`), 0o600);
    return { cert: path.join(dir, `${n}.pem`), key: path.join(dir, `${n}.key`) };
  });
}
module.exports = { certificates };
