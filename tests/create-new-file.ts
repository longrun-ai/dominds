import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { DialogStore } from '../main/dialog';
import { MainDialog } from '../main/dialog';
import { setWorkLanguage } from '../main/runtime/work-language';
import { Team } from '../main/team';
import { createNewFileTool, padWriteTool, readFileTool } from '../main/tools/txt';

async function readText(p: string): Promise<string> {
  return await fs.readFile(p, 'utf-8');
}

async function main(): Promise<void> {
  const oldCwd = process.cwd();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-create-new-file-'));
  try {
    process.chdir(tmpRoot);
    setWorkLanguage('en');

    const dlg = new MainDialog(
      {} as unknown as DialogStore,
      'create-new-file.tsk',
      undefined,
      'alice',
    );
    const alice = new Team.Member({
      id: 'alice',
      name: 'Alice',
      read_dirs: ['**'],
      write_dirs: ['**'],
    });

    // Empty content is allowed; creates an empty file.
    const createdEmpty = (
      await createNewFileTool.call(dlg, alice, {
        path: 'a.txt',
        content: '',
      })
    ).content;
    assert.ok(createdEmpty.includes('status: ok'));
    assert.ok(createdEmpty.includes('mode: create_new_file'));
    assert.ok(createdEmpty.includes('new_total_lines: 0'));
    assert.ok(createdEmpty.includes('new_total_bytes: 0'));

    const readEmpty = (await readFileTool.call(dlg, alice, { path: 'a.txt' })).content;
    assert.ok(readEmpty.includes('mode: read_file'));
    assert.ok(readEmpty.includes('total_lines: 0'));

    // Existing file: refuse with FILE_EXISTS and a next-step hint.
    const exists = (
      await createNewFileTool.call(dlg, alice, {
        path: 'a.txt',
        content: '',
      })
    ).content;
    assert.ok(exists.includes('status: error'));
    assert.ok(exists.includes('error: FILE_EXISTS'));
    assert.ok(exists.includes('next:'));

    // Existing non-file path: refuse with NOT_A_FILE.
    await fs.mkdir(path.join(tmpRoot, 'dir'));
    const notAFile = (
      await createNewFileTool.call(dlg, alice, {
        path: 'dir',
        content: '',
      })
    ).content;
    assert.ok(notAFile.includes('status: error'));
    assert.ok(notAFile.includes('error: NOT_A_FILE'));

    // Trailing newline normalization for non-empty content.
    const createdWithContent = (
      await createNewFileTool.call(dlg, alice, {
        path: 'b.txt',
        content: 'hello',
      })
    ).content;
    assert.ok(createdWithContent.includes('status: ok'));
    assert.ok(createdWithContent.includes('normalized_trailing_newline_added: true'));
    const bText = await readText(path.join(tmpRoot, 'b.txt'));
    assert.equal(bText, 'hello\n');

    const padToken = 'CREATE_FROM_PAD_TOKEN';
    const padWriteOutput = (
      await padWriteTool.call(dlg, alice, {
        pad_id: 'create_src',
        content: `${padToken}\n`,
      })
    ).content;
    assert.ok(!padWriteOutput.includes(padToken), 'pad_write should not echo pad body');

    const createdFromPad = (
      await createNewFileTool.call(dlg, alice, {
        path: 'from-pad.txt',
        pad_id: 'create_src',
      })
    ).content;
    assert.ok(createdFromPad.includes('status: ok'));
    assert.ok(createdFromPad.includes('source: pad'));
    assert.ok(createdFromPad.includes('redacted: true'));
    assert.ok(!createdFromPad.includes(padToken), 'create_new_file should not echo pad body');
    assert.equal(await readText(path.join(tmpRoot, 'from-pad.txt')), `${padToken}\n`);

    console.log('✅ create-new-file tests passed');
  } finally {
    process.chdir(oldCwd);
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

void main();
