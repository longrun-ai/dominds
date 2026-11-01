import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';

import { loadEnabledAppsSnapshot } from '../main/apps/enabled-apps';
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

const evidence = semanticEvidenceCollector('dominds-app-effective-');
async function main(): Promise<void> {
  await withTempRtws(async (rtws) => {
    const ids = ['app_a', 'app_b'];
    const a = await writeLocalApp(path.join(rtws, 'dominds-apps', ids[0]), ids[0], {
      dependencies: [ids[1]],
      defaultPort: 0,
    });
    const b = await writeLocalApp(path.join(rtws, 'dominds-apps', ids[1]), ids[1], {
      defaultPort: 0,
    });
    await writeAppManifest(rtws, 'rtws_root', [ids[0]]);
    const configuration = path.join(rtws, '.apps', 'configuration.yaml');
    const healthyConfig =
      'schemaVersion: 1\nresolutionStrategy:\n  order: [local]\n  localRoots: [dominds-apps]\n';
    await writeAppText(configuration, healthyConfig);
    await writeAppsResolutionFile({
      rtwsRootAbs: rtws,
      file: { schemaVersion: 1, apps: [resolvedApp(a), resolvedApp(b)] },
    });
    const first = await loadEnabledAppsSnapshot({ rtwsRootAbs: rtws });
    assert.deepEqual(first.enabledApps.map((app) => app.id).sort(), ids);
    assert.deepEqual(first.issues, []);
    const before = await readAppResolution(rtws);
    const disabledConfig = healthyConfig + 'disabledApps: [app_b]\n';
    await writeAppText(configuration, disabledConfig);
    const disabled = await loadEnabledAppsSnapshot({ rtwsRootAbs: rtws });
    assert.deepEqual(disabled.enabledApps, []);
    const missing = disabled.issues.filter(
      (issue) => issue.kind === 'required_dependency_disabled',
    );
    assert.equal(missing.length, 1);
    assert.equal(missing[0].detail.appId, ids[1]);
    const affected = disabled.issues.filter(
      (issue) => issue.kind === 'app_effectively_disabled_due_to_required_dependency',
    );
    assert.equal(affected.length, 1);
    assert.equal(affected[0].detail.appId, ids[0]);
    assert.equal(affected[0].detail.dependencyId, ids[1]);
    assert.equal(affected[0].detail.dependencyState, 'disabled');
    assert.deepEqual(await readAppResolution(rtws), {
      ...before,
      apps: before.apps.map((app) => ({ ...app, enabled: false })),
    });
    assert.equal(await fs.readFile(configuration, 'utf8'), disabledConfig);
    evidence.record({
      id: 'required-dependency-disabled',
      scenario:
        'app_a requires app_b; disabling app_b makes both unavailable and writes both effective flags false while retaining package data and assigned ports.',
      businessValue:
        'Operators can identify the disabled dependency and why the parent cannot run.',
      context: {
        parent: ids[0],
        dependency: ids[1],
        effectiveApps: 0,
        packageDataAndPortsPreserved: true,
      },
      reviewQuestions: [
        'Do the complete diagnostics explain both the explicit dependency disable and its effect on the parent accurately?',
        'Do they avoid implying that rewriting the derived cache alone changes the declaration or configuration?',
      ],
      actualText: JSON.stringify(disabled, null, 2),
    });
    await writeAppText(configuration, healthyConfig);
    const recovered = await loadEnabledAppsSnapshot({ rtwsRootAbs: rtws });
    assert.deepEqual(recovered.enabledApps.map((app) => app.id).sort(), ids);
    assert.deepEqual(recovered.issues, []);
    assert.deepEqual(await readAppResolution(rtws), before);
    assert.equal(await fs.readFile(configuration, 'utf8'), healthyConfig);
  });
  await evidence.write();
  console.log(
    'required dependency disable and recovery persist effective flags without losing source, package data or ports: passed',
  );
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
