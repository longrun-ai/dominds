import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { DialogStore } from '../main/dialog';
import { MainDialog } from '../main/dialog';
import { setWorkLanguage } from '../main/runtime/work-language';
import { Team } from '../main/team';
import '../main/tools/builtins';
import { getToolset } from '../main/tools/registry';
import {
  fileAppendTool,
  fileBlockReplaceTool,
  fileInsertAfterTool,
  fileInsertBeforeTool,
  padWriteTool,
} from '../main/tools/txt';

async function readText(absPath: string): Promise<string> {
  return await fs.readFile(absPath, 'utf8');
}

async function main(): Promise<void> {
  const oldCwd = process.cwd();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-file-block-tools-'));
  try {
    process.chdir(tmpRoot);
    setWorkLanguage('en');

    const dlg = new MainDialog(
      {} as unknown as DialogStore,
      'file-block-tools.tsk',
      undefined,
      'tester',
    );
    const caller = new Team.Member({
      id: 'tester',
      name: 'Tester',
      read_dirs: ['**'],
      write_dirs: ['**'],
    });

    const wsModNames = new Set((getToolset('ws_mod') ?? []).map((tool) => tool.name));
    for (const toolName of [
      'file_append',
      'file_insert_after',
      'file_insert_before',
      'file_block_replace',
    ]) {
      assert.ok(wsModNames.has(toolName), `ws_mod should expose ${toolName}`);
    }
    for (const removedName of [
      'prepare_file_append',
      'prepare_file_insert_after',
      'prepare_file_insert_before',
      'prepare_file_block_replace',
    ]) {
      assert.ok(!wsModNames.has(removedName), `ws_mod should not expose ${removedName}`);
    }

    await fs.writeFile(path.join(tmpRoot, 'target.txt'), 'alpha\nanchor\nomega\n', 'utf8');

    const appendToken = 'APPEND_DIRECT_TOKEN';
    const appendOutput = (
      await fileAppendTool.call(dlg, caller, {
        path: 'target.txt',
        content: `${appendToken}\n`,
      })
    ).content;
    assert.ok(appendOutput.includes('mode: file_append'));
    assert.ok(!appendOutput.includes(appendToken), 'file_append should not echo inline body');
    assert.equal(
      await readText(path.join(tmpRoot, 'target.txt')),
      `alpha\nanchor\nomega\n${appendToken}\n`,
    );

    const padToken = 'PAD_INSERT_TOKEN';
    const padWriteOutput = (
      await padWriteTool.call(dlg, caller, {
        pad_id: 'insert_src',
        content: `${padToken}\n`,
      })
    ).content;
    assert.ok(!padWriteOutput.includes(padToken), 'pad_write should not echo pad body');

    const insertAfterOutput = (
      await fileInsertAfterTool.call(dlg, caller, {
        path: 'target.txt',
        anchor: 'anchor',
        pad_id: 'insert_src',
      })
    ).content;
    assert.ok(insertAfterOutput.includes('mode: file_insert_after'));
    assert.ok(insertAfterOutput.includes('source: pad'));
    assert.ok(!insertAfterOutput.includes(padToken), 'pad insert should not echo pad body');
    assert.equal(
      await readText(path.join(tmpRoot, 'target.txt')),
      `alpha\nanchor\n${padToken}\nomega\n${appendToken}\n`,
    );

    const beforeToken = 'BEFORE_DIRECT_TOKEN';
    const beforePreview = (
      await fileInsertBeforeTool.call(dlg, caller, {
        path: 'target.txt',
        anchor: 'omega',
        content: `${beforeToken}\n`,
        preview: true,
        show_diff: true,
      })
    ).content;
    assert.ok(beforePreview.includes('preview: true'));
    assert.ok(beforePreview.includes(beforeToken), 'show_diff preview may explicitly echo body');
    assert.equal(
      await readText(path.join(tmpRoot, 'target.txt')),
      `alpha\nanchor\n${padToken}\nomega\n${appendToken}\n`,
      'preview must not write the file',
    );

    await fs.writeFile(
      path.join(tmpRoot, 'block.txt'),
      'top\nBEGIN\nold a\nold b\nEND\nbottom\n',
      'utf8',
    );
    const blockToken = 'BLOCK_PAD_TOKEN';
    await padWriteTool.call(dlg, caller, {
      pad_id: 'block_src',
      content: `${blockToken}\n`,
    });
    const blockOutput = (
      await fileBlockReplaceTool.call(dlg, caller, {
        path: 'block.txt',
        start_anchor: 'BEGIN',
        end_anchor: 'END',
        pad_id: 'block_src',
      })
    ).content;
    assert.ok(blockOutput.includes('mode: file_block_replace'));
    assert.ok(blockOutput.includes('source: pad'));
    assert.ok(!blockOutput.includes(blockToken), 'pad block replace should not echo pad body');
    assert.equal(
      await readText(path.join(tmpRoot, 'block.txt')),
      `top\nBEGIN\n${blockToken}\nEND\nbottom\n`,
    );

    console.log('✓ file block tools tests passed');
  } finally {
    process.chdir(oldCwd);
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
