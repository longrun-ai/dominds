import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { DialogStore } from '../main/dialog';
import { MainDialog } from '../main/dialog';
import { setWorkLanguage } from '../main/runtime/work-language';
import { Team } from '../main/team';
import { overwriteEntireFileTool, padWriteTool } from '../main/tools/txt';

async function main(): Promise<void> {
  const oldCwd = process.cwd();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-overwrite-entire-file-'));
  try {
    process.chdir(tmpRoot);
    setWorkLanguage('en');

    const dlg = new MainDialog(
      {} as unknown as DialogStore,
      'overwrite-entire-file.tsk',
      undefined,
      'alice',
    );
    const alice = new Team.Member({
      id: 'alice',
      name: 'Alice',
      read_dirs: ['**'],
      write_dirs: ['**'],
    });

    const filePath = path.join(tmpRoot, 'sample.yaml');
    const oldContent = ['members:', '  alice:', '    name: Alice', ''].join('\n');
    await fs.writeFile(filePath, oldContent, 'utf-8');
    const oldStat = await fs.stat(filePath);

    const nextContent = ['members:', '  bob:', '    name: Bob', ''].join('\n');
    const overwriteYamlResult = (
      await overwriteEntireFileTool.call(dlg, alice, {
        path: 'sample.yaml',
        known_old_total_lines: 3,
        known_old_total_bytes: oldStat.size,
        content_format: 'yaml',
        content: nextContent,
      })
    ).content;
    assert.ok(overwriteYamlResult.includes('status: ok'));
    assert.ok(overwriteYamlResult.includes("content_format: 'yaml'"));
    assert.equal(await fs.readFile(filePath, 'utf-8'), nextContent);

    const diffLiteralResult = (
      await overwriteEntireFileTool.call(dlg, alice, {
        path: 'sample.yaml',
        known_old_total_lines: 3,
        known_old_total_bytes: Buffer.byteLength(nextContent, 'utf8'),
        content_format: 'yaml',
        content: ['diff --git a/a.txt b/a.txt', '--- a/a.txt', '+++ b/a.txt', ''].join('\n'),
      })
    ).content;
    assert.ok(diffLiteralResult.includes('status: error'));
    assert.ok(diffLiteralResult.includes('error: SUSPICIOUS_DIFF'));

    const padToken = 'OVERWRITE_FROM_PAD_TOKEN';
    const padWriteOutput = (
      await padWriteTool.call(dlg, alice, {
        pad_id: 'overwrite_src',
        content: `${padToken}\n`,
      })
    ).content;
    assert.ok(!padWriteOutput.includes(padToken), 'pad_write should not echo pad body');

    const statsBeforePadOverwrite = await fs.stat(filePath);
    const padOverwriteResult = (
      await overwriteEntireFileTool.call(dlg, alice, {
        path: 'sample.yaml',
        known_old_total_lines: 3,
        known_old_total_bytes: statsBeforePadOverwrite.size,
        content_format: 'text',
        pad_id: 'overwrite_src',
      })
    ).content;
    assert.ok(padOverwriteResult.includes('status: ok'));
    assert.ok(padOverwriteResult.includes('source: pad'));
    assert.ok(padOverwriteResult.includes('redacted: true'));
    assert.ok(
      !padOverwriteResult.includes(padToken),
      'overwrite_entire_file should not echo pad body',
    );
    assert.equal(await fs.readFile(filePath, 'utf-8'), `${padToken}\n`);

    console.log('✅ overwrite-entire-file tests passed');
  } finally {
    process.chdir(oldCwd);
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

void main();
