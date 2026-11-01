import assert from 'node:assert/strict';
import path from 'node:path';

import { writeAppsResolutionFile } from '../main/apps/resolution-file';
import { runDoctor } from '../main/cli/doctor';
import { resolvedApp, writeAppManifest, writeAppText, writeLocalApp } from './helpers/app-fixture';
import { readAppStateFiles } from './helpers/app-state-files';
import { runDomindsCli } from './helpers/cli-process';
import { semanticEvidenceCollector } from './helpers/semantic-evidence';
import { withTempRtws } from './kernel-driver/helpers';

const evidence = semanticEvidenceCollector('dominds-app-doctor-handshake-');
async function main(): Promise<void> {
  await withTempRtws(async (rtws) => {
    const id = '@longrun-ai/doctor-case';
    const supplied = await writeLocalApp(
      path.join(rtws, 'dominds-apps', '@longrun-ai', 'doctor-case'),
      id,
    );
    await writeAppManifest(rtws, 'rtws_root', [id]);
    await writeAppText(
      path.join(rtws, '.minds', 'app-lock.yaml'),
      JSON.stringify({ schemaVersion: 1, apps: [{ id, package: { name: id, version: '0.0.0' } }] }),
    );
    await writeAppText(
      path.join(rtws, '.apps', 'configuration.yaml'),
      'schemaVersion: 1\nresolutionStrategy:\n  order: [local]\n',
    );
    for (const [variant, moduleChanged, exportChanged] of [
      ['module', true, false],
      ['export', false, true],
      ['both', true, true],
      ['healthy', false, false],
    ] as const) {
      const entry = resolvedApp({
        ...supplied,
        host: {
          ...supplied.host,
          moduleRelPath: moduleChanged ? 'src/app-host.js' : supplied.host.moduleRelPath,
          exportName: exportChanged ? 'createDomindsAppHost' : supplied.host.exportName,
        },
      });
      await writeAppsResolutionFile({
        rtwsRootAbs: rtws,
        file: { schemaVersion: 1, apps: [entry] },
      });
      const before = await readAppStateFiles(rtws);
      const report = await runDoctor({ rtwsRootAbs: rtws, appId: id });
      assert.equal(report.diagnoses.length, 1);
      const diagnosis = report.diagnoses[0];
      assert.equal(diagnosis.appId, id);
      assert.equal(diagnosis.status, variant === 'healthy' ? 'healthy' : 'degraded');
      assert.equal(diagnosis.declared, true);
      assert.equal(diagnosis.disabled, false);
      assert.deepEqual(diagnosis.resolutionEntry, entry);
      assert.deepEqual(diagnosis.freshProbe, {
        appId: id,
        source: entry.source,
        hostModuleRelPath: supplied.host.moduleRelPath,
        hostExportName: supplied.host.exportName,
        packageName: id,
        packageVersion: '0.0.0',
      });
      assert.deepEqual(report.freshResolutionById.get(id)?.installJson, supplied);
      assert.deepEqual(report.issues, []);
      if (variant === 'healthy') assert.deepEqual(diagnosis.reasons, []);
      assert.deepEqual(await readAppStateFiles(rtws), before);
      const cli = runDomindsCli(['doctor', id], rtws);
      // doctor reports diagnosis; the current public CLI returns0 for completed degraded reports too.
      assert.equal(cli.status, 0);
      assert.deepEqual(await readAppStateFiles(rtws), before);
      evidence.record({
        id: variant,
        scenario: `Fresh local app JSON is compared against a cached entry with ${variant === 'healthy' ? 'matching host module and export' : variant + ' host mismatch'}.`,
        businessValue:
          'Diagnose stale host metadata before edits without silently rewriting state or confusing app JSON with a running host.',
        context: {
          appId: id,
          moduleMismatch: moduleChanged,
          exportMismatch: exportChanged,
          status: diagnosis.status,
          appStateFilesUnchanged: true,
          hostFactoryStarted: false,
        },
        reviewQuestions: [
          'Do actual reasons identify every changed host field and distinguish cached values from fresh package data?',
          'Are next actions usable and consistent with read-only diagnosis, without claiming a host was started or silently fixed?',
          'For the healthy control, does the actual guidance avoid inventing a mismatch?',
        ],
        actualText: JSON.stringify({ diagnosis, stdout: cli.stdout, stderr: cli.stderr }, null, 2),
      });
    }
  });
  await evidence.write();
  console.log(
    'doctor compares each fresh host field, reports degraded or healthy state and preserves every App state file: passed',
  );
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
