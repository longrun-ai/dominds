import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { loadEnabledAppTeammates } from '../main/apps/teammates';

async function writeText(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf-8');
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function getScribeName(members: Record<string, unknown>): string | null {
  const scribeRaw = members['scribe'];
  const scribe = asRecord(scribeRaw);
  if (!scribe) return null;
  const name = scribe['name'];
  return typeof name === 'string' ? name : null;
}

async function writeLocalAppPackage(params: {
  appId: string;
  packageName: string;
  packageRootAbs: string;
  teammatesYamlRelPath?: string;
}): Promise<void> {
  await writeText(
    path.join(params.packageRootAbs, 'package.json'),
    JSON.stringify(
      {
        name: params.packageName,
        version: '0.0.0',
        bin: 'bin.js',
      },
      null,
      2,
    ),
  );
  const contributesLines =
    params.teammatesYamlRelPath === undefined
      ? []
      : [
          `  contributes: { teammatesYamlRelPath: ${JSON.stringify(params.teammatesYamlRelPath)} },`,
        ];
  await writeText(
    path.join(params.packageRootAbs, 'bin.js'),
    [
      "'use strict';",
      "if (!process.argv.includes('--json')) throw new Error('expected --json');",
      'const json = {',
      '  schemaVersion: 1,',
      `  appId: ${JSON.stringify(params.appId)},`,
      '  package: {',
      `    name: ${JSON.stringify(params.packageName)},`,
      "    version: '0.0.0',",
      '    rootAbs: process.cwd(),',
      '  },',
      "  host: { kind: 'node_module', moduleRelPath: 'index.js', exportName: 'main' },",
      ...contributesLines,
      '};',
      'process.stdout.write(JSON.stringify(json));',
      '',
    ].join('\n'),
  );
}

async function main(): Promise<void> {
  const oldCwd = process.cwd();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-apps-teammates-override-'));

  try {
    process.chdir(tmpRoot);

    const commonRoot = path.join(tmpRoot, 'dominds-apps', 'common_agents');
    const midRoot = path.join(tmpRoot, 'dominds-apps', 'mid_agents');
    const outerRoot = path.join(tmpRoot, 'dominds-apps', 'outer_agents');

    await writeText(
      path.join(tmpRoot, '.minds', 'app.yaml'),
      [
        'apiVersion: dominds.io/v1alpha1',
        'kind: DomindsApp',
        'id: rtws_root',
        'dependencies:',
        '  - id: outer_agents',
        '',
      ].join('\n'),
    );

    await writeLocalAppPackage({
      appId: 'common_agents',
      packageName: 'app-common-agents',
      packageRootAbs: commonRoot,
      teammatesYamlRelPath: 'team.yaml',
    });

    await writeText(
      path.join(commonRoot, '.minds', 'app.yaml'),
      ['apiVersion: dominds.io/v1alpha1', 'kind: DomindsApp', 'id: common_agents', ''].join('\n'),
    );
    await writeText(
      path.join(commonRoot, 'team.yaml'),
      ['members:', '  scribe:', '    name: ScribeFromDefault', ''].join('\n'),
    );

    await writeLocalAppPackage({
      appId: 'mid_agents',
      packageName: 'app-mid-agents',
      packageRootAbs: midRoot,
    });

    await writeText(
      path.join(midRoot, '.minds', 'app.yaml'),
      [
        'apiVersion: dominds.io/v1alpha1',
        'kind: DomindsApp',
        'id: mid_agents',
        'dependencies:',
        '  - id: common_agents',
        '  - id: outer_agents',
        '',
      ].join('\n'),
    );
    await writeText(
      path.join(midRoot, '.apps', 'override', 'common_agents', 'team.yaml'),
      ['members:', '  scribe:', '    name: ScribeFromMidOverride', ''].join('\n'),
    );

    await writeLocalAppPackage({
      appId: 'outer_agents',
      packageName: 'app-outer-agents',
      packageRootAbs: outerRoot,
    });

    await writeText(
      path.join(outerRoot, '.minds', 'app.yaml'),
      [
        'apiVersion: dominds.io/v1alpha1',
        'kind: DomindsApp',
        'id: outer_agents',
        'dependencies:',
        '  - id: mid_agents',
        '',
      ].join('\n'),
    );
    await writeText(
      path.join(outerRoot, '.apps', 'override', 'common_agents', 'team.yaml'),
      ['members:', '  scribe:', '    name: ScribeFromOuterOverride', ''].join('\n'),
    );

    // No rtws override: outer app override should beat mid app override, and cycle must not hang.
    const loadedWithoutRtws = await loadEnabledAppTeammates({ rtwsRootAbs: tmpRoot });
    const commonSnippetWithoutRtws = loadedWithoutRtws.find((s) => s.appId === 'common_agents');
    assert.ok(commonSnippetWithoutRtws, 'expected common_agents teammates snippet');
    assert.equal(
      getScribeName(commonSnippetWithoutRtws.members),
      'ScribeFromOuterOverride',
      'outer app override should beat inner app override',
    );

    // rtws override has highest priority.
    await writeText(
      path.join(tmpRoot, '.apps', 'override', 'common_agents', 'team.yaml'),
      ['members:', '  scribe:', '    name: ScribeFromRtwsOverride', ''].join('\n'),
    );

    const loadedWithRtws = await loadEnabledAppTeammates({ rtwsRootAbs: tmpRoot });
    const commonSnippetWithRtws = loadedWithRtws.find((s) => s.appId === 'common_agents');
    assert.ok(commonSnippetWithRtws, 'expected common_agents teammates snippet');
    assert.equal(
      getScribeName(commonSnippetWithRtws.members),
      'ScribeFromRtwsOverride',
      'rtws override should beat app override',
    );
  } finally {
    process.chdir(oldCwd);
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
