#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Dialog } from '../../main/dialog';
import { Team } from '../../main/team';
import { listDirTool } from '../../main/tools/fs';

async function main(): Promise<void> {
  const caller = new Team.Member({
    id: 'ops',
    name: 'Ops',
    write_dirs: ['**/*'],
    no_write_dirs: [],
  });
  const dlg = {} as unknown as Dialog;

  const tmpDir = path.resolve(process.cwd(), 'tmp-list-dir-output-truncation');
  await fs.rm(tmpDir, { recursive: true, force: true });
  await fs.mkdir(tmpDir, { recursive: true });

  try {
    for (let i = 1; i <= 400; i++) {
      const name = `entry-${String(i).padStart(4, '0')}-${'x'.repeat(80)}.txt`;
      await fs.writeFile(path.join(tmpDir, name), `line-${i}\n`, 'utf8');
    }

    const output = await listDirTool.call(dlg, caller, {
      path: path.relative(process.cwd(), tmpDir),
    });

    assert.match(output, /showing the first 120 entries and omitting 280/);
    assert.ok(output.length <= 60_000, `Expected bounded output, got ${output.length} chars`);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
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
