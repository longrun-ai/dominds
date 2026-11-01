import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';

import {
  removeResolvedApp,
  setResolvedAppAssignedPort,
  setResolvedAppEnabled,
  writeAppsResolutionFile,
  writeAppsResolutionFileIfChanged,
} from '../main/apps/resolution-file';
import { readAppResolution, resolvedApp, writeLocalApp } from './helpers/app-fixture';
import { withTempRtws } from './kernel-driver/helpers';

async function main(): Promise<void> {
  await withTempRtws(async (rtws) => {
    const one = resolvedApp(
      await writeLocalApp(path.join(rtws, 'packages', 'one'), 'one', { defaultPort: 43001 }),
      43001,
    );
    const other = resolvedApp(await writeLocalApp(path.join(rtws, 'packages', 'other'), 'other'));
    const file = { schemaVersion: 1 as const, apps: [one, other] };
    const original = structuredClone(file);
    await writeAppsResolutionFile({ rtwsRootAbs: rtws, file });
    const target = path.join(rtws, '.apps', 'resolution.yaml');
    await fs.utimes(target, new Date('2000-01-01T00:00:00Z'), new Date('2000-01-01T00:00:00Z'));
    const bytes = await fs.readFile(target);
    const before = await fs.stat(target);
    for (const next of [
      setResolvedAppEnabled({ existing: file, appId: 'missing', enabled: false }),
      setResolvedAppEnabled({ existing: file, appId: 'one', enabled: true }),
      setResolvedAppAssignedPort({ existing: file, appId: 'missing', assignedPort: 50000 }),
      setResolvedAppAssignedPort({ existing: file, appId: 'one', assignedPort: 43001 }),
      removeResolvedApp({ existing: file, appId: 'missing' }),
    ]) {
      assert.deepEqual(next, original);
      await writeAppsResolutionFileIfChanged({ rtwsRootAbs: rtws, file: next });
      assert.deepEqual(await fs.readFile(target), bytes);
      assert.equal((await fs.stat(target)).mtimeMs, before.mtimeMs);
    }
    const changed = setResolvedAppAssignedPort({
      existing: file,
      appId: 'one',
      assignedPort: 43002,
    });
    await writeAppsResolutionFileIfChanged({ rtwsRootAbs: rtws, file: changed });
    const persisted = await readAppResolution(rtws);
    assert.deepEqual(
      persisted.apps.find((entry) => entry.id === 'one'),
      { ...one, assignedPort: 43002 },
    );
    assert.deepEqual(
      persisted.apps.find((entry) => entry.id === 'other'),
      other,
    );
    assert.notDeepEqual(await fs.readFile(target), bytes);
    assert.notEqual((await fs.stat(target)).mtimeMs, before.mtimeMs);
    const disabled = setResolvedAppEnabled({ existing: changed, appId: 'one', enabled: false });
    await writeAppsResolutionFileIfChanged({ rtwsRootAbs: rtws, file: disabled });
    assert.deepEqual(
      (await readAppResolution(rtws)).apps.find((entry) => entry.id === 'one'),
      { ...one, assignedPort: 43002, enabled: false },
    );
    const removed = removeResolvedApp({ existing: disabled, appId: 'one' });
    await writeAppsResolutionFileIfChanged({ rtwsRootAbs: rtws, file: removed });
    assert.deepEqual((await readAppResolution(rtws)).apps, [other]);
    assert.deepEqual(file, original);
  });
  console.log(
    'no-op mutations preserve disk bytes and timestamp; actual changes persist without losing other packages: passed',
  );
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
