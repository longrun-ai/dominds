import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { inventory, runCases } from './run.mjs';

test('a failure and a timeout retain evidence and do not prevent later cases from running', async () => {
  const logDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-runner-regression-'));
  try {
    const summary = await runCases(
      [
        { id: 'fails', args: ['-e', 'console.error("failure evidence"); process.exit(7)'] },
        { id: 'hangs', args: ['-e', 'setInterval(() => {}, 1000)'] },
        { id: 'continues', args: ['-e', 'console.log("later case executed")'] },
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
    assert.match(await fs.readFile(summary.results[0].logPath, 'utf8'), /failure evidence/);
    await fs.access(summary.results[1].tempDir);
    assert.match(await fs.readFile(summary.results[2].logPath, 'utf8'), /later case executed/);
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
