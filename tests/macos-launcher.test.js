const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.join(__dirname, "..");
const app = path.join(root, "双击打开.app");
const macOS = { skip: process.platform !== "darwin" };

test("macOS 应用包含有效签名的 Intel 与 Apple Silicon 原生入口", macOS, () => {
  const architectures = execFileSync("/usr/bin/lipo", ["-archs", path.join(app, "Contents/MacOS/EventLens")], { encoding: "utf8" });
  assert.match(architectures, /\barm64\b/);
  assert.match(architectures, /\bx86_64\b/);
  execFileSync("/usr/bin/codesign", ["--verify", "--strict", app]);
  const info = JSON.parse(execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", path.join(app, "Contents/Info.plist")], { encoding: "utf8" }));
  for (const folder of ["DownloadsFolder", "DesktopFolder", "DocumentsFolder", "RemovableVolumes", "NetworkVolumes"]) {
    assert.ok(info[`NS${folder}UsageDescription`]);
  }
});

test("原生启动器在中文、空格、引号及 shell 特殊字符路径中准确启动项目", macOS, () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "eventlens-launcher-"));
  const project = path.join(temp, "中文 空格 ' $ ` & 项目");
  try {
    fs.mkdirSync(project);
    fs.cpSync(app, path.join(project, "双击打开.app"), { recursive: true });
    fs.writeFileSync(path.join(project, "start.sh"),
      '#!/bin/bash\nprintf "%s\\n" "$PWD" "$#" "${1:-}" "$EVENTLENS_LAUNCH_MARKER" > "$PWD/launch-result.txt"\n',
      { mode: 0o600 });
    const dataDir = path.join(temp, "独立 运行数据");
    execFileSync(path.join(project, "双击打开.app/Contents/MacOS/EventLens"), [], {
      env: { ...process.env, EVENTLENS_DATA_DIR: dataDir, EVENTLENS_LAUNCH_MARKER: "原生启动 验证" },
      timeout: 10000
    });
    const result = fs.readFileSync(path.join(project, "launch-result.txt"), "utf8").trim().split("\n");
    assert.deepEqual(result, [fs.realpathSync(project), "1", "--desktop", "原生启动 验证"]);
    assert.ok(fs.existsSync(path.join(dataDir, "desktop-launch.log")));
    assert.equal(fs.existsSync(path.join(project, "data")), false, "自定义数据目录不应写入项目数据");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
