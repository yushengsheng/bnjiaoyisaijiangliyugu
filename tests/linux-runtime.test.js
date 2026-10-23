const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const q = s => `'${s.replace(/'/g, `'"'"'`)}'`;

for (const mode of ['trusted', 'legacy', 'special-bits', 'bad-binary', 'bad-checksum', 'external-link', 'writable-parent']) {
  test(`运行时加固 ${mode}：不执行未经信任的旧 Node，不修改原数据`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eventlens-runtime-'));
    try {
      const app = path.join(dir, 'installation');
      const tree = path.join(app, 'runtime/node');
      const work = path.join(dir, 'work');
      const archive = path.join(dir, 'node.tar.xz');
      const entry = path.join(dir, 'executed');
      fs.mkdirSync(path.join(tree, 'bin'), { recursive: true });
      fs.mkdirSync(path.join(tree, 'include/node'), { recursive: true });
      fs.mkdirSync(work);
      fs.writeFileSync(path.join(tree, 'include/node/node_version.h'), '#define NODE_MAJOR_VERSION 22\n#define NODE_MINOR_VERSION 1\n#define NODE_PATCH_VERSION 0\n');
      const node = `#!/bin/bash\nprintf verified >${q(entry)}\n`;
      fs.writeFileSync(path.join(tree, 'bin/node'), node, { mode: 0o755 });
      execFileSync('tar', ['-cJf', archive, '-C', path.dirname(tree), 'node']);
      const hash = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
      const sums = path.join(dir, 'sums');
      fs.writeFileSync(sums, `${mode === 'bad-checksum' ? '0'.repeat(64) : hash}  node-v22.1.0-linux-x64.tar.xz\n`);
      if (mode === 'bad-binary') fs.appendFileSync(path.join(tree, 'bin/node'), '# changed');
      if (!['trusted', 'external-link', 'writable-parent'].includes(mode)) fs.chmodSync(path.join(tree, 'bin/node'), 0o775);
      if (mode === 'special-bits') fs.chmodSync(path.join(tree, 'bin/node'), 0o4755);
      const outside = path.join(dir, 'outside');
      fs.writeFileSync(outside, 'untouched', { mode: 0o666 });
      const outsideMode = fs.statSync(outside).mode;
      if (mode === 'external-link') fs.symlinkSync(outside, path.join(tree, 'bin/escape'));
      if (mode === 'writable-parent') fs.chmodSync(app, 0o777);
      fs.writeFileSync(path.join(app, 'data-sentinel'), 'original');
      const result = spawnSync('bash', ['-c', `
        source ${q(path.join(root, 'install-linux.sh'))}
        APP_ROOT=${q(app)} INSTALL_TEMP=${q(work)} NODE_BIN=${q(path.join(tree, 'bin/node'))}
        download() {
          case "$1" in
            https://nodejs.org/dist/v22.1.0/SHASUMS256.txt) cp ${q(sums)} "$2";;
            https://nodejs.org/dist/v22.1.0/node-v22.1.0-linux-x64.tar.xz) cp ${q(archive)} "$2";;
            *) exit 99;;
          esac
        }
        prepare_node_runtime || exit 1
        if [[ ${q(mode)} == legacy ]]; then [[ "$NODE_BIN" == "$INSTALL_TEMP/verified-node/bin/node" ]] || exit 9; fi
        "$NODE_BIN"
      `], { encoding: 'utf8' });
      if (['trusted', 'legacy', 'special-bits'].includes(mode)) {
        assert.equal(result.status, 0, result.stderr);
        assert.equal(fs.readFileSync(entry, 'utf8'), 'verified');
        assert.equal(fs.statSync(path.join(tree, 'bin/node')).mode & 0o6022, 0);
        assert.equal(fs.statSync(path.join(tree, 'bin/node')).uid, process.getuid());
      } else {
        assert.notEqual(result.status, 0);
        assert.equal(fs.existsSync(entry), false);
      }
      assert.equal(fs.readFileSync(path.join(app, 'data-sentinel'), 'utf8'), 'original');
      assert.equal(fs.readFileSync(outside, 'utf8'), 'untouched');
      assert.equal(fs.statSync(outside).mode, outsideMode);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
}

for (const mode of ['symlink', 'writable']) test(`未完成安装的运行时父目录 ${mode} 不会被跟随或覆盖`, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eventlens-runtime-parent-'));
  try {
    const app = path.join(dir, 'application'); fs.mkdirSync(app);
    const outside = path.join(dir, 'outside'); fs.mkdirSync(outside);
    if (mode === 'symlink') fs.symlinkSync(outside, path.join(app, 'runtime'));
    else { fs.mkdirSync(path.join(app, 'runtime')); fs.chmodSync(path.join(app, 'runtime'), 0o775); }
    fs.writeFileSync(path.join(outside, 'sentinel'), 'untouched');
    const marker = path.join(dir, 'should-not-download');
    const result = spawnSync('bash', ['-c', `source ${q(path.join(root, 'install-linux.sh'))}
APP_ROOT=${q(app)} INSTALL_TEMP=${q(dir)}
fetch_node() { touch ${q(marker)}; return 1; }
install_node
`], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.equal(fs.existsSync(marker), false);
    assert.deepEqual(fs.readdirSync(outside), ['sentinel']);
    assert.equal(fs.readFileSync(path.join(outside, 'sentinel'), 'utf8'), 'untouched');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
