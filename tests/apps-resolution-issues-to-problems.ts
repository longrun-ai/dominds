import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { loadEnabledAppsSnapshot } from 'dominds/apps/enabled-apps';
import { reconcileAppsResolutionIssuesToProblems } from 'dominds/apps/problems';

import {
  clearResolvedProblems,
  getProblemsSnapshot,
  removeProblemsByPrefix,
} from '../main/problems';

async function writeText(filePathAbs: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePathAbs), { recursive: true });
  await fs.writeFile(filePathAbs, content, 'utf-8');
}

async function writeLocalPackage(params: { packageRootAbs: string; appId: string }): Promise<void> {
  await writeText(
    path.join(params.packageRootAbs, 'package.json'),
    JSON.stringify(
      {
        name: params.appId,
        version: '0.0.0',
        bin: 'bin.js',
      },
      null,
      2,
    ),
  );
  await writeText(
    path.join(params.packageRootAbs, 'bin.js'),
    [
      "'use strict';",
      "if (!process.argv.includes('--dominds-app')) throw new Error('expected --dominds-app');",
      'const json = {',
      '  schemaVersion: 1,',
      `  appId: ${JSON.stringify(params.appId)},`,
      '  package: {',
      `    name: ${JSON.stringify(params.appId)},`,
      "    version: '0.0.0',",
      '    rootAbs: process.cwd(),',
      '  },',
      "  host: { kind: 'node_module', moduleRelPath: 'dist/app.js', exportName: 'domindsApp' },",
      '};',
      'process.stdout.write(JSON.stringify(json));',
      '',
    ].join('\n'),
  );
  await writeText(
    path.join(params.packageRootAbs, '.minds', 'app.yaml'),
    ['apiVersion: dominds.io/v1alpha1', 'kind: DomindsApp', `id: ${params.appId}`, ''].join('\n'),
  );
}

function listAppsProblems(): string[] {
  const snapshot = getProblemsSnapshot();
  return snapshot.problems
    .filter((p) => p.id.startsWith('apps/apps_resolution/'))
    .map((p) => p.id)
    .sort();
}

function listAppsProblemRecords(): ReadonlyArray<
  ReturnType<typeof getProblemsSnapshot>['problems'][number]
> {
  const snapshot = getProblemsSnapshot();
  return snapshot.problems.filter((p) => p.id.startsWith('apps/apps_resolution/'));
}

async function main(): Promise<void> {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-apps-issues-to-problems-'));
  const missingRequiredId = 'missing_required_app';

  try {
    // Case 1: required dependency missing => issues => Problems.
    removeProblemsByPrefix('apps/apps_resolution/');
    await writeText(
      path.join(tmpRoot, '.minds', 'app.yaml'),
      [
        'apiVersion: dominds.io/v1alpha1',
        'kind: DomindsApp',
        'id: rtws_root',
        'dependencies:',
        `  - id: ${missingRequiredId}`,
        '',
      ].join('\n'),
    );

    const snap1 = await loadEnabledAppsSnapshot({ rtwsRootAbs: tmpRoot });
    assert.equal(snap1.enabledApps.length, 0);
    assert.ok(
      snap1.issues.some((i) => i.kind === 'required_dependency_missing'),
      `expected required_dependency_missing issue, got: ${JSON.stringify(snap1.issues)}`,
    );

    reconcileAppsResolutionIssuesToProblems({ issues: snap1.issues });
    assert.ok(
      listAppsProblems().length > 0,
      `expected apps problems to be populated, got: ${JSON.stringify(listAppsProblems())}`,
    );

    reconcileAppsResolutionIssuesToProblems({ issues: [] });
    const resolvedRecords = listAppsProblemRecords();
    assert.ok(resolvedRecords.length > 0, 'expected resolved records after reconcile([])');
    assert.ok(
      resolvedRecords.every((p) => p.resolved === true),
      `expected all apps problems resolved=true, got: ${JSON.stringify(resolvedRecords)}`,
    );
    assert.ok(
      resolvedRecords.every((p) => typeof p.resolvedAt === 'string' && p.resolvedAt.trim() !== ''),
      `expected all resolved apps problems to have resolvedAt, got: ${JSON.stringify(resolvedRecords)}`,
    );
    const removedResolved = clearResolvedProblems();
    assert.ok(
      removedResolved > 0,
      `expected clearResolvedProblems to remove records, got ${removedResolved}`,
    );
    assert.deepEqual(listAppsProblems(), []);

    // Case 2: required dependency disabled in configuration => issues => Problems.
    removeProblemsByPrefix('apps/apps_resolution/');
    await writeLocalPackage({
      packageRootAbs: path.join(tmpRoot, 'dominds-apps', missingRequiredId),
      appId: missingRequiredId,
    });
    await writeText(
      path.join(tmpRoot, '.apps', 'configuration.yaml'),
      ['schemaVersion: 1', 'disabledApps:', `  - ${missingRequiredId}`, ''].join('\n'),
    );

    const snap2 = await loadEnabledAppsSnapshot({ rtwsRootAbs: tmpRoot });
    assert.equal(snap2.enabledApps.length, 0);
    assert.ok(
      snap2.issues.some((i) => i.kind === 'required_dependency_disabled'),
      `expected required_dependency_disabled issue, got: ${JSON.stringify(snap2.issues)}`,
    );

    reconcileAppsResolutionIssuesToProblems({ issues: snap2.issues });
    assert.ok(listAppsProblems().length > 0);
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
    removeProblemsByPrefix('apps/apps_resolution/');
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
