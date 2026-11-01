import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {
  getProblemsSnapshot,
  reconcileProblemsByPrefix,
  removeProblemsByPrefix,
} from '../main/problems';
import { setWorkLanguage } from '../main/runtime/work-language';
import { Team } from '../main/team';
import {
  teamMgmtClearProblemsTool,
  teamMgmtListProblemsTool,
  teamMgmtValidateTeamCfgTool,
} from '../main/tools/team_mgmt';
import { semanticEvidenceCollector } from './helpers/semantic-evidence';
import { toolOutputData } from './helpers/tool-output';
import { createMainDialog, withTempRtws, writeStandardMinds } from './kernel-driver/helpers';

const evidence = semanticEvidenceCollector('dominds-problems-lifecycle-');
const prefix = 'team/team_yaml_error/';
const id = prefix + 'members/tester/name/invalid_ignored';
const teamYaml = (valid: boolean) =>
  `member_defaults:\n  provider: local-mock\n  model: default\nmembers:\n  tester:\n    name: ${valid ? 'Tester' : '123'}\n`;
async function main() {
  await withTempRtws(async (rtws) => {
    await writeStandardMinds(rtws);
    const dialog = await createMainDialog();
    const caller = new Team.Member({ id: 'tester', name: 'Tester' });
    for (const language of ['en', 'zh'] as const) {
      removeProblemsByPrefix(prefix);
      setWorkLanguage(language);
      dialog.setLastUserLanguageCode(language);
      await fs.writeFile('.minds/team.yaml', teamYaml(false));
      async function observe(phase: string, actualText: string) {
        evidence.record({
          id: phase + '-' + language,
          scenario: phase,
          businessValue:
            'An agent must distinguish active problems from resolved history and clear only the requested records.',
          context: {
            language,
            teamYaml: await fs.readFile('.minds/team.yaml', 'utf8'),
            snapshot: JSON.stringify(getProblemsSnapshot()),
          },
          reviewQuestions: [
            'Does the full output accurately distinguish active issues, resolved history, and any records actually cleared?',
            'Are the source/path scope and suggested next action consistent with the supplied state?',
          ],
          actualText,
        });
      }
      const invalid = await teamMgmtValidateTeamCfgTool.call(dialog, caller, {});
      const active = getProblemsSnapshot().problems.find((p) => p.id === id);
      assert.ok(
        active && active.kind === 'team_workspace_config_error',
        JSON.stringify(getProblemsSnapshot()),
      );
      assert.equal(active.source, 'team');
      assert.equal(active.severity, 'warning');
      const retainedMember = (await Team.load()).getMember('tester');
      assert.ok(retainedMember);
      assert.equal(retainedMember.name, 'tester');
      assert.equal(active.detail.filePath, '.minds/team.yaml');
      assert.equal(active.resolved, false);
      assert.equal(active.resolvedAt, null);
      await observe('invalid-configuration', invalid.content);
      const beforeClear = getProblemsSnapshot();
      const premature = await teamMgmtClearProblemsTool.call(dialog, caller, {
        source: 'team',
        path: 'team.yaml',
      });
      assert.equal(premature.outcome, 'success');
      assert.deepEqual(
        getProblemsSnapshot(),
        beforeClear,
        'default clear cannot remove or mutate active records',
      );
      await observe('clear-active-default', premature.content);
      await fs.writeFile('.minds/team.yaml', teamYaml(true));
      const repaired = await teamMgmtValidateTeamCfgTool.call(dialog, caller, {});
      assert.equal(repaired.outcome, 'success');
      const resolved = getProblemsSnapshot().problems.find((p) => p.id === id);
      assert.ok(resolved?.resolved && resolved.resolvedAt);
      assert.deepEqual(
        { ...resolved, resolved: active.resolved, resolvedAt: active.resolvedAt },
        active,
      );
      await observe('repaired-configuration', repaired.content);
      const listed = await teamMgmtListProblemsTool.call(dialog, caller, {
        source: 'team',
        path: 'team.yaml',
      });
      assert.equal(listed.outcome, 'success');
      const data = toolOutputData(listed.content);
      assert.equal(data.active_count, 0);
      assert.equal(data.resolved_count, 1);
      assert.equal(data.returned_count, 1);
      assert.ok(Array.isArray(data.problems));
      const entry: unknown = data.problems[0];
      assert.ok(
        entry &&
          typeof entry === 'object' &&
          'problem_id' in entry &&
          'active' in entry &&
          'resolved_at' in entry,
      );
      assert.equal(entry.problem_id, id);
      assert.equal(entry.active, false);
      assert.equal(entry.resolved_at, resolved.resolvedAt);
      await observe('list-resolved-history', listed.content);
      // Real resolved records isolate both source and path filtering of the public clear tool.
      reconcileProblemsByPrefix('fixture/unmatched/', [
        {
          id: 'fixture/unmatched/team-other-path',
          timestamp: '2026/10/31-00:00:00',
          kind: 'team_workspace_config_error',
          source: 'team',
          severity: 'warning',
          message: 'Supplied other-path fixture data.',
          detail: { filePath: '.minds/other.yaml', errorText: 'Supplied fixture detail.' },
        },
        {
          id: 'fixture/unmatched/mcp-same-path',
          timestamp: '2026/10/31-00:00:00',
          kind: 'mcp_workspace_config_error',
          source: 'mcp',
          severity: 'error',
          message: 'Supplied other-source fixture data.',
          detail: { filePath: '.minds/team.yaml', errorText: 'Supplied fixture detail.' },
        },
      ]);
      reconcileProblemsByPrefix('fixture/unmatched/', []);
      const unmatched = getProblemsSnapshot().problems.filter((p) =>
        p.id.startsWith('fixture/unmatched/'),
      );
      assert.equal(unmatched.length, 2);
      const cleared = await teamMgmtClearProblemsTool.call(dialog, caller, {
        source: 'team',
        path: 'team.yaml',
      });
      assert.equal(cleared.outcome, 'success');
      assert.equal(
        getProblemsSnapshot().problems.some((p) => p.id === id),
        false,
      );
      assert.deepEqual(
        getProblemsSnapshot().problems.filter((p) => p.id.startsWith('fixture/unmatched/')),
        unmatched,
      );
      await observe('clear-resolved-filtered', cleared.content);
      removeProblemsByPrefix('fixture/unmatched/');
    }
  });
  await evidence.write();
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
