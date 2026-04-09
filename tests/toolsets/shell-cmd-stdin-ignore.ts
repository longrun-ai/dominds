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

  const output = (
    await shellCmdTool.call(dlg, caller, {
      command:
        "node -e \"let data = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (chunk) => { data += chunk; }); process.stdin.on('end', () => { console.log('stdin-ended'); console.log(data === '' ? 'stdin-empty' : data); }); process.stdin.resume();\"",
      timeoutSeconds: 5,
    })
  ).content;

  assert.match(output, /Command completed \(exit code: 0\)/);
  assert.match(output, /stdin-ended/);
  assert.match(output, /stdin-empty/);
  assert.doesNotMatch(output, /Command started as daemon process/);
}

void main()
  .then(() => {
    console.log('OK');
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exit(1);
  });
