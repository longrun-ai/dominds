#!/usr/bin/env node
// Controlled external npm/pnpm peers. The release scripts, Git, tar and filesystem stay real.
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const control = process.env.DOMINDS_PUBLISH_FIXTURE;
const config = JSON.parse(fs.readFileSync(path.join(control, 'config.json'), 'utf8'));
const stateFile = path.join(control, 'registry.json');
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const options = config.options;
const command = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const entry = {
  command,
  args,
  cwd: process.cwd(),
  managed: process.env.DOMINDS_PUBLIC_PUBLISH_FLOW === '1',
  npmInjectedConfig: process.env.npm_config_fixture_probe ?? null,
};
function record(extra = {}) {
  fs.appendFileSync(
    path.join(control, 'calls.jsonl'),
    JSON.stringify({ ...entry, ...extra }) + '\n',
  );
}
function finish(output = '', status = 0, extra = {}) {
  record(extra);
  process.stdout.write(output);
  process.exit(status);
}
function fail() {
  record({ unexpected: true });
  process.stderr.write('Unexpected fixture command\n');
  process.exit(97);
}
function packageAt(root) {
  return config.packages.find((p) => p.root === root);
}
function packedManifest(pkg) {
  const manifest = JSON.parse(fs.readFileSync(path.join(pkg.root, 'package.json'), 'utf8'));
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const [name, version] of Object.entries(manifest[field] ?? {})) {
      if (version.startsWith('workspace:'))
        manifest[field][name] = config.packages.find((p) => p.name === name).version;
    }
  }
  return manifest;
}
function pack(pkg, destination, drift = false) {
  fs.mkdirSync(destination, { recursive: true });
  const input = fs.mkdtempSync(path.join(control, 'archive-input-'));
  fs.mkdirSync(path.join(input, 'package/dist'), { recursive: true });
  fs.writeFileSync(path.join(input, 'package/package.json'), JSON.stringify(packedManifest(pkg)));
  fs.writeFileSync(
    path.join(input, 'package/dist/index.js'),
    drift ? 'registry-drift-data' : fs.readFileSync(path.join(pkg.root, 'artifact.txt')),
  );
  const archive = path.join(destination, 'fixture.tgz');
  execFileSync('tar', ['-czf', archive, '-C', input, 'package']);
  return archive;
}
if (command === 'pnpm') {
  const pkg = packageAt(process.cwd());
  if (!pkg) fail();
  if (args[0] === 'run' && args[1] === 'prepublishOnly') {
    record();
    const script = JSON.parse(fs.readFileSync(path.join(pkg.root, 'package.json'), 'utf8')).scripts
      .prepublishOnly;
    execFileSync('/bin/sh', ['-c', script], {
      cwd: pkg.root,
      env: { ...process.env, npm_config_user_agent: 'pnpm/11.17.0' },
      stdio: 'inherit',
    });
    process.exit(0);
  }
  if (args[0] === 'run' && args[1] === 'build') finish();
  if (args[0] === 'pack' && args[1] === '--pack-destination') {
    pack(pkg, args[2]);
    finish();
  }
  fail();
}
if (command !== 'npm') fail();
if (args[0] === 'whoami') {
  if (options.loggedIn === false) {
    record();
    process.stderr.write(
      'npm warn Unknown env config "fixture-config"\nnpm error code E401\nnpm error 401 Unauthorized\n',
    );
    process.exit(1);
  }
  finish('fixture-user\n');
}
if (args[0] === 'view') {
  const pkg = config.packages.find(
    (p) => args[1] === p.name || args[1] === `${p.name}@${p.version}`,
  );
  if (!pkg) fail();
  const published = state[pkg.name];
  if (args[2] === 'version' && published && options.failVerification) {
    record({ cacheStillPresent: fs.existsSync(published.prepared) });
    process.stderr.write('npm error code E503\n');
    process.exit(1);
  }
  if (args[2] === 'version')
    finish(JSON.stringify(options.behind ? null : (published?.version ?? null)), 0, {
      cacheStillPresent: published ? fs.existsSync(published.prepared) : null,
    });
  if (args[2] === 'versions')
    finish(JSON.stringify(options.behind ? ['999.0.0'] : published ? [published.version] : []));
  fail();
}
if (args[0] === 'publish') {
  const archive = args[1];
  const manifest = JSON.parse(
    execFileSync('tar', ['-xOf', archive, 'package/package.json'], { encoding: 'utf8' }),
  );
  const archiveSha256 = createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
  if (options.failPublish) {
    record({ packageName: manifest.name, archiveSha256 });
    process.stderr.write('fixture publish unavailable\n');
    process.exit(1);
  }
  if (!args.includes('--dry-run')) {
    const artifact = path.join(control, `published-${Object.keys(state).length}.tgz`);
    fs.copyFileSync(archive, artifact);
    state[manifest.name] = { version: manifest.version, artifact, prepared: archive };
    fs.writeFileSync(stateFile, JSON.stringify(state));
  }
  finish('', 0, { packageName: manifest.name, archiveSha256 });
}
if (args[0] === 'pack' && args[2] === '--pack-destination') {
  const pkg = config.packages.find((p) => args[1] === `${p.name}@${p.version}`);
  if (!pkg || !state[pkg.name]) fail();
  fs.mkdirSync(args[3], { recursive: true });
  if (options.publishedDrift) pack(pkg, args[3], true);
  else fs.copyFileSync(state[pkg.name].artifact, path.join(args[3], 'published.tgz'));
  finish();
}
fail();
