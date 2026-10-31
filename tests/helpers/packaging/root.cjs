const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { X509Certificate, createPrivateKey } = require('node:crypto');
const fs = require('node:fs/promises');
const { createServer } = require('node:http');
const path = require('node:path');

async function main() {
  const root = path.dirname(require.resolve('dominds/package.json'));
  assert.equal(typeof require('dominds/cli').main, 'function');
  for (const name of [
    'dominds/cli',
    '@longrun-ai/kernel',
    '@longrun-ai/shell',
    '@longrun-ai/codex-auth',
  ]) {
    const resolved = await fs.realpath(require.resolve(name));
    assert.ok(resolved.startsWith(path.join(__dirname, 'node_modules') + path.sep));
  }
  const manifest = require('dominds/package.json');
  const cli = path.join(root, manifest.bin.dominds);
  assert.ok((await fs.stat(cli)).isFile());
  execFileSync(process.execPath, [cli, '--help'], {
    cwd: __dirname,
    env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' },
    stdio: 'pipe',
    timeout: 10000,
  });
  assert.throws(() => require('dominds'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
  assert.throws(() => require('dominds/dist/server'), {
    code: 'ERR_PACKAGE_PATH_NOT_EXPORTED',
  });
  assert.ok((await fs.stat(path.join(root, 'dist/server.js'))).isFile());

  // Exercise the packed certificate path, including its declared selfsigned dependency,
  // without relying on system OpenSSL, user home directories or console prose.
  const { createSelfSignedCertificate } = require(path.join(root, 'dist/server/certificates.js'));
  const host = '192.168.56.12';
  const created = await createSelfSignedCertificate({
    host,
    days: 1,
    certsDirAbs: path.join(__dirname, 'certificates'),
  });
  const certificate = new X509Certificate(await fs.readFile(created.certPath));
  assert.equal(certificate.checkIP(host), host);
  assert.equal(
    certificate.checkPrivateKey(createPrivateKey(await fs.readFile(created.keyPath))),
    true,
  );

  // The actual packed static handler serves real HTTP responses. This proves asset delivery,
  // not browser rendering or WebUI interaction.
  const { serveStatic } = require(path.join(root, 'dist/server/static-server.js'));
  const server = createServer((request, response) => {
    void serveStatic(request.url, response, {
      mode: 'production',
      domindsInstallRoot: root,
      staticDir: 'webapp/dist',
    }).then((served) => {
      if (!served) {
        response.writeHead(404);
        response.end();
      }
    });
  });
  server.on('error', (error) => {
    console.error(error);
    process.exitCode = 1;
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(origin);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.equal(html, await fs.readFile(path.join(root, 'webapp/dist/index.html'), 'utf8'));
    // HTML src/href values are machine asset addresses, never an oracle for prose meaning.
    const assets = [...html.matchAll(/\b(?:src|href)=["'](\/assets\/[^"']+)["']/g)].map(
      (m) => m[1],
    );
    assert.ok(assets.some((asset) => asset.endsWith('.js')));
    assert.ok(assets.some((asset) => asset.endsWith('.css')));
    for (const asset of assets) {
      const assetResponse = await fetch(new URL(asset, origin));
      assert.equal(assetResponse.status, 200, asset);
      assert.deepEqual(
        Buffer.from(await assetResponse.arrayBuffer()),
        await fs.readFile(path.join(root, 'webapp/dist', asset)),
      );
    }
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
  console.log(
    JSON.stringify({ probe: 'packed-consumer-complete', fixture: path.basename(__filename) }),
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
