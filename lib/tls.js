// 可选的同端口 HTTPS。未配置时保持原 HTTP；配置错误绝不回退明文。
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const tls = require("node:tls");
const { X509Certificate } = require("node:crypto");

function readTlsConfig(env = process.env) {
  const cert = env.EVENTLENS_TLS_CERT || "";
  const key = env.EVENTLENS_TLS_KEY || "";
  const host = env.EVENTLENS_TLS_HOST || "";
  if (!cert && !key && !host) return null;
  if (!path.isAbsolute(cert) || !path.isAbsolute(key) ||
      !(net.isIP(host) || /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(host))) {
    throw new Error("HTTPS 配置不完整：需要证书、私钥的绝对路径及证书对应的服务器 IP 或域名");
  }
  return { cert, key, host };
}

function loadTlsOptions(config) {
  try {
    const stat = fs.statSync(config.key);
    if (!stat.isFile() || (process.platform !== "win32" && (stat.mode & 0o027))) throw new Error();
    const cert = fs.readFileSync(config.cert);
    const key = fs.readFileSync(config.key);
    const leaf = new X509Certificate(cert);
    if (Date.parse(leaf.validFrom) > Date.now() || Date.parse(leaf.validTo) <= Date.now() ||
        !(net.isIP(config.host) ? leaf.checkIP(config.host) : leaf.checkHost(config.host))) throw new Error();
    const options = { cert, key, minVersion: "TLSv1.2" };
    tls.createSecureContext(options); // 包括证书与私钥匹配检查。
    return options;
  } catch (_) {
    throw new Error("HTTPS 证书加载失败：请在本机检查有效期、服务器地址、私钥权限及证书是否匹配");
  }
}

module.exports = { readTlsConfig, loadTlsOptions };
