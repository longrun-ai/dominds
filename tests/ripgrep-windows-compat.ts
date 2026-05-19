import assert from 'node:assert/strict';
import type { SpawnOptions } from 'node:child_process';
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
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-ripgrep-win-compat-'));
  const originalSpawn = childProcess.spawn;
  const seenArgs: string[][] = [];
  let callIndex = 0;

  try {
    process.chdir(tmpRoot);
    await fs.mkdir('src', { recursive: true });
    await fs.writeFile(path.join('src', 'alpha.ts'), 'needle\n', 'utf8');
    await fs.writeFile(path.join('src', 'beta.tsx'), 'needle\n', 'utf8');

    childProcess.spawn = ((command, args?: readonly string[] | SpawnOptions) => {
      assert.equal(command, 'rg');
      const child = new FakeRipgrepProcess();
      const spawnArgs: readonly string[] = Array.isArray(args) ? args : [];
      seenArgs.push([...spawnArgs]);

      const current = callIndex;
      callIndex += 1;
      setImmediate(() => {
        if (current === 0) {
          child.stdout.write('src/alpha.ts\n');
          child.stdout.end();
          child.stderr.end();
          child.emit('close', 0, null);
          return;
        }

        if (current === 1) {
          child.stdout.write('src/alpha.ts:1:1:needle\n');
          child.stdout.write('src/beta.tsx:1:1:needle\n');
          child.stdout.end();
          child.stderr.end();
          child.emit('close', 0, null);
          return;
        }

        if (current === 2) {
          child.stdout.end();
          child.stderr.end();
          child.emit('close', 1, null);
          return;
        }

        child.stderr.write(
          'refs/desktop: The system cannot find the path specified. (os error 3)\n',
        );
        child.stdout.end();
        child.stderr.end();
        child.emit('close', 2, null);
      });
      return child as unknown as ReturnType<SpawnFn>;
    }) as SpawnFn;

    const { ripgrepFilesTool, ripgrepSearchTool } = await importRipgrepModuleFresh();
    const dlg = {} as Dialog;
    const alice = new Team.Member({
      id: 'alice',
      name: 'Alice',
      read_dirs: ['**'],
      write_dirs: ['**'],
    });

    const first = (
      await ripgrepFilesTool.call(dlg, alice, {
        pattern: 'needle',
        path: '.\\src',
        include: '*.ts',
      })
    ).content;
    assert.ok(first.includes('status: ok'));
    assert.ok(first.includes('files_matched: 1'));
    assert.ok(first.includes("path: 'src/alpha.ts'"));
    assert.ok(!first.includes('beta.tsx'));
    assert.equal(seenArgs.length, 1);
    if (process.platform === 'win32') {
      assert.ok(seenArgs[0]?.includes('--type'));
      assert.ok(seenArgs[0]?.includes('ts'));
      assert.ok(!seenArgs[0]?.includes('*.ts'));
    } else {
      assert.ok(seenArgs[0]?.includes('--glob'));
      assert.ok(seenArgs[0]?.includes('*.ts'));
    }
    assert.ok(seenArgs[0]?.includes('./src'));

    const second = (
      await ripgrepSearchTool.call(dlg, alice, {
        pattern: 'needle',
        path: '.\\src',
        rg_args: ['-g', '*.ts', '-g', 'src/*'],
      })
    ).content;
    assert.ok(second.includes('status: ok'));
    assert.ok(second.includes('matches: 2'));
    assert.ok(seenArgs[1]?.includes('*.ts'));
    assert.ok(seenArgs[1]?.includes('src/*'));
    assert.ok(!seenArgs[1]?.includes('--type'));

    const third = (
      await ripgrepFilesTool.call(dlg, alice, {
        pattern: 'needle',
        path: 'literal\\slash',
      })
    ).content;
    assert.ok(third.includes('status: ok'));
    assert.equal(seenArgs.length, 3);
    assert.ok(
      seenArgs[2]?.includes(process.platform === 'win32' ? 'literal/slash' : 'literal\\slash'),
    );

    const fourth = (
      await ripgrepFilesTool.call(dlg, alice, {
        pattern: 'needle',
        path: '.\\src',
      })
    ).content;
    assert.ok(fourth.includes('status: partial_failure'));
    assert.ok(fourth.includes('no matches were returned'));
    assert.ok(fourth.includes('exit code 2'));
    assert.equal(seenArgs.length, 4);
    assert.ok(seenArgs[3]?.includes('./src'));

    console.log('✅ ripgrep-windows-compat tests passed');
  } finally {
    childProcess.spawn = originalSpawn;
    const modulePath = require.resolve('../main/tools/ripgrep');
    delete require.cache[modulePath];
    process.chdir(oldCwd);
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

void main();
