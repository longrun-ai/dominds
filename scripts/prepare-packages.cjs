const fs = require('node:fs');
const path = require('node:path');

const repoRoot = __dirname ? path.resolve(__dirname, '..') : process.cwd();
const packagesRoot = path.join(repoRoot, 'packages');

function ensureDir(dirAbs) {
  fs.mkdirSync(dirAbs, { recursive: true });
}

function writeTextFile(fileAbs, content) {
  ensureDir(path.dirname(fileAbs));
  fs.writeFileSync(fileAbs, content, 'utf8');
}

function requirePathExists(targetAbs, label) {
  if (!fs.existsSync(targetAbs)) {
    throw new Error(`prepare-packages expected ${label} at ${targetAbs}`);
  }
}

function prepareKernelPackage() {
  const packageRoot = path.join(packagesRoot, 'kernel');
  const outRoot = path.join(packageRoot, 'dist');
  requirePathExists(path.join(outRoot, 'index.js'), 'kernel entry');
  requirePathExists(path.join(outRoot, 'app-json.js'), 'kernel app-json entry');
  requirePathExists(path.join(outRoot, 'app-host-contract.js'), 'kernel app-host contract entry');
  requirePathExists(path.join(outRoot, 'types.js'), 'kernel root types entry');
  requirePathExists(path.join(outRoot, 'types', 'wire.js'), 'kernel wire contract entry');
  requirePathExists(path.join(outRoot, 'types', 'dialog.js'), 'kernel dialog contract entry');
  requirePathExists(path.join(outRoot, 'types', 'storage.js'), 'kernel storage contract entry');
  requirePathExists(path.join(outRoot, 'utils', 'time.js'), 'kernel time util entry');
  requirePathExists(path.join(outRoot, 'evt.js'), 'kernel evt entry');
  requirePathExists(path.join(outRoot, 'diligence.js'), 'kernel diligence entry');
  requirePathExists(path.join(outRoot, 'team-mgmt-manual.js'), 'kernel team manual entry');

  writeTextFile(
    path.join(outRoot, 'package.json'),
    JSON.stringify({ type: 'commonjs' }, null, 2) + '\n',
  );
}

function prepareShellPackage() {
  const packageRoot = path.join(packagesRoot, 'shell');
  const outRoot = path.join(packageRoot, 'dist');

  requirePathExists(path.join(outRoot, 'index.js'), 'shell package entry');
  writeTextFile(
    path.join(outRoot, 'package.json'),
    JSON.stringify({ type: 'commonjs' }, null, 2) + '\n',
  );
}

prepareKernelPackage();
prepareShellPackage();
