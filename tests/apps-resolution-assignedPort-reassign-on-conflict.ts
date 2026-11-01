import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

import { loadEnabledAppsSnapshot, materializeAppsResolution } from '../main/apps/enabled-apps';
import { writeAppsResolutionFile } from '../main/apps/resolution-file';
import {
  readAppResolution,
  resolvedApp,
  writeAppManifest,
  writeAppText,
  writeLocalApp,
} from './helpers/app-fixture';
import { semanticEvidenceCollector } from './helpers/semantic-evidence';
import { withTempRtws } from './kernel-driver/helpers';

const evidence = semanticEvidenceCollector('dominds-app-ports-');
async function main(): Promise<void> {
  await withTempRtws(async (rtws) => {
    const blocker = net.createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once('error', reject);
      blocker.listen(0, '127.0.0.1', resolve);
    });
    try {
      const address = blocker.address();
      assert.ok(address && typeof address === 'object');
      const conflictPort = address.port;
      const ids = ['app_port_a', 'app_port_b'];
      const packages = await Promise.all(
        ids.map((id) =>
          writeLocalApp(path.join(rtws, 'pkgs', id), id, { defaultPort: conflictPort }),
        ),
      );
      await writeAppManifest(rtws, 'rtws_root', ids);
      await writeAppText(
        path.join(rtws, '.apps', 'configuration.yaml'),
        'schemaVersion: 1\nresolutionStrategy:\n  order: [local]\n  localRoots: [pkgs]\n',
      );
      await writeAppsResolutionFile({
        rtwsRootAbs: rtws,
        file: {
          schemaVersion: 1,
          apps: packages.map((pkg) => ({
            ...resolvedApp(pkg, conflictPort),
            source: { kind: 'npx' as const, spec: `${pkg.appId}@0.0.0` },
          })),
        },
      });
      const snapshot = await loadEnabledAppsSnapshot({ rtwsRootAbs: rtws });
      assert.deepEqual(snapshot.enabledApps.map((app) => app.id).sort(), ids);
      const ports = snapshot.enabledApps.map((app) => app.runtimePort);
      assert.ok(
        ports.every((port) => typeof port === 'number' && port > 0 && port !== conflictPort),
      );
      assert.equal(new Set(ports).size, 2);
      const reassigned = snapshot.issues.filter(
        (issue) => issue.kind === 'assigned_port_reassigned',
      );
      assert.deepEqual(reassigned.map((issue) => issue.detail.appId).sort(), ids);
      const persisted = await readAppResolution(rtws);
      for (const app of snapshot.enabledApps) {
        const entry = persisted.apps.find((entry) => entry.id === app.id);
        assert.ok(entry);
        assert.equal(entry.assignedPort, app.runtimePort);
        assert.deepEqual(
          entry.installJson,
          packages.find((pkg) => pkg.appId === app.id),
        );
        const issue = reassigned.find((issue) => issue.detail.appId === app.id);
        assert.equal(issue?.detail.previousAssignedPort, conflictPort);
        assert.equal(issue?.detail.reassignedToPort, app.runtimePort);
      }
      evidence.record({
        id: 'reassigned',
        scenario:
          'Two cached local packages share one port which is also occupied by a real owned TCP listener.',
        businessValue: 'Operators can identify which package port changed and why.',
        context: {
          blockedPort: conflictPort,
          packages: ids.join(','),
          persistedPortsAgreeWithRuntime: true,
        },
        reviewQuestions: [
          'Do the complete warnings accurately identify the affected packages, old and new ports, and reason without suggesting the packages failed to resolve?',
        ],
        actualText: JSON.stringify(snapshot, null, 2),
      });
      const target = path.join(rtws, '.apps', 'resolution.yaml');
      await fs.utimes(target, new Date('2000-01-01T00:00:00Z'), new Date('2000-01-01T00:00:00Z'));
      const bytes = await fs.readFile(target);
      const mtime = (await fs.stat(target)).mtimeMs;
      const again = await materializeAppsResolution({ rtwsRootAbs: rtws });
      assert.equal(again.wroteResolutionFile, false);
      assert.deepEqual(again.resolved.issues, []);
      assert.deepEqual(again.resolved.resolutionFile, persisted);
      assert.deepEqual(await fs.readFile(target), bytes);
      assert.equal((await fs.stat(target)).mtimeMs, mtime);
      // A single cached port has no in-file duplicate: the real listener alone forces reassignment.
      await writeAppManifest(rtws, 'rtws_root', [ids[0]]);
      await writeAppsResolutionFile({
        rtwsRootAbs: rtws,
        file: { schemaVersion: 1, apps: [resolvedApp(packages[0], conflictPort)] },
      });
      const blocked = await loadEnabledAppsSnapshot({ rtwsRootAbs: rtws });
      assert.deepEqual(
        blocked.enabledApps.map((app) => app.id),
        [ids[0]],
      );
      assert.ok(
        typeof blocked.enabledApps[0].runtimePort === 'number' &&
          blocked.enabledApps[0].runtimePort > 0,
      );
      assert.notEqual(blocked.enabledApps[0].runtimePort, conflictPort);
      assert.equal(blocked.issues.length, 1);
      assert.equal(blocked.issues[0].kind, 'assigned_port_reassigned');
      assert.equal(blocked.issues[0].detail.reason, 'reassigned_from_existing_unbindable');
      assert.equal(
        (await readAppResolution(rtws)).apps[0].assignedPort,
        blocked.enabledApps[0].runtimePort,
      );
      evidence.record({
        id: 'occupied-only',
        scenario:
          'One cached frontend port is occupied by a real owned TCP listener; there is no other package to conflict with.',
        businessValue: 'The operator can distinguish an occupied port from a duplicate assignment.',
        context: { blockedPort: conflictPort, appId: ids[0], persistedPortsAgreeWithRuntime: true },
        reviewQuestions: [
          'Does the actual warning explain the port reassignment consistently with the single-package occupied-listener scenario?',
        ],
        actualText: JSON.stringify(blocked, null, 2),
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        blocker.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
  await evidence.write();
  console.log(
    'duplicate and occupied frontend ports are reassigned, persisted consistently and remain stable on reload: passed',
  );
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
