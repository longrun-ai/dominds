import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { validateFuncToolArguments } from '../../main/llm/kernel-driver/runtime';
import { readonlyShellTool } from '../../main/tools/os';
import { semanticEvidenceCollector } from '../helpers/semantic-evidence';
import { withShellDialog } from '../helpers/shell-fixture';

async function main() {
  const evidence = semanticEvidenceCollector('dominds-shell-readonly-');
  for (const language of ['en', 'zh'] as const) {
    await withShellDialog(language, async (dialog, caller) => {
      for (const directory of ['.minds', '.dialogs', 'nested/.minds', 'nested/.dialogs'])
        await fs.mkdir(directory, { recursive: true });
      const privateData = 'private-fixture-data:937a';
      for (const directory of ['.minds', '.dialogs'])
        await fs.writeFile(directory + '/readonly-secret.txt', privateData);
      for (const directory of ['nested/.minds', 'nested/.dialogs'])
        await fs.writeFile(directory + '/nested-data.txt', 'nested-file-data:7d21');
      execFileSync('git', ['init', '--quiet', 'owned-git'], { stdio: 'pipe' });
      await fs.writeFile('owned-git/untracked-data.txt', 'given git fixture data');
      const initialGit = execFileSync('git', ['-C', 'owned-git', 'status', '--porcelain'], {
        encoding: 'utf8',
      }).trim();
      assert.equal(initialGit, '?? untracked-data.txt');
      const reader = process.platform === 'win32' ? 'type' : 'cat';
      const lister = process.platform === 'win32' ? 'dir' : 'ls';
      const refused = [
        ['reserved-dialogs', reader + ' .dialogs/readonly-secret.txt'],
        ['reserved-minds', reader + ' .minds/readonly-secret.txt'],
        ['traverse-to-reserved', 'cd nested && ' + reader + ' ../.minds/readonly-secret.txt'],
        ['git-absolute', 'git -C / status'],
        ['git-windows-rooted', 'git -C \\tmp status'],
        ['cd-parent', 'cd .. && ' + lister],
        ['prefix-denial', 'ps aux'],
        ['redirect-denial', 'echo denied-mutation-data > forbidden-write-data.txt'],
      ];
      if (process.platform === 'win32')
        refused.push(
          ['windows-dir-reserved', 'dir .dialogs'],
          ['windows-findstr-reserved', 'findstr private .minds/readonly-secret.txt'],
          ['windows-chained-type', 'echo safe-data && type .minds/readonly-secret.txt'],
        );
      else
        console.log(
          'UNEXECUTED: native Windows type/dir/findstr/chained-type; current platform ' +
            process.platform +
            '.',
        );
      for (const [id, command] of refused) {
        const result = await readonlyShellTool.call(dialog, caller, {
          command: command!,
          timeout_ms: 2_000,
        });
        assert.equal(result.outcome, 'failure', id);
        assert.ok(!result.content.includes(privateData), 'Protected fixture content must not leak');
        assert.equal(await fs.readFile('.minds/readonly-secret.txt', 'utf8'), privateData);
        assert.equal(await fs.readFile('.dialogs/readonly-secret.txt', 'utf8'), privateData);
        assert.equal(
          await fs.stat('forbidden-write-data.txt').then(
            () => true,
            (error) => {
              if (error.code === 'ENOENT') return false;
              throw error;
            },
          ),
          false,
        );
        evidence.record({
          id: id + '-' + language,
          scenario:
            'A readonly shell request is refused before exposing reserved data or performing a forbidden operation.',
          businessValue:
            'An agent understands the actual permission/command boundary and can choose an allowed next step.',
          context: {
            language,
            command: command!,
            platform: process.platform,
            outcome: result.outcome,
            observedEffects:
              'Reserved given data unchanged and absent from receipt; forbidden output file absent.',
            scope:
              'Actual validation/tool and owned filesystem; process launch is not independently instrumented.',
          },
          reviewQuestions: [
            'Does the full actual refusal accurately explain this specific restriction and offer useful guidance without suggesting it executed?',
          ],
          actualText: result.content,
        });
      }
      for (const directory of ['.minds', '.dialogs']) {
        const result = await readonlyShellTool.call(dialog, caller, {
          command: 'cd nested && ' + reader + ' ' + directory + '/nested-data.txt',
          timeout_ms: 2_000,
        });
        assert.equal(result.outcome, 'success');
        assert.ok(result.content.includes('nested-file-data:7d21'));
      }
      const alias = validateFuncToolArguments(readonlyShellTool, {
        command: 'echo alias-data-218b',
        timeout: 2_000,
      });
      assert.equal(alias.ok, true);
      if (!alias.ok) throw new Error('Alias arguments were not accepted');
      assert.equal(alias.args.timeout_ms, 2_000);
      assert.equal('timeout' in alias.args, false);
      const aliasResult = await readonlyShellTool.call(dialog, caller, alias.args);
      assert.equal(aliasResult.outcome, 'success');
      assert.ok(aliasResult.content.includes('alias-data-218b'));
      evidence.record({
        id: 'readonly-success-' + language,
        scenario: 'An allowed echo executes after the timeout alias has normalized to timeout_ms.',
        businessValue:
          'The receipt communicates actual successful execution and supplied stdout data.',
        context: {
          language,
          command: 'echo alias-data-218b',
          timeoutMs: 2_000,
          scope: 'Real local readonly process; no timeout expiration exercised.',
        },
        reviewQuestions: [
          'Does the actual receipt clearly present successful completion and the supplied data?',
        ],
        actualText: aliasResult.content,
      });
      const precedence = validateFuncToolArguments(readonlyShellTool, {
        command: 'echo precedence-data',
        timeout_ms: 1_000,
        timeout: 2_000,
      });
      assert.equal(precedence.ok, true);
      if (!precedence.ok) throw new Error('Precedence arguments were not accepted');
      assert.equal(precedence.args.timeout_ms, 1_000);
      assert.equal('timeout' in precedence.args, false);
      for (const command of [
        'git -C owned-git status --porcelain',
        'cd owned-git && git status --porcelain',
      ]) {
        const result = await readonlyShellTool.call(dialog, caller, { command, timeout_ms: 2_000 });
        assert.equal(result.outcome, 'success');
        assert.ok(result.content.includes(initialGit));
      }
      if (process.platform !== 'win32') {
        const probes = [
          ['find owned-git -maxdepth 1 -type f -print', 'owned-git/untracked-data.txt'],
          ["printf '%s' printf-data-79a1", 'printf-data-79a1'],
          ["awk 'BEGIN{print 73191}'", '73191'],
        ];
        for (const [command, stdout] of probes) {
          const result = await readonlyShellTool.call(dialog, caller, {
            command: command!,
            timeout_ms: 2_000,
          });
          assert.equal(result.outcome, 'success');
          assert.ok(result.content.includes(stdout!));
        }
        // Only the outcome is needed; ambient host/user identities are not persisted as semantic evidence.
        for (const command of ['uname -a', 'whoami', 'id'])
          assert.equal(
            (await readonlyShellTool.call(dialog, caller, { command, timeout_ms: 2_000 })).outcome,
            'success',
          );
      } else
        console.log('UNEXECUTED: native POSIX find/printf/awk/uname/whoami/id probes on Windows.');
      assert.equal(
        execFileSync('git', ['-C', 'owned-git', 'status', '--porcelain'], {
          encoding: 'utf8',
        }).trim(),
        initialGit,
      );
    });
  }
  await evidence.write();
  console.log(
    'Readonly permission boundaries, native reads and real Git outcomes: PASS for reported current-platform scope.',
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
