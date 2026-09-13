const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.join(__dirname, "..");
const version = require("../package.json").version;

test("启动器无用户专属绝对路径且要求 Node 22", () => {
  for (const file of ["start.sh", "start.bat", "Open-EventLens.command", "双击打开.command"]) {
    const content = fs.readFileSync(path.join(root, file), "utf8");
    assert.doesNotMatch(content, /\/Users\/ys|C:\\Users\\ys/);
  }
  assert.equal(require("../package.json").engines.node, ">=22.0.0");
});

test("Release ZIP 可生成、解压并从种子数据首次启动", () => {
  execFileSync(path.join(root, "scripts/package-release.sh"), { cwd: root });
  const archive = path.join(root, "dist", `EventLens-Local-v${version}.zip`);
  assert.equal(fs.existsSync(archive), true);
  const listing = execFileSync("unzip", ["-Z1", archive], { encoding: "utf8" });
  assert.match(listing, /server\.js/);
  assert.match(listing, /seed-campaigns\.json/);
  assert.match(listing, /Open-EventLens\.command/);
  assert.doesNotMatch(listing, /manifest\.json|background\.js|data\/campaigns\.json/);

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "eventlens-package-"));
  execFileSync("unzip", ["-q", archive, "-d", temp]);
  const folder = path.join(temp, `EventLens-Local-v${version}`);
  execFileSync(process.execPath, ["--check", "server.js"], { cwd: folder });
  assert.equal(fs.existsSync(path.join(folder, "双击打开.command")), true);
  assert.equal(fs.statSync(path.join(folder, "start.sh")).mode & 0o111, 0o111);
});
