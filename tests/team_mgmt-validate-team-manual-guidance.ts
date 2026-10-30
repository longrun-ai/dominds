#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { Dialog } from '../main/dialog';
import { getProblemsSnapshot } from '../main/problems';
import { Team } from '../main/team';
import '../main/tools/builtins';
import { teamMgmtValidateTeamCfgTool } from '../main/tools/team_mgmt';
import { buildToolsetManualTools } from '../main/tools/toolset-manual';
import { writeSemanticEvidence, type SemanticEvidence } from './helpers/semantic-evidence';

async function writeText(filePathAbs: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePathAbs), { recursive: true });
  await fs.writeFile(filePathAbs, content, 'utf8');
}

async function main(): Promise<void> {
  assert.equal(process.env.DOMINDS_TEST_RTWS_MANAGED, '1', 'run through tests/cli.ts');
  const semantic = process.argv.includes('--semantic');
  const cases: SemanticEvidence[] = [];
  {
    await writeText(
      path.join(process.cwd(), '.minds', 'llm.yaml'),
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
      path.join(process.cwd(), '.minds', 'team.yaml'),
      [
        'member_defaults:',
        '  provider: stub',
        '  model: fake_model',
        'members:',
        '  team_admin:',
        '    name: Team Admin',
        '    toolsets:',
        '      - playwright_interactive',
        '',
      ].join('\n'),
    );

    const dlg = { getLastUserLanguageCode: () => 'en' as const } as unknown as Dialog;
    const caller = new Team.Member({ id: 'tester', name: 'Tester' });
    const manualCaller = new Team.Member({ id: 'tester', name: 'Tester', toolsets: ['team_mgmt'] });
    const built = buildToolsetManualTools({
      toolsetNames: [],
      existingToolNames: new Set<string>(),
    });
    const manTool = built.tools.find((entry) => entry.name === 'man');
    assert.ok(manTool, 'man tool should be available');

    for (const language of ['en', 'zh'] as const) {
      const localizedDialog = { ...dlg, getLastUserLanguageCode: () => language } as Dialog;
      const validation = await teamMgmtValidateTeamCfgTool.call(localizedDialog, caller, {});
      assert.equal(validation.outcome, 'failure');
      const missingCapability = getProblemsSnapshot().problems.find(
        (problem) =>
          problem.id ===
          'team/team_yaml_error/members/team_admin/toolsets/playwright_interactive/missing',
      );
      assert.ok(missingCapability);
      assert.equal(missingCapability.kind, 'team_workspace_config_error');
      assert.equal(missingCapability.severity, 'error');
      assert.equal(missingCapability.resolved, false);
      const manual = await manTool.call(localizedDialog, manualCaller, {
        toolsetId: 'team_mgmt',
        topic: 'troubleshooting',
      });
      assert.equal(
        manual.outcome,
        'success',
        'manual remains callable while referenced component toolset is missing',
      );
      if (semantic)
        cases.push({
          id: 'missing-component-' + language,
          scenario:
            'team_admin references playwright_interactive but the capability package is not installed in this isolated workspace.',
          businessValue:
            'Keep investigation possible when an optional component is unavailable, and guide repair of the current compatible implementation.',
          context: {
            language,
            teamYaml: await fs.readFile('.minds/team.yaml', 'utf8'),
            appYamlExists: false,
            problems: JSON.stringify(getProblemsSnapshot().problems),
            availableManual: manual.content,
          },
          reviewQuestions: [
            'Does validation explain the missing capability and a useful investigation path through still-available team-management tools?',
            'Is current app.yaml / App Host troubleshooting framed as compatibility with the existing implementation rather than the target architecture?',
            'Does the advice avoid granting tools through descriptive text or claiming all team members are unusable?',
          ],
          actualText: validation.content,
        });
    }
  }
  if (semantic) await writeSemanticEvidence(cases, 'dominds-team-validation-guidance-');
  else console.log('Team validation/manual availability behavior tests passed');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
