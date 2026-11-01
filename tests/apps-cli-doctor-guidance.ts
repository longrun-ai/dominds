import assert from 'node:assert/strict';

import { writeAppManifest } from './helpers/app-fixture';
import { readAppStateFiles } from './helpers/app-state-files';
import { runDomindsCli } from './helpers/cli-process';
import { semanticEvidenceCollector } from './helpers/semantic-evidence';
import { withTempRtws } from './kernel-driver/helpers';

const evidence = semanticEvidenceCollector('dominds-app-cli-guidance-');
async function main(): Promise<void> {
  await withTempRtws(async (rtws) => {
    await writeAppManifest(rtws, 'rtws_root');
    const before = await readAppStateFiles(rtws);
    const help = runDomindsCli(['help'], rtws);
    assert.equal(help.status, 0);
    assert.deepEqual(await readAppStateFiles(rtws), before);
    evidence.record({
      id: 'help',
      scenario: 'A user reads main CLI help to find the compatibility-package diagnosis command.',
      businessValue:
        'Discover read-only diagnosis and its appropriate use before changing package state.',
      context: { invokedCommand: 'dominds help', exitStatus: 0, appStateFilesUnchanged: true },
      reviewQuestions: [
        'Does the actual help explain how to invoke doctor and the state layers it diagnoses?',
        'Is its example usable without implying diagnosis mutates those layers or that the old App design remains the destination?',
      ],
      actualText: help.stdout + '\nSTDERR:\n' + help.stderr,
    });
    const id = '@longrun-ai/missing-app';
    const update = runDomindsCli(['update', id], rtws);
    assert.equal(update.status, 1);
    assert.deepEqual(await readAppStateFiles(rtws), before);
    evidence.record({
      id: 'unknown-update',
      scenario: 'A user attempts update for a package not declared in the root manifest.',
      businessValue:
        'Explain the refused update and a concrete diagnosis step while preserving package state.',
      context: {
        appId: id,
        invokedCommand: `dominds update ${id}`,
        exitStatus: 1,
        appStateFilesUnchanged: true,
      },
      reviewQuestions: [
        'Does the actual error explain the undeclared target and give an applicable doctor command?',
        'Does the guidance encourage diagnosis without falsely claiming a completed update?',
      ],
      actualText: update.stdout + '\nSTDERR:\n' + update.stderr,
    });
  });
  await evidence.write();
  console.log(
    'help succeeds and undeclared update fails without changing App state; guidance is separate subjective evidence: passed',
  );
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
