import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

import { loadEnabledAppsSnapshot, materializeAppsResolution } from '../main/apps/enabled-apps';
import { readAppResolution, writeAppManifest, writeLocalApp } from './helpers/app-fixture';
import { withTempRtws } from './kernel-driver/helpers';

async function main(): Promise<void> {
  await withTempRtws(async (rtws) => {
    const id = 'example_app';
    // No resolutionStrategy configuration or fixture ENV variables: use the native local default.
    await fs.rm(path.join(rtws, '.apps', 'configuration.yaml'), { force: true });
    await writeAppManifest(rtws, 'rtws_root', [id]);
    const packageRoot = path.join(rtws, 'dominds-apps', id);
    const listener = net.createServer();
    await new Promise<void>((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(0, '127.0.0.1', resolve);
    });
    const address = listener.address();
    assert.ok(address && typeof address === 'object');
    const preferredPort = address.port;
    await new Promise<void>((resolve, reject) =>
      listener.close((error) => (error ? reject(error) : resolve())),
    );
    const supplied = await writeLocalApp(packageRoot, id, { defaultPort: preferredPort });
    const snapshot = await loadEnabledAppsSnapshot({ rtwsRootAbs: rtws });
    assert.deepEqual(
      snapshot.enabledApps.map((app) => app.id),
      [id],
    );
    assert.deepEqual(snapshot.issues, []);
    const app = snapshot.enabledApps[0];
    assert.deepEqual(app.installJson, supplied);
    assert.deepEqual(app.source, { kind: 'local', pathAbs: packageRoot });
    assert.equal(app.runtimePort, preferredPort);
    const persisted = await readAppResolution(rtws);
    assert.equal(persisted.apps[0].assignedPort, app.runtimePort);
    const again = await materializeAppsResolution({ rtwsRootAbs: rtws });
    assert.deepEqual(again.resolved.resolutionFile, persisted);
    assert.equal(again.wroteResolutionFile, false);
  });
  console.log(
    'default local resolution delivers the supplied package and persists its stable port: passed',
  );
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
