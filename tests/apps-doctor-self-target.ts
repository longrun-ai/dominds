import assert from 'node:assert/strict';

import { runDoctor } from '../main/cli/doctor';
import { writeAppManifest } from './helpers/app-fixture';
import { readAppStateFiles } from './helpers/app-state-files';
import { runDomindsCli } from './helpers/cli-process';
import { semanticEvidenceCollector } from './helpers/semantic-evidence';
import { withTempRtws } from './kernel-driver/helpers';

const evidence = semanticEvidenceCollector('dominds-app-doctor-self-');
async function main(): Promise<void> {
  await withTempRtws(async (rtws) => {
    await writeAppManifest(rtws, 'chatgpt-workstation');
    const before = await readAppStateFiles(rtws);
    const report = await runDoctor({ rtwsRootAbs: rtws, appId: '.' });
    assert.equal(report.diagnoses.length, 1);
    const diagnosis = report.diagnoses[0];
    assert.equal(diagnosis.appId, '.');
    assert.equal(diagnosis.declared, true);
    assert.equal(diagnosis.status, 'healthy');
    assert.deepEqual(diagnosis.reasons, []);
    assert.deepEqual(report.issues, []);
    assert.equal(diagnosis.resolutionEntry, null);
    assert.equal(diagnosis.freshProbe, null);
    assert.deepEqual(await readAppStateFiles(rtws), before);
    const cli = runDomindsCli(['doctor', '.'], rtws);
    assert.equal(cli.status, 0);
    assert.deepEqual(await readAppStateFiles(rtws), before);
    evidence.record({
      id: 'self-no-dependencies',
      scenario:
        'The root workspace manifest exists and intentionally declares no package dependencies; the user runs doctor .',
      businessValue:
        'A dependency-free root is a valid healthy workspace and diagnosis must remain read-only.',
      context: {
        rootManifestId: 'chatgpt-workstation',
        target: '.',
        declared: true,
        status: diagnosis.status,
        packageSnapshotAbsent: true,
        appStateFilesUnchanged: true,
      },
      reviewQuestions: [
        'Do the actual CLI output and API next actions correctly distinguish a healthy root manifest from missing dependency package data?',
        'Could the user understand that the unresolved package-handshake fields do not require installing the root as its own dependency?',
      ],
      actualText: JSON.stringify({ diagnosis, stdout: cli.stdout, stderr: cli.stderr }, null, 2),
    });
  });
  await evidence.write();
  console.log(
    'doctor self-target accepts an intentional dependency-free root and preserves all App state files: passed',
  );
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
