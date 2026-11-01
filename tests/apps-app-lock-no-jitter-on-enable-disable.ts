import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';

import { parseAppLockFile } from '../main/apps/app-lock-file';
import { loadAppsConfigurationFile } from '../main/apps/configuration-file';
import { readAppResolution, writeLocalApp } from './helpers/app-fixture';
import { runDomindsCli } from './helpers/cli-process';
import { semanticEvidenceCollector } from './helpers/semantic-evidence';
import { withTempRtws } from './kernel-driver/helpers';

const evidence = semanticEvidenceCollector('dominds-app-lock-');
async function main(): Promise<void> {
  await withTempRtws(async (rtws) => {
    const id = 'app_lock_test';
    await writeLocalApp(path.join(rtws, 'local-app'), id);
    const install = runDomindsCli(['install', 'local-app', '--local', '--enable'], rtws);
    assert.equal(install.status, 0);
    const target = path.join(rtws, '.minds', 'app-lock.yaml');
    const lockBytes = await fs.readFile(target);
    const parsed = parseAppLockFile(YAML.parse(lockBytes.toString()) as unknown, target);
    assert.ok(parsed.ok);
    assert.equal(parsed.file.apps.length, 1);
    assert.equal(parsed.file.apps[0].id, id);
    assert.deepEqual(parsed.file.apps[0].package, { name: id, version: '0.0.0' });
    const rootManifest = await fs.readFile(path.join(rtws, '.minds', 'app.yaml'));
    // An old explicit timestamp makes any rewrite observable without waiting on clock granularity.
    await fs.utimes(target, new Date('2000-01-01T00:00:00Z'), new Date('2000-01-01T00:00:00Z'));
    const oldMtime = (await fs.stat(target)).mtimeMs;
    for (const command of ['disable', 'enable'] as const) {
      const result = runDomindsCli([command, id], rtws);
      assert.equal(result.status, 0);
      const configuration = await loadAppsConfigurationFile({ rtwsRootAbs: rtws });
      assert.notEqual(configuration.kind, 'error');
      if (configuration.kind === 'error') throw new Error(configuration.errorText);
      assert.equal(configuration.file.disabledApps?.includes(id) ?? false, command === 'disable');
      const resolution = await readAppResolution(rtws);
      assert.equal(resolution.apps.find((entry) => entry.id === id)?.enabled, command === 'enable');
      assert.deepEqual(await fs.readFile(target), lockBytes);
      assert.equal((await fs.stat(target)).mtimeMs, oldMtime);
      assert.deepEqual(await fs.readFile(path.join(rtws, '.minds', 'app.yaml')), rootManifest);
      evidence.record({
        id: command,
        scenario: `A user ${command}s a locally installed compatibility package.`,
        businessValue:
          'The mutation receipt should explain the changed configuration and derived state without claiming to rewrite declaration or lock data.',
        context: {
          command,
          appId: id,
          effectiveEnabled: command === 'enable',
          lockUnchanged: true,
          manifestUnchanged: true,
        },
        reviewQuestions: [
          'Does the complete receipt agree with the actual change and unchanged declaration/lock state?',
          'Is its next-step guidance usable without presenting the retired App composition root as the destination architecture?',
        ],
        actualText: JSON.stringify(result, null, 2),
      });
    }
    evidence.record({
      id: 'install',
      scenario: 'A user installs an owned local compatibility package with --enable.',
      businessValue:
        'Explain the actual local install outcome and current configuration boundaries.',
      context: {
        appId: id,
        source: 'owned local package, no registry request',
        installStatus: install.status,
      },
      reviewQuestions: [
        'Does the actual receipt describe the completed local installation and its configuration boundaries accurately?',
      ],
      actualText: JSON.stringify(install, null, 2),
    });
  });
  await evidence.write();
  console.log(
    'real disable/enable update effective state while preserving declaration and lock bytes/timestamp after each command: passed',
  );
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
