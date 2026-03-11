import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import YAML from 'yaml';

import { runDomindsAppJsonViaLocalPackage } from '../main/apps/run-app-json';
import { registerEnabledAppsToolProxies } from '../main/apps/runtime';
import { loadAgentMinds } from '../main/minds/load';
import { getProblemsSnapshot, removeProblemsByPrefix } from '../main/problems';
import '../main/tools/builtins';
import { createToolsRegistrySnapshot } from '../main/tools/registry-snapshot';

async function writeText(filePathAbs: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePathAbs), { recursive: true });
  await fs.writeFile(filePathAbs, content, 'utf-8');
}

async function main(): Promise<void> {
  const previousCwd = process.cwd();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-app-tool-proxy-refresh-'));
  const appId = '@longrun-ai/web-dev';
  const webDevRootAbs = path.resolve(
    __dirname,
    '..',
    '..',
    'dominds-apps',
    '@longrun-ai',
    'web-dev',
  );

  try {
    process.chdir(tmpRoot);
    const installJson = await runDomindsAppJsonViaLocalPackage({ packageRootAbs: webDevRootAbs });

    await writeText(
      path.join(tmpRoot, '.minds', 'app.yaml'),
      [
        'apiVersion: dominds.io/v1alpha1',
        'kind: DomindsApp',
        'id: rtws_root',
        'dependencies:',
        `  - id: ${JSON.stringify(appId)}`,
        '',
      ].join('\n'),
    );
    await writeText(
      path.join(tmpRoot, '.minds', 'llm.yaml'),
      [
        'providers:',
        '  stub:',
        '    name: Stub',
        '    apiType: openai',
        '    baseUrl: https://example.invalid',
        '    apiKeyEnvVar: STUB_API_KEY',
        '    models:',
        '      fake_model: { name: "fake-model" }',
        '',
      ].join('\n'),
    );
    await writeText(
      path.join(tmpRoot, '.minds', 'team.yaml'),
      [
        'member_defaults:',
        '  provider: stub',
        '  model: fake_model',
        'default_responder: tester',
        'members:',
        '  tester:',
        '    name: Tester',
        '    toolsets:',
        '      - playwright_interactive',
        '',
      ].join('\n'),
    );
    await writeText(
      path.join(tmpRoot, '.apps', 'resolution.yaml'),
      YAML.stringify({
        schemaVersion: 1,
        apps: [
          {
            id: appId,
            enabled: true,
            assignedPort: 43123,
            source: { kind: 'local', pathAbs: webDevRootAbs },
            installJson,
          },
        ],
      }),
    );

    removeProblemsByPrefix('team/team_yaml_error/');

    const before = createToolsRegistrySnapshot();
    assert.ok(
      before.toolsets.every((toolset) => toolset.name !== 'playwright_interactive'),
      'playwright_interactive should not exist before refresh',
    );

    const minds = await loadAgentMinds('tester', undefined, { missingToolsetPolicy: 'warn' });
    const toolNames = minds.agentTools
      .filter((tool) => tool.type === 'func')
      .map((tool) => tool.name)
      .sort();
    assert.ok(toolNames.includes('playwright_session_new'));
    assert.ok(toolNames.includes('playwright_session_eval'));

    const afterMindsLoad = createToolsRegistrySnapshot();
    const interactiveToolset = afterMindsLoad.toolsets.find(
      (toolset) => toolset.name === 'playwright_interactive',
    );
    assert.ok(interactiveToolset, 'expected app toolset after loadAgentMinds refresh');
    assert.equal(interactiveToolset?.source, 'app');
    assert.ok(interactiveToolset?.tools.some((tool) => tool.name === 'playwright_session_status'));

    const teamProblems = getProblemsSnapshot().problems.filter((problem) =>
      problem.id.startsWith('team/team_yaml_error/'),
    );
    assert.ok(
      teamProblems.every(
        (problem) => !problem.id.includes('/toolsets/playwright_interactive/missing'),
      ),
      `unexpected team problems: ${teamProblems.map((problem) => problem.id).join(', ')}`,
    );

    await registerEnabledAppsToolProxies({ rtwsRootAbs: tmpRoot });
    const afterExplicitRefresh = createToolsRegistrySnapshot();
    const interactiveToolsets = afterExplicitRefresh.toolsets.filter(
      (toolset) => toolset.name === 'playwright_interactive',
    );
    assert.equal(interactiveToolsets.length, 1, 'refresh should remain idempotent');
  } finally {
    process.chdir(previousCwd);
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

main()
  .then(() => {
    console.log('OK');
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
