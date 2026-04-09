import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import YAML from 'yaml';

import { parseAppLockFile } from '../main/apps/app-lock-file';

type ExecResult = Readonly<{ code: number; stdout: string; stderr: string }>;

async function writeText(filePathAbs: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePathAbs), { recursive: true });
  await fs.writeFile(filePathAbs, content, 'utf-8');
}

async function runTsCli(params: {
  tsconfigAbs: string;
  scriptAbs: string;
  args: ReadonlyArray<string>;
  cwdAbs: string;
}): Promise<ExecResult> {
  return await new Promise<ExecResult>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        require.resolve('tsx/cli'),
        '--tsconfig',
        params.tsconfigAbs,
        params.scriptAbs,
        ...params.args,
      ],
      {
        cwd: params.cwdAbs,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });
    child.on('error', (err: Error) => {
      reject(err);
    });
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (signal) return resolve({ code: 1, stdout, stderr: `${stderr}\n[sig] ${signal}`.trim() });
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function main(): Promise<void> {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-app-lock-no-jitter-'));
  const appId = 'app_lock_test';
  const localAppRel = 'local-app';
  const localAppAbs = path.join(tmpRoot, localAppRel);

  const mainTsconfigAbs = path.resolve(__dirname, '..', 'main', 'tsconfig.json');
  const installCliAbs = path.resolve(__dirname, '..', 'main', 'cli', 'install.ts');
  const disableCliAbs = path.resolve(__dirname, '..', 'main', 'cli', 'disable.ts');
  const enableCliAbs = path.resolve(__dirname, '..', 'main', 'cli', 'enable.ts');
  const lockPathAbs = path.join(tmpRoot, '.minds', 'app-lock.yaml');

  try {
    await writeText(
      path.join(localAppAbs, 'package.json'),
      JSON.stringify(
        {
          name: appId,
          version: '0.0.0',
          bin: 'bin.js',
        },
        null,
        2,
      ),
    );
    await writeText(
      path.join(localAppAbs, 'bin.js'),
      [
        "'use strict';",
        "if (!process.argv.includes('--dominds-app')) {",
        "  throw new Error('expected --dominds-app');",
        '}',
        'const json = {',
        `  appId: ${JSON.stringify(appId)},`,
        '  package: {',
        `    name: ${JSON.stringify(appId)},`,
        "    version: '0.0.0',",
        '    rootAbs: process.cwd(),',
        '  },',
        "  host: { kind: 'node_module', moduleRelPath: 'index.js', exportName: 'main' },",
        "  frontend: { kind: 'http', defaultPort: 43001 },",
        '};',
        'process.stdout.write(JSON.stringify(json));',
        '',
      ].join('\n'),
    );

    const installRes = await runTsCli({
      tsconfigAbs: mainTsconfigAbs,
      scriptAbs: installCliAbs,
      args: [localAppRel, '--local', '--enable'],
      cwdAbs: tmpRoot,
    });
    assert.equal(
      installRes.code,
      0,
      `install failed\nstdout=${installRes.stdout}\nstderr=${installRes.stderr}`,
    );

    const lockText1 = await fs.readFile(lockPathAbs, 'utf-8');
    const st1 = await fs.stat(lockPathAbs);
    const lockParsed1 = parseAppLockFile(YAML.parse(lockText1) as unknown, lockPathAbs);
    assert.equal(lockParsed1.ok, true, lockParsed1.ok ? 'expected ok' : lockParsed1.errorText);
    if (!lockParsed1.ok) throw new Error(lockParsed1.errorText);
    assert.equal(lockParsed1.file.apps.length, 1);
    assert.equal(lockParsed1.file.apps[0]?.id, appId);
    assert.deepEqual(lockParsed1.file.apps[0]?.package, { name: appId, version: '0.0.0' });

    // Ensure file-system timestamp granularity does not hide accidental rewrites.
    await sleep(1200);

    const disableRes = await runTsCli({
      tsconfigAbs: mainTsconfigAbs,
      scriptAbs: disableCliAbs,
      args: [appId],
      cwdAbs: tmpRoot,
    });
    assert.equal(
      disableRes.code,
      0,
      `disable failed\nstdout=${disableRes.stdout}\nstderr=${disableRes.stderr}`,
    );

    const enableRes = await runTsCli({
      tsconfigAbs: mainTsconfigAbs,
      scriptAbs: enableCliAbs,
      args: [appId],
      cwdAbs: tmpRoot,
    });
    assert.equal(
      enableRes.code,
      0,
      `enable failed\nstdout=${enableRes.stdout}\nstderr=${enableRes.stderr}`,
    );

    const lockText2 = await fs.readFile(lockPathAbs, 'utf-8');
    const st2 = await fs.stat(lockPathAbs);
    assert.equal(lockText2, lockText1, 'enable/disable must not rewrite app-lock.yaml');
    assert.equal(st2.mtimeMs, st1.mtimeMs, 'enable/disable must not modify app-lock.yaml mtime');
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

main()
  .then(() => {
    console.log('OK');
  })
  .catch((err: unknown) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(1);
  });
