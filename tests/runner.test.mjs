import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { inventory, runCases } from './run.mjs';

test('a failure and a timeout retain evidence and do not prevent later cases from running', async () => {
  const logDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-runner-regression-'));
  try {
    const summary = await runCases(
      [
        { id: 'fails', args: ['-e', 'console.error("failure-data-48ae"); process.exit(7)'] },
        { id: 'hangs', args: ['-e', 'setInterval(() => {}, 1000)'] },
        { id: 'continues', args: ['-e', 'console.log("continued-data-59bf")'] },
      ],
      { logDir, timeoutMs: 1000, report: () => {} },
    );
    assert.deepEqual(
      summary.results.map(({ status }) => status),
      ['failed', 'timeout', 'passed'],
    );
    assert.equal(summary.passed, 1);
    assert.equal(summary.failed, 1);
    assert.equal(summary.timedOut, 1);
    assert.equal(summary.results[0].code, 7);
    assert.equal(await fs.readFile(summary.results[0].logPath, 'utf8'), 'failure-data-48ae\n');
    await fs.access(summary.results[1].tempDir);
    assert.equal(await fs.readFile(summary.results[2].logPath, 'utf8'), 'continued-data-59bf\n');
    assert.deepEqual(
      JSON.parse(await fs.readFile(path.join(logDir, 'summary.json'), 'utf8')),
      summary,
    );
    const remaining = await fs.readdir(logDir);
    assert.equal(remaining.includes('3.tmp'), false, 'successful cases clean temporary state');
  } finally {
    await fs.rm(logDir, { recursive: true, force: true });
  }
});

test('kernel discovery includes regressions omitted from the old hand-maintained integration script', async () => {
  const catalog = await inventory();
  assert.ok(
    catalog.suites.kernel.includes(
      'kernel-driver/root-cross-trigger-does-not-reenter-during-tail.ts',
    ),
  );
  assert.ok(
    catalog.suites.kernel.includes(
      'kernel-driver/sideDialog-backend-loop-retries-after-active-run-blocker.ts',
    ),
  );
  assert.equal(catalog.suites.kernel.includes('kernel-driver/helpers.ts'), false);
  assert.ok(catalog.outsideSuites.includes('provider/volcengine-coding-plan-live-smoke.ts'));
});

test('a descriptive case id does not overflow the tsx Unix socket path', async () => {
  const logDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-runner-path-'));
  try {
    const fixture = path.join(logDir, 'case.ts');
    await fs.writeFile(fixture, 'process.exit(0);\n');
    const summary = await runCases(
      [
        {
          id: 'kernel-driver/a-descriptive-case-name-with-a-long-business-scenario.ts',
          args: [createRequire(import.meta.url).resolve('tsx/cli'), fixture],
        },
      ],
      { logDir, report: () => {} },
    );
    assert.equal(summary.passed, 1);
    assert.equal(summary.failed, 0);
  } finally {
    await fs.rm(logDir, { recursive: true, force: true });
  }
});

test('evidence generation retains successful process material for subjective review', async () => {
  const logDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-runner-evidence-'));
  try {
    const summary = await runCases(
      [
        {
          id: 'generate-evidence',
          args: [
            '-e',
            'require("node:fs").writeFileSync(require("node:path").join(require("node:os").tmpdir(), "review.json"), JSON.stringify({status:"pending"}))',
          ],
        },
      ],
      { logDir, keepSuccessfulState: true, report: () => {} },
    );
    assert.equal(summary.passed, 1, 'the process completed; this is not a semantic verdict');
    assert.deepEqual(
      JSON.parse(await fs.readFile(path.join(summary.results[0].tempDir, 'review.json'), 'utf8')),
      { status: 'pending' },
    );
  } finally {
    await fs.rm(logDir, { recursive: true, force: true });
  }
});

test('isolated CLI preserves a failed workspace and cleans a successful workspace by default', async () => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-cli-artifacts-'));
  try {
    const fixture = path.join(sandbox, 'exit-code.ts');
    await fs.writeFile(
      fixture,
      [
        'import fs from "node:fs";',
        'console.log(JSON.stringify({runRtws: process.cwd()}));',
        'fs.writeFileSync("failure-proof.json", JSON.stringify({payload:"artifact-data-638a"}));',
        'process.exitCode = Number(process.argv[2]);',
      ].join('\n'),
    );
    const invoke = (exitCode) =>
      new Promise((resolve) => {
        execFile(
          process.execPath,
          [
            createRequire(import.meta.url).resolve('tsx/cli'),
            path.join(import.meta.dirname, 'cli.ts'),
            '--',
            fixture,
            String(exitCode),
          ],
          {
            env: {
              ...process.env,
              TMPDIR: sandbox,
              TEMP: sandbox,
              TMP: sandbox,
              DOMINDS_TEST_RTWS_KEEP_TMP: '0',
              DOMINDS_TEST_RTWS_MODE: 'isolated',
            },
            timeout: 10_000,
          },
          (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }),
        );
      });
    const failed = await invoke(7);
    assert.equal(failed.code, 7);
    const failedLine = failed.stdout
      .trim()
      .split('\n')
      .find((line) => line.startsWith('{"runRtws":'));
    assert.ok(failedLine);
    const failedRtws = JSON.parse(failedLine).runRtws;
    assert.ok(
      path.relative(sandbox, failedRtws) && !path.relative(sandbox, failedRtws).startsWith('..'),
    );
    assert.deepEqual(
      JSON.parse(await fs.readFile(path.join(failedRtws, 'failure-proof.json'), 'utf8')),
      { payload: 'artifact-data-638a' },
    );
    const succeeded = await invoke(0);
    assert.equal(succeeded.code, 0);
    const succeededLine = succeeded.stdout
      .trim()
      .split('\n')
      .find((line) => line.startsWith('{"runRtws":'));
    assert.ok(succeededLine);
    const successfulRtws = JSON.parse(succeededLine).runRtws;
    await assert.rejects(fs.access(successfulRtws), { code: 'ENOENT' });
  } finally {
    await fs.rm(sandbox, { recursive: true, force: true });
  }
});

test('inventory recognizes rtws flags and reports their missing script targets', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-inventory-flags-'));
  try {
    await fs.copyFile(path.join(import.meta.dirname, 'run.mjs'), path.join(directory, 'run.mjs'));
    const scripts = {
      plain: 'tsx plain.ts',
      isolated: 'pnpm run rtws -- --isolated-rtws isolated.ts',
      shared: 'pnpm run rtws -- --shared-rtws shared.ts',
      missingIsolated: 'pnpm run rtws -- --isolated-rtws missing-isolated.ts',
      missingShared: 'pnpm run rtws -- --shared-rtws missing-shared.ts',
    };
    await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ scripts }));
    await fs.writeFile(path.join(directory, 'audit.json'), JSON.stringify({ cases: {} }));
    for (const file of ['plain.ts', 'isolated.ts', 'shared.ts'])
      await fs.writeFile(path.join(directory, file), '');
    const copied = await import(pathToFileURL(path.join(directory, 'run.mjs')).href);
    const catalog = await copied.inventory();
    assert.deepEqual(catalog.withoutPackageScript, []);
    assert.deepEqual(catalog.missingPackageScriptTargets, [
      { script: 'missingIsolated', target: 'missing-isolated.ts' },
      { script: 'missingShared', target: 'missing-shared.ts' },
    ]);
  } catch (error) {
    console.error(`Inventory fixture retained: ${directory}`);
    throw error;
  }
  await fs.rm(directory, { recursive: true, force: true });
});
