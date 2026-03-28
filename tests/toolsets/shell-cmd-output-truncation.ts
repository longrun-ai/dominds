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

  const output = await shellCmdTool.call(dlg, caller, {
    command:
      'awk \'BEGIN { for (i = 1; i <= 200; i++) { printf("row-%06d ", i); for (j = 1; j <= 600; j++) printf("x"); printf("\\n"); } }\'',
    timeoutSeconds: 5,
  });

  assert.match(output, /Command completed \(exit code: 0\)/);
  assert.match(output, /row-000001/);
  assert.match(output, /row-000200/);
  assert.match(output, /tool_output_truncated_in_tool/);
  assert.doesNotMatch(output, /row-000100/);
  assert.ok(
    output.length <= 60_000,
    `Expected shell_cmd result to stay bounded, got ${output.length} chars`,
  );
}

void main()
  .then(() => {
    console.log('OK');
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exit(1);
  });
