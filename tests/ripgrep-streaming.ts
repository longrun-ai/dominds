import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { Dialog } from '../main/dialog';
import { Team } from '../main/team';

const childProcess = require('node:child_process') as typeof import('node:child_process');

class FakeRipgrepProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;

  kill(): boolean {
    this.killed = true;
    return true;
  }
}

type SpawnFn = typeof childProcess.spawn;

async function importRipgrepModuleFresh(): Promise<typeof import('../main/tools/ripgrep')> {
  const modulePath = require.resolve('../main/tools/ripgrep');
  delete require.cache[modulePath];
  return await import('../main/tools/ripgrep');
}

async function main(): Promise<void> {
  const oldCwd = process.cwd();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-ripgrep-streaming-'));
  const originalSpawn = childProcess.spawn;
  const originalBufferConcat = Buffer.concat;
  const seenArgs: string[][] = [];

  try {
    process.chdir(tmpRoot);
    await fs.writeFile(path.join(tmpRoot, 'sample.txt'), 'before\nneedle line\nafter\n', 'utf8');

    childProcess.spawn = ((command, args) => {
      assert.equal(command, 'rg');
      const child = new FakeRipgrepProcess();
      seenArgs.push([...(args ?? [])]);
      setImmediate(() => {
        for (let idx = 0; idx < 500; idx += 1) {
          child.stdout.write(`sample.txt:2:1:needle hit ${idx}\n`);
        }
        child.stdout.end();
        child.stderr.end();
        child.emit('close', 0, null);
      });
      return child as unknown as ReturnType<SpawnFn>;
    }) as SpawnFn;

    const { ripgrepSnippetsTool } = await importRipgrepModuleFresh();
    (Buffer as { concat: typeof Buffer.concat }).concat = (() => {
      throw new Error('Buffer.concat should not be used by ripgrep streaming');
    }) as typeof Buffer.concat;

    const dlg = {} as Dialog;
    const alice = new Team.Member({
      id: 'alice',
      name: 'Alice',
      read_dirs: ['**'],
      write_dirs: ['**'],
    });

    const result = await ripgrepSnippetsTool.call(dlg, alice, {
      pattern: 'needle',
      path: '.',
      max_results: 5,
      context_before: 1,
      context_after: 1,
    });

    assert.ok(result.includes('status: ok'));
    assert.ok(result.includes('mode: snippets'));
    assert.ok(result.includes('matches: 500'));
    assert.ok(result.includes('shown_results: 5'));
    assert.ok(result.includes('files_matched: 1'));
    assert.ok(result.includes("summary: 'Showing first 5 of 500 matches (truncated=true).'"));
    assert.equal(seenArgs.length, 1);
    assert.ok(seenArgs[0]?.includes('--vimgrep'));
    assert.ok(seenArgs[0]?.includes('needle'));

    console.log('✅ ripgrep-streaming tests passed');
  } finally {
    (Buffer as { concat: typeof Buffer.concat }).concat = originalBufferConcat;
    childProcess.spawn = originalSpawn;
    const modulePath = require.resolve('../main/tools/ripgrep');
    delete require.cache[modulePath];
    process.chdir(oldCwd);
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

void main();
