import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Team } from '../../main/team';
import { addPersonalMemoryTool, addSharedMemoryTool } from '../../main/tools/mem';
import { withManualReminderDialog } from '../helpers/manual-reminders';
import { semanticEvidenceCollector } from '../helpers/semantic-evidence';

async function main() {
  const evidence = semanticEvidenceCollector('dominds-memory-paths-');
  for (const language of ['en', 'zh'] as const) {
    await withManualReminderDialog(language, async (dialog) => {
      const caller = new Team.Member({
        id: 'pm-' + language,
        name: 'Product Manager',
        write_dirs: ['project-docs/**'],
        no_write_dirs: ['.minds/**'],
      });
      const personal = '# Given personal note data:19f2\n';
      const shared = 'given team note data:38a1';
      const personalPath = '.minds/memory/individual/' + caller.id + '/onboarding.md';
      const sharedPath = '.minds/memory/team_shared/decisions-' + language + '.md';
      const added = await addPersonalMemoryTool.call(dialog, caller, {
        path: 'onboarding.md',
        content: personal,
      });
      assert.equal(added.outcome, 'success');
      assert.equal(await fs.readFile(personalPath, 'utf8'), personal);
      const teamAdded = await addSharedMemoryTool.call(dialog, caller, {
        path: 'decisions-' + language + '.md',
        content: shared,
      });
      assert.equal(teamAdded.outcome, 'success');
      assert.equal(await fs.readFile(sharedPath, 'utf8'), shared);
      // An absolute target is owned test data, never a host system file.
      const absoluteTarget = path.resolve('absolute-memory-control-' + language + '.txt');
      const untouched = 'absolute-target-data:83ca';
      await fs.writeFile(absoluteTarget, untouched);
      const refused = await addPersonalMemoryTool.call(dialog, caller, {
        path: absoluteTarget,
        content: 'forbidden replacement data',
      });
      assert.equal(refused.outcome, 'failure');
      assert.equal(await fs.readFile(absoluteTarget, 'utf8'), untouched);
      assert.equal(await fs.readFile(personalPath, 'utf8'), personal);
      assert.equal(await fs.readFile(sharedPath, 'utf8'), shared);
      assert.deepEqual(await fs.readdir('.minds/memory/individual/' + caller.id), [
        'onboarding.md',
      ]);
      evidence.record({
        id: 'memory-absolute-path-' + language,
        scenario:
          'Dedicated personal/team memory tools write supplied data despite general .minds write restrictions, but an absolute memory path is refused.',
        businessValue:
          'An agent can use the dedicated memory namespace and repair an invalid path without overwriting an unrelated target.',
        context: {
          language,
          agentId: caller.id,
          submittedAbsolutePath: absoluteTarget,
          personalRelativePath: 'onboarding.md',
          observedEffects:
            'Absolute target and both previously written memory files unchanged; no extra personal file.',
          scope:
            'Native dialog/member and actual isolated files; dedicated memory path contract, not arbitrary file-write permission or model memory retrieval.',
        },
        reviewQuestions: [
          'Does the actual refusal accurately explain the relative memory-path requirement and avoid implying a write succeeded?',
        ],
        actualText: refused.content,
      });
    });
  }
  await evidence.write();
  console.log('Dedicated memory writes, exact supplied data and absolute-path preservation: PASS');
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
