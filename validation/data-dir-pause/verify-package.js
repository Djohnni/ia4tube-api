'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const root = __dirname;
const git = (...args) => cp.execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const manifestBytes = fs.readFileSync(path.join(root, 'LINUX_PACKAGE_MANIFEST.json'));
const manifest = JSON.parse(manifestBytes);
if (manifest.expectedParent !== 'b1d7ebcbab284a371c784a85bd7c545944e54d8e') throw Error('Unreviewed parent revision');
const workflowPath = '.github/workflows/data-dir-pause-linux.yml';
const repoRoot = git('rev-parse', '--show-toplevel');
const message = git('log', '-1', '--format=%B');
if (!message.includes(`Pause-Linux-Manifest-SHA256: ${digest(manifestBytes)}`)) throw Error('Manifest commit binding mismatch');
if (!message.includes(`Pause-Linux-Workflow-SHA256: ${digest(fs.readFileSync(path.join(repoRoot, workflowPath)))}`)) throw Error('Workflow commit binding mismatch');
if (git('rev-parse', 'HEAD^') !== manifest.expectedParent) throw Error('Unexpected candidate parent');
const changes = git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD').split('\n').filter(Boolean);
if (!changes.length || changes.some(name => name !== workflowPath && !name.startsWith('validation/data-dir-pause/'))) throw Error('Change outside synthetic lab scope');
const expected = new Set(manifest.files.map(entry => entry.path));
function walk(dir, prefix = '') {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix + entry.name;
    const absolute = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) throw Error('Symlink in laboratory package');
    if (entry.isDirectory()) { walk(absolute, relative + '/'); continue; }
    if (!entry.isFile()) throw Error('Nonregular laboratory file');
    if (relative === 'LINUX_PACKAGE_MANIFEST.json') continue;
    if (!expected.has(relative)) throw Error('Unexpected laboratory file: ' + relative);
  }
}
walk(root);
for (const entry of manifest.files) {
  if (!/^[a-zA-Z0-9_./-]+$/.test(entry.path) || entry.path.includes('..')) throw Error('Invalid manifest path');
  const data = fs.readFileSync(path.join(root, entry.path));
  if (data.length !== entry.bytes || digest(data) !== entry.sha256) throw Error('Package hash mismatch: ' + entry.path);
}
const originalBytes = fs.readFileSync(path.join(root, 'PAUSE_INSTALL_MANIFEST.json'));
if (digest(originalBytes) !== 'c57ef76fb2d6d5b429ec0eed707992bb49339f61a14c41e08f7c796ed2f1179e') throw Error('Historical installation manifest pin mismatch');
const original = JSON.parse(originalBytes);
if (original.liveBase !== '1bd987f1ecbbd3a64f2ad0e905d30649704f4b3c' || original.candidateHeadObserved !== 'b1d7ebcbab284a371c784a85bd7c545944e54d8e' || original.files.length !== 14) throw Error('Historical base mismatch');
if (digest(fs.readFileSync(path.join(root, 'PAUSE_INSTALL.patch'))) !== original.patch.sha256) throw Error('Historical patch mismatch');
for (const entry of original.files) {
  if (digest(fs.readFileSync(path.join(root, 'overlay', entry.path))) !== entry.sha256) throw Error('Original 14-file snapshot changed');
}
console.log(JSON.stringify({ type: 'PACKAGE_VERIFIED', commit: git('rev-parse', 'HEAD'), parent: manifest.expectedParent, manifestSha256: digest(manifestBytes), originalFiles: original.files.length, physicalLaboratoryOnly: true, realDataIncluded: false }));
