import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { DialogStore } from '../main/dialog';
import { MainDialog } from '../main/dialog';
import { setWorkLanguage } from '../main/runtime/work-language';
import { Team } from '../main/team';
import { fileRangeEditTool, padWriteTool } from '../main/tools/txt';

async function main(): Promise<void> {
  const oldCwd = process.cwd();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-file-range-edit-'));
  process.chdir(tmpRoot);
  try {
    setWorkLanguage('en');
    const dlg = new MainDialog(
      {} as unknown as DialogStore,
      'file-range-edit.tsk',
      undefined,
      'tester',
    );
    const caller = new Team.Member({
      id: 'tester',
      name: 'Tester',
      read_dirs: ['**'],
      write_dirs: ['**'],
    });

    await fs.writeFile(path.join(tmpRoot, 'target.txt'), 'one\ntwo\nthree\n', 'utf8');

    const inlineToken = 'INLINE_RANGE_TOKEN';
    const inlineOutput = (
      await fileRangeEditTool.call(dlg, caller, {
        path: 'target.txt',
        range: '2~2',
        content: `${inlineToken}\n`,
      })
    ).content;
    assert.ok(inlineOutput.includes('mode: file_range_edit'));
    assert.ok(!inlineOutput.includes(inlineToken), 'inline file_range_edit should not echo body');
    assert.equal(
      await fs.readFile(path.join(tmpRoot, 'target.txt'), 'utf8'),
      `one\n${inlineToken}\nthree\n`,
    );

    const padToken = 'PAD_RANGE_TOKEN';
    const padWriteOutput = (
      await padWriteTool.call(dlg, caller, {
        pad_id: 'range_src',
        content: `${padToken}\n`,
      })
    ).content;
    assert.ok(!padWriteOutput.includes(padToken), 'pad_write should not echo pad body');

    const padOutput = (
      await fileRangeEditTool.call(dlg, caller, {
        path: 'target.txt',
        range: '4~',
        pad_id: 'range_src',
      })
    ).content;
    assert.ok(padOutput.includes('source: pad'));
    assert.ok(padOutput.includes('redacted: true'));
    assert.ok(!padOutput.includes(padToken), 'pad-sourced file_range_edit should not echo body');
    assert.equal(
      await fs.readFile(path.join(tmpRoot, 'target.txt'), 'utf8'),
      `one\n${inlineToken}\nthree\n${padToken}\n`,
    );

    const deleteOutput = (
      await fileRangeEditTool.call(dlg, caller, {
        path: 'target.txt',
        range: '2~2',
        content: '',
      })
    ).content;
    assert.ok(deleteOutput.includes('action: delete'));
    assert.equal(
      await fs.readFile(path.join(tmpRoot, 'target.txt'), 'utf8'),
      `one\nthree\n${padToken}\n`,
    );

    const previewToken = 'PREVIEW_RANGE_TOKEN';
    const previewOutput = (
      await fileRangeEditTool.call(dlg, caller, {
        path: 'target.txt',
        range: '2~2',
        content: `${previewToken}\n`,
        preview: true,
        show_diff: true,
      })
    ).content;
    assert.ok(previewOutput.includes('preview: true'));
    assert.ok(previewOutput.includes('```diff'));
    assert.ok(previewOutput.includes(previewToken), 'show_diff preview may explicitly echo body');
    assert.equal(
      await fs.readFile(path.join(tmpRoot, 'target.txt'), 'utf8'),
      `one\nthree\n${padToken}\n`,
      'preview must not write the file',
    );

    console.log('✓ file_range_edit tests passed');
  } finally {
    process.chdir(oldCwd);
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
