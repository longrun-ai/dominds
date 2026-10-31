const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function main() {
  const kernel = require('@longrun-ai/kernel');
  require('@longrun-ai/shell');
  for (const specifier of [
    '@longrun-ai/kernel',
    '@longrun-ai/shell',
    '@longrun-ai/kernel/app-json',
    '@longrun-ai/kernel/app-host-contract',
    '@longrun-ai/kernel/diligence',
    '@longrun-ai/kernel/evt',
    '@longrun-ai/kernel/team-mgmt-guide',
    '@longrun-ai/kernel/types',
    '@longrun-ai/kernel/types/storage',
    '@longrun-ai/kernel/types/wire',
    '@longrun-ai/kernel/types/dialog',
    '@longrun-ai/kernel/types/language',
    '@longrun-ai/kernel/utils/html',
    '@longrun-ai/kernel/utils/id',
    '@longrun-ai/kernel/utils/time',
  ]) {
    const resolved = fs.realpathSync(require.resolve(specifier));
    assert.ok(resolved.startsWith(path.join(__dirname, 'node_modules') + path.sep));
    require(specifier);
    await import(specifier);
  }
  const payload = 'packed-data-57e2';
  assert.deepEqual(kernel.toolSuccess(payload), { content: payload, outcome: 'success' });
  const manifest = {
    appId: '@fixture/extension',
    package: { name: '@fixture/extension', version: '1.0.0', rootAbs: '/fixture/extension' },
    host: {
      kind: 'node_module',
      moduleRelPath: 'dist/extension.js',
      exportName: 'createDomindsApp',
    },
  };
  const parsed = kernel.parseDomindsAppInstallJson(manifest);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.json, manifest);
  const { createPubChan, createSubChan } = require('@longrun-ai/kernel/evt');
  const channel = createPubChan();
  const subscriber = createSubChan(channel);
  channel.write(payload);
  assert.equal(await subscriber.read(), payload);
  const { escapeHtml } = require('@longrun-ai/kernel/utils/html');
  assert.equal(escapeHtml('<tag>'), '&lt;tag&gt;');
  assert.throws(() => require('@longrun-ai/kernel/dist/index.js'), {
    code: 'ERR_PACKAGE_PATH_NOT_EXPORTED',
  });
  assert.throws(() => require('@longrun-ai/shell/cli'), {
    code: 'ERR_PACKAGE_PATH_NOT_EXPORTED',
  });
  console.log(
    JSON.stringify({ probe: 'packed-consumer-complete', fixture: path.basename(__filename) }),
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
