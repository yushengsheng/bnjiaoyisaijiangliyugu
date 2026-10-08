const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

function runtimeIdentity(root = path.join(__dirname, "..")) {
  const hash = crypto.createHash("sha256");
  const files = ["server.js", "package.json", ...["lib", "public"].flatMap(dir =>
    fs.readdirSync(path.join(root, dir)).sort().filter(name => /\.(js|css|html)$/.test(name)).map(name => `${dir}/${name}`))];
  for (const file of files) hash.update(file).update(fs.readFileSync(path.join(root, file)));
  return { projectId: crypto.createHash("sha256").update(fs.realpathSync(root)).digest("hex"), buildId: hash.digest("hex").slice(0, 16) };
}

// 持续连接不依赖后台标签页的 JavaScript 定时器；刷新/重连留出宽限时间。
function createPageLifetime(stop, { idleMs = 10000, startupMs = 90000 } = {}) {
  const clients = new Set();
  let disposed = false;
  let timer;
  const arm = delay => {
    clearTimeout(timer);
    timer = setTimeout(() => { if (!disposed && !clients.size) stop(); }, delay);
    timer.unref?.();
  };
  arm(startupMs);
  return {
    attach(req, res) {
      clearTimeout(timer);
      clients.add(res);
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Content-Type-Options": "nosniff" });
      res.write("data: connected\n\n");
      const heartbeat = setInterval(() => res.write(": keepalive\n\n"), 15000);
      heartbeat.unref?.();
      res.on("close", () => {
        clearInterval(heartbeat);
        clients.delete(res);
        if (!disposed && !clients.size) arm(idleMs);
      });
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
      for (const res of clients) res.end();
      clients.clear();
    }
  };
}

module.exports = { runtimeIdentity, createPageLifetime };
