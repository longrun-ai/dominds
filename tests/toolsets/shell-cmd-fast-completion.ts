#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import type { Dialog } from '../../main/dialog';
import { setWorkLanguage } from '../../main/runtime/work-language';
import { Team } from '../../main/team';
import { shellCmdTool } from '../../main/tools/os';

async function main(): Promise<void> {
  setWorkLanguage('en');

  const caller = new Team.Member({
    id: 'ops',
    name: 'Ops',
    write_dirs: ['**/*'],
    no_write_dirs: [],
  });

  const dlg = {} as unknown as Dialog;

  const cases = [
    {
      command: 'echo "parallel test from mentor"',
      expected: /parallel test from mentor/,
      timeoutSeconds: 5,
    },
    {
      command: 'node -e "setTimeout(() => console.log(\'near-timeout done\'), 250)"',
      expected: /near-timeout done/,
      timeoutSeconds: 1,
    },
  ] as const;

  for (const testCase of cases) {
    for (let i = 0; i < 5; i += 1) {
      const output = await shellCmdTool.call(dlg, caller, {
        command: testCase.command,
        timeoutSeconds: testCase.timeoutSeconds,
      });
      assert.equal(output.outcome, 'success');
      assert.match(output.content, /Command completed \(exit code:\s*0\)/);
      assert.match(output.content, testCase.expected);
      assert.doesNotMatch(output.content, /failed to capture daemon command line/);
      assert.doesNotMatch(output.content, /Failed to execute command/);
    }
  }
}

void main()
  .then(() => {
    console.log('OK');
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exit(1);
  });
