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
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function getScribeName(members: Record<string, unknown>): string | null {
  const scribeRaw = members['scribe'];
  const scribe = asRecord(scribeRaw);
  if (!scribe) return null;
  const name = scribe['name'];
  return typeof name === 'string' ? name : null;
}

function buildResolutionEntryYaml(params: {
  appId: string;
  packageName: string;
  rootAbs: string;
  teammatesYamlRelPath?: string;
}): string[] {
  const lines = [
    `  - id: ${params.appId}`,
    '    enabled: true',
    '    source:',
    '      kind: local',
    `      pathAbs: ${JSON.stringify(params.rootAbs)}`,
    '    assignedPort: null',
    '    installJson:',
    '      schemaVersion: 1',
    `      appId: ${params.appId}`,
    '      package:',
    `        name: ${params.packageName}`,
    '        version: null',
    `        rootAbs: ${JSON.stringify(params.rootAbs)}`,
    '      host:',
    '        kind: node_module',
    '        moduleRelPath: index.js',
    '        exportName: main',
  ];
  if (params.teammatesYamlRelPath) {
    lines.push('      contributes:');
    lines.push(`        teammatesYamlRelPath: ${params.teammatesYamlRelPath}`);
  }
  return lines;
}

async function main(): Promise<void> {
  const oldCwd = process.cwd();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-apps-teammates-override-'));

  try {
    process.chdir(tmpRoot);

    const commonRoot = path.join(tmpRoot, 'app-common-agents');
    const midRoot = path.join(tmpRoot, 'app-mid-agents');
    const outerRoot = path.join(tmpRoot, 'app-outer-agents');

    await writeText(
      path.join(commonRoot, '.minds', 'app.yaml'),
      [
        'apiVersion: dominds.io/v1alpha1',
        'kind: DomindsApp',
        'id: common_agents',
        '',
      ].join('\n'),
    );
    await writeText(
      path.join(commonRoot, 'team.yaml'),
      [
        'members:',
        '  scribe:',
        '    name: ScribeFromDefault',
        '',
      ].join('\n'),
    );

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
      [
        'members:',
        '  scribe:',
        '    name: ScribeFromMidOverride',
        '',
      ].join('\n'),
    );

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
      [
        'members:',
        '  scribe:',
        '    name: ScribeFromOuterOverride',
        '',
      ].join('\n'),
    );

    await writeText(
      path.join(tmpRoot, '.apps', 'resolution.yaml'),
      [
        'schemaVersion: 1',
        'apps:',
        ...buildResolutionEntryYaml({
          appId: 'common_agents',
          packageName: 'app-common-agents',
          rootAbs: commonRoot,
          teammatesYamlRelPath: 'team.yaml',
        }),
        ...buildResolutionEntryYaml({
          appId: 'mid_agents',
          packageName: 'app-mid-agents',
          rootAbs: midRoot,
        }),
        ...buildResolutionEntryYaml({
          appId: 'outer_agents',
          packageName: 'app-outer-agents',
          rootAbs: outerRoot,
        }),
        '',
      ].join('\n'),
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
      [
        'members:',
        '  scribe:',
        '    name: ScribeFromRtwsOverride',
        '',
      ].join('\n'),
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

