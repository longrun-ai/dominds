import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { loadAgentMinds } from '../main/minds/load';
import { getProblemsSnapshot, removeProblemsByPrefix } from '../main/problems';
import { Team } from '../main/team';
import '../main/tools/builtins';
import { writeSemanticEvidence, type SemanticEvidence } from './helpers/semantic-evidence';

async function writeText(p: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content, 'utf-8');
}

async function main(): Promise<void> {
  assert.equal(process.env.DOMINDS_TEST_RTWS_MANAGED, '1', 'run through tests/cli.ts');
  const tmpRoot = process.cwd();
  const semantic = process.argv.includes('--semantic');
  const cases: SemanticEvidence[] = [];
  async function recordDiagnostic(id: string, problem: unknown, scenario: string): Promise<void> {
    if (!semantic) return;
    cases.push({
      id,
      scenario,
      businessValue:
        'Help the team manager repair configuration without losing working members or granting unintended capabilities.',
      context: {
        teamYaml: await fs.readFile(path.join(tmpRoot, '.minds/team.yaml'), 'utf8'),
        llmYaml: await fs
          .readFile(path.join(tmpRoot, '.minds/llm.yaml'), 'utf8')
          .catch(() => 'built-in provider catalog'),
        scope: 'Actual Problems output; state effects are asserted separately by this script.',
      },
      reviewQuestions: [
        'Do the English and Chinese messages explain the actual rejected or ignored configuration and its effect, consistently with the supplied YAML?',
        'Is the repair advice actionable without invented constraints, changed permissions, or an implication that otherwise valid members must be removed?',
        'Are examples distinguished from required syntax and are provider namespaces and capability ownership accurate?',
      ],
      actualText: JSON.stringify(problem, null, 2),
    });
  }
  {
    removeProblemsByPrefix('team/team_yaml_error/');

    await writeText(
      path.join(tmpRoot, '.minds', 'team.yaml'),
      [
        'member_defaults:',
        '  provider: openai',
        '  model: gpt-5.4',
        'default_responder: alice',
        'members:',
        '  alice:',
        '    name: Alice',
        '    toolsets: [ws_read]',
        '  bob:',
        '    name: 123',
        '    provider: 123',
        '    toolsets: ws_read',
        '  charlie: "oops"',
        '',
      ].join('\n'),
    );

    const team = await Team.load();

    assert.ok(team.getMember('alice'), 'alice should be loaded');
    assert.equal(team.getMember('bob'), undefined, 'bob should be omitted due to invalid config');
    assert.equal(
      team.getMember('charlie'),
      undefined,
      'charlie should be omitted due to invalid config',
    );
    assert.equal(
      team.getMember('alice')?.fbr_model_params?.openai?.web_search_tool,
      false,
      'member should inherit default fbr openai.web_search_tool=false',
    );

    const snapshot = getProblemsSnapshot();
    const ids = snapshot.problems.map((p) => p.id).sort();
    assert.ok(ids.includes('team/team_yaml_error/members/bob'), 'problem for bob should exist');
    assert.ok(
      ids.includes('team/team_yaml_error/members/charlie'),
      'problem for charlie should exist',
    );

    const bobProblem = snapshot.problems.find((p) => p.id === 'team/team_yaml_error/members/bob');
    assert.ok(bobProblem && bobProblem.kind === 'team_workspace_config_error');

    const charlieProblem = snapshot.problems.find(
      (p) => p.id === 'team/team_yaml_error/members/charlie',
    );
    assert.ok(charlieProblem && charlieProblem.kind === 'team_workspace_config_error');

    await recordDiagnostic(
      'bobProblem',
      bobProblem,
      'Invalid provider type omits Bob while Alice remains usable.',
    );

    await recordDiagnostic(
      'charlieProblem',
      charlieProblem,
      'A member is a scalar instead of a member configuration.',
    );

    // FBR web-search defaults are provider-namespace specific: OpenAI/Responses uses
    // `openai.web_search_tool`, while Codex uses `codex.web_search`.
    removeProblemsByPrefix('team/team_yaml_error/');
    await writeText(
      path.join(tmpRoot, '.minds', 'team.yaml'),
      [
        'member_defaults:',
        '  provider: codex',
        '  model: gpt-5.2',
        'default_responder: alice',
        'members:',
        '  alice:',
        '    name: Alice',
        '    toolsets: [ws_read]',
        '',
      ].join('\n'),
    );

    const teamCodexDefaults = await Team.load();
    assert.equal(
      teamCodexDefaults.getMember('alice')?.fbr_model_params?.codex?.web_search,
      'disabled',
      'member should inherit default fbr codex.web_search=disabled',
    );
    assert.equal(
      teamCodexDefaults.getMember('alice')?.fbr_model_params?.openai?.web_search_tool,
      false,
      'FBR defaults should preserve separate OpenAI/Responses namespace even for codex members',
    );

    // Unknown keys + common model_params misplacements should be detected and reported (but not
    // break loading of otherwise valid members/defaults).
    removeProblemsByPrefix('team/team_yaml_error/');
    await writeText(
      path.join(tmpRoot, '.minds', 'team.yaml'),
      [
        'member_defaults:',
        '  provider: codex',
        '  model: gpt-5.2',
        '  reasoning_effort: high',
        '  model_params:',
        '    reasoning_effort: high',
        '    codex:',
        '      reasoning_effort: high',
        '      verbosity: low',
        '      web_search: live',
        '      extra_key: true',
        'default_responder: alice',
        'members:',
        '  alice:',
        '    name: Alice',
        '    verbosity: low',
        '    model_params:',
        '      codex:',
        '        verbosity: low',
        '',
      ].join('\n'),
    );

    const team2 = await Team.load();
    assert.ok(team2.getMember('alice'), 'alice should still be loaded');

    const snapshot2 = getProblemsSnapshot();
    const ids2 = snapshot2.problems.map((p) => p.id).sort();
    assert.ok(
      ids2.includes('team/team_yaml_error/member_defaults/unknown_fields'),
      'problem for member_defaults unknown fields should exist',
    );
    assert.ok(
      ids2.includes('team/team_yaml_error/member_defaults/model_params/unknown_fields'),
      'problem for member_defaults.model_params unknown fields should exist',
    );
    assert.ok(
      ids2.includes('team/team_yaml_error/member_defaults/model_params/codex/unknown_fields'),
      'problem for member_defaults.model_params.codex unknown fields should exist',
    );
    assert.ok(
      ids2.includes('team/team_yaml_error/members/alice/unknown_fields'),
      'problem for members.alice unknown fields should exist',
    );

    const mdUnknown = snapshot2.problems.find(
      (p) => p.id === 'team/team_yaml_error/member_defaults/unknown_fields',
    );
    assert.ok(mdUnknown && mdUnknown.kind === 'team_workspace_config_error');

    await recordDiagnostic(
      'mdUnknown',
      mdUnknown,
      'Reasoning effort is misplaced and unknown fields occur in defaults.',
    );

    // OpenAI/Codex output-token overrides are intentionally unsupported. Unknown fields should be
    // reported loudly and stripped from the parsed runtime model_params object.
    removeProblemsByPrefix('team/team_yaml_error/');
    await writeText(
      path.join(tmpRoot, '.minds', 'team.yaml'),
      [
        'member_defaults:',
        '  provider: codex',
        '  model: gpt-5.2',
        'default_responder: alice',
        'members:',
        '  alice:',
        '    name: Alice',
        '    model_params:',
        '      max_tokens: 123',
        '      general:',
        '        max_tokens: 456',
        '      codex:',
        '        max_tokens: 789',
        '        verbosity: low',
        '      openai:',
        '        max_tokens: 321',
        '        temperature: 0',
        '      openai-compatible:',
        '        web_search_tool: true',
        '        reasoning_summary: auto',
        '        verbosity: high',
        '        temperature: 0.1',
        '      anthropic:',
        '        max_tokens: 16',
        '',
      ].join('\n'),
    );

    const teamUnsupportedMaxTokens = await Team.load();
    const unsupportedMember = teamUnsupportedMaxTokens.getMember('alice');
    assert.ok(unsupportedMember, 'alice should still be loaded with unsupported fields stripped');
    const unsupportedModelParams = unsupportedMember.model_params as
      | Record<string, unknown>
      | undefined;
    assert.ok(unsupportedModelParams, 'model_params should still exist');
    assert.equal(
      Object.prototype.hasOwnProperty.call(unsupportedModelParams, 'max_tokens'),
      false,
      'root model_params.max_tokens should be stripped',
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(unsupportedModelParams, 'general'),
      false,
      'model_params.general should be stripped',
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        unsupportedMember.model_params?.codex ?? {},
        'max_tokens',
      ),
      false,
      'model_params.codex.max_tokens should be stripped',
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        unsupportedMember.model_params?.openai ?? {},
        'max_tokens',
      ),
      false,
      'model_params.openai.max_tokens should be stripped',
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        unsupportedMember.model_params?.['openai-compatible'] ?? {},
        'web_search_tool',
      ),
      false,
      'model_params.openai-compatible.web_search_tool should be stripped',
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        unsupportedMember.model_params?.['openai-compatible'] ?? {},
        'reasoning_summary',
      ),
      false,
      'model_params.openai-compatible.reasoning_summary should be stripped',
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        unsupportedMember.model_params?.['openai-compatible'] ?? {},
        'verbosity',
      ),
      false,
      'model_params.openai-compatible.verbosity should be stripped',
    );
    assert.equal(
      unsupportedMember.model_params?.codex?.verbosity,
      'low',
      'valid codex params should be preserved while stripping unknown max_tokens',
    );
    assert.equal(
      unsupportedMember.model_params?.openai?.temperature,
      0,
      'valid openai params should be preserved while stripping unknown max_tokens',
    );
    assert.equal(
      unsupportedMember.model_params?.['openai-compatible']?.temperature,
      0.1,
      'valid openai-compatible params should be preserved while stripping Responses-only fields',
    );
    assert.equal(
      unsupportedMember.model_params?.anthropic?.max_tokens,
      16,
      'anthropic.max_tokens should remain supported',
    );

    const unsupportedSnapshot = getProblemsSnapshot();
    const unsupportedIds = unsupportedSnapshot.problems.map((p) => p.id).sort();
    assert.ok(
      unsupportedIds.includes('team/team_yaml_error/members/alice/model_params/unknown_fields'),
      'root model_params max_tokens/general should be reported as unknown',
    );
    assert.ok(
      unsupportedIds.includes(
        'team/team_yaml_error/members/alice/model_params/codex/unknown_fields',
      ),
      'codex.max_tokens should be reported as unknown',
    );
    assert.ok(
      unsupportedIds.includes(
        'team/team_yaml_error/members/alice/model_params/openai/unknown_fields',
      ),
      'openai.max_tokens should be reported as unknown',
    );
    assert.ok(
      unsupportedIds.includes(
        'team/team_yaml_error/members/alice/model_params/openai-compatible/unknown_fields',
      ),
      'openai-compatible Responses-only fields should be reported as unknown',
    );
    const unsupportedRootProblem = unsupportedSnapshot.problems.find(
      (p) => p.id === 'team/team_yaml_error/members/alice/model_params/unknown_fields',
    );
    assert.ok(
      unsupportedRootProblem && unsupportedRootProblem.kind === 'team_workspace_config_error',
    );
    const unsupportedCodexProblem = unsupportedSnapshot.problems.find(
      (p) => p.id === 'team/team_yaml_error/members/alice/model_params/codex/unknown_fields',
    );
    assert.ok(
      unsupportedCodexProblem && unsupportedCodexProblem.kind === 'team_workspace_config_error',
    );
    const unsupportedOpenAiProblem = unsupportedSnapshot.problems.find(
      (p) => p.id === 'team/team_yaml_error/members/alice/model_params/openai/unknown_fields',
    );
    assert.ok(
      unsupportedOpenAiProblem && unsupportedOpenAiProblem.kind === 'team_workspace_config_error',
    );
    const unsupportedOpenAiCompatibleProblem = unsupportedSnapshot.problems.find(
      (p) =>
        p.id === 'team/team_yaml_error/members/alice/model_params/openai-compatible/unknown_fields',
    );
    assert.ok(
      unsupportedOpenAiCompatibleProblem &&
        unsupportedOpenAiCompatibleProblem.kind === 'team_workspace_config_error',
    );

    await recordDiagnostic(
      'unsupportedRootProblem',
      unsupportedRootProblem,
      'Unsupported root model_params and output-token overrides are stripped; Anthropic max_tokens remains supported.',
    );

    await recordDiagnostic(
      'unsupportedCodexProblem',
      unsupportedCodexProblem,
      'Codex output-token overrides are unsupported.',
    );

    await recordDiagnostic(
      'unsupportedOpenAiProblem',
      unsupportedOpenAiProblem,
      'OpenAI output-token overrides are unsupported.',
    );

    await recordDiagnostic(
      'unsupportedOpenAiCompatibleProblem',
      unsupportedOpenAiCompatibleProblem,
      'Responses-only fields are not accepted in the openai-compatible namespace.',
    );

    // Anthropic-compatible providers support a boolean thinking switch under their own namespace.
    removeProblemsByPrefix('team/team_yaml_error/');
    await writeText(
      path.join(tmpRoot, '.minds', 'team.yaml'),
      [
        'member_defaults:',
        '  provider: volcano-engine-coding-plan',
        '  model: doubao-seed-2.0-code',
        '  model_params:',
        '    anthropic-compatible:',
        '      thinking: true',
        'default_responder: alice',
        'members:',
        '  alice:',
        '    name: Alice',
        '',
      ].join('\n'),
    );

    const teamAnthropicThinking = await Team.load();
    const anthropicThinkingMember = teamAnthropicThinking.getMember('alice');
    assert.ok(anthropicThinkingMember, 'alice should load with anthropic thinking params');
    assert.equal(anthropicThinkingMember.model_params?.['anthropic-compatible']?.thinking, true);
    assert.equal(
      getProblemsSnapshot().problems.some((p) => p.id.includes('thinking/invalid_ignored')),
      false,
      'valid anthropic thinking flag should not produce problems',
    );

    removeProblemsByPrefix('team/team_yaml_error/');
    await writeText(
      path.join(tmpRoot, '.minds', 'team.yaml'),
      [
        'member_defaults:',
        '  provider: volcano-engine-coding-plan',
        '  model: doubao-seed-2.0-code',
        '  model_params:',
        '    openai-compatible:',
        '      thinking:',
        '        type: enabled',
        '        budget_tokens: 2048',
        'default_responder: alice',
        'members:',
        '  alice:',
        '    name: Alice',
        '',
      ].join('\n'),
    );

    const teamOpenAiCompatibleThinkingObject = await Team.load();
    const openAiCompatibleThinkingObjectMember =
      teamOpenAiCompatibleThinkingObject.getMember('alice');
    assert.ok(
      openAiCompatibleThinkingObjectMember,
      'alice should load with openai-compatible thinking object',
    );
    assert.deepEqual(
      openAiCompatibleThinkingObjectMember.model_params?.['openai-compatible']?.thinking,
      {
        type: 'enabled',
        budget_tokens: 2048,
      },
    );
    assert.equal(
      getProblemsSnapshot().problems.some((p) => p.id.includes('thinking/invalid_ignored')),
      false,
      'valid openai-compatible thinking object should not produce problems',
    );

    removeProblemsByPrefix('team/team_yaml_error/');
    await writeText(
      path.join(tmpRoot, '.minds', 'team.yaml'),
      [
        'member_defaults:',
        '  provider: kimi-code',
        '  model: kimi-for-coding',
        '  model_params:',
        '    openai-compatible:',
        '      thinking: medium',
        'default_responder: alice',
        'members:',
        '  alice:',
        '    name: Alice',
        '',
      ].join('\n'),
    );

    const teamOpenAiCompatibleThinkingMode = await Team.load();
    const openAiCompatibleThinkingModeMember = teamOpenAiCompatibleThinkingMode.getMember('alice');
    assert.ok(
      openAiCompatibleThinkingModeMember,
      'alice should load with Kimi Code openai-compatible thinking mode',
    );
    assert.equal(
      openAiCompatibleThinkingModeMember.model_params?.['openai-compatible']?.thinking,
      'medium',
    );
    assert.equal(
      getProblemsSnapshot().problems.some((p) => p.id.includes('thinking/invalid_ignored')),
      false,
      'valid Kimi Code openai-compatible thinking mode should not produce problems',
    );

    removeProblemsByPrefix('team/team_yaml_error/');
    await writeText(
      path.join(tmpRoot, '.minds', 'team.yaml'),
      [
        'member_defaults:',
        '  provider: anthropic',
        '  model: claude-sonnet-4.5',
        '  model_params:',
        '    anthropic:',
        '      thinking:',
        '        type: enabled',
        '        budget_tokens: 1024',
        'default_responder: alice',
        'members:',
        '  alice:',
        '    name: Alice',
        '',
      ].join('\n'),
    );

    const teamAnthropicThinkingObject = await Team.load();
    const anthropicThinkingObjectMember = teamAnthropicThinkingObject.getMember('alice');
    assert.ok(anthropicThinkingObjectMember, 'alice should load with anthropic thinking object');
    assert.deepEqual(anthropicThinkingObjectMember.model_params?.anthropic?.thinking, {
      type: 'enabled',
      budget_tokens: 1024,
    });
    assert.equal(
      getProblemsSnapshot().problems.some((p) => p.id.includes('thinking/invalid_ignored')),
      false,
      'valid official anthropic thinking object should not produce problems',
    );

    removeProblemsByPrefix('team/team_yaml_error/');
    await writeText(
      path.join(tmpRoot, '.minds', 'team.yaml'),
      [
        'member_defaults:',
        '  provider: anthropic',
        '  model: claude-sonnet-4.5',
        '  model_params:',
        '    anthropic:',
        '      thinking:',
        '        type: adaptive',
        'default_responder: alice',
        'members:',
        '  alice:',
        '    name: Alice',
        '',
      ].join('\n'),
    );

    const teamAnthropicAdaptiveThinking = await Team.load();
    const anthropicAdaptiveMember = teamAnthropicAdaptiveThinking.getMember('alice');
    assert.ok(anthropicAdaptiveMember, 'alice should load with official adaptive thinking object');
    assert.deepEqual(anthropicAdaptiveMember.model_params?.anthropic?.thinking, {
      type: 'adaptive',
    });
    assert.equal(
      getProblemsSnapshot().problems.some((p) => p.id.includes('thinking/invalid_ignored')),
      false,
      'valid official anthropic adaptive thinking object should not produce problems',
    );

    removeProblemsByPrefix('team/team_yaml_error/');
    await writeText(
      path.join(tmpRoot, '.minds', 'team.yaml'),
      [
        'member_defaults:',
        '  provider: anthropic',
        '  model: claude-sonnet-4.5',
        '  model_params:',
        '    anthropic:',
        '      thinking: true',
        'default_responder: alice',
        'members:',
        '  alice:',
        '    name: Alice',
        '',
      ].join('\n'),
    );

    await Team.load();
    const officialAnthropicBooleanProblem = getProblemsSnapshot().problems.find(
      (p) => p.id === 'team/team_yaml_error/member_defaults/model_params/invalid_ignored',
    );
    assert.ok(
      officialAnthropicBooleanProblem &&
        officialAnthropicBooleanProblem.kind === 'team_workspace_config_error',
      'official anthropic namespace should reject boolean thinking while parsing',
    );

    await recordDiagnostic(
      'officialAnthropicBooleanProblem',
      officialAnthropicBooleanProblem,
      'An official Anthropic thinking setting is given the incompatible boolean form.',
    );

    removeProblemsByPrefix('team/team_yaml_error/');
    await writeText(
      path.join(tmpRoot, '.minds', 'team.yaml'),
      [
        'member_defaults:',
        '  provider: volcano-engine-coding-plan',
        '  model: doubao-seed-2.0-code',
        '  model_params:',
        '    anthropic-compatible:',
        '      thinking:',
        '        type: enabled',
        '        budget_tokens: 1024',
        'default_responder: alice',
        'members:',
        '  alice:',
        '    name: Alice',
        '',
      ].join('\n'),
    );

    await Team.load();
    const compatibleAnthropicObjectProblem = getProblemsSnapshot().problems.find(
      (p) => p.id === 'team/team_yaml_error/member_defaults/model_params/invalid_ignored',
    );
    assert.ok(
      compatibleAnthropicObjectProblem &&
        compatibleAnthropicObjectProblem.kind === 'team_workspace_config_error',
      'anthropic-compatible namespace should reject object thinking while parsing',
    );

    await recordDiagnostic(
      'compatibleAnthropicObjectProblem',
      compatibleAnthropicObjectProblem,
      'An Anthropic-compatible thinking setting is given the incompatible object form.',
    );

    removeProblemsByPrefix('team/team_yaml_error/');
    await writeText(
      path.join(tmpRoot, '.minds', 'team.yaml'),
      [
        'member_defaults:',
        '  provider: volcano-engine-coding-plan',
        '  model: doubao-seed-2.0-code',
        'default_responder: alice',
        'members:',
        '  alice:',
        '    name: Alice',
        '    model_params:',
        '      anthropic-compatible:',
        '        thinking_budget_tokens: 512',
        '',
      ].join('\n'),
    );

    const teamUnsupportedAnthropicThinkingBudget = await Team.load();
    assert.equal(
      teamUnsupportedAnthropicThinkingBudget.getMember('alice')?.model_params,
      undefined,
      'unsupported anthropic thinking budget field should cause model_params to be ignored',
    );
    const unsupportedThinkingBudgetProblem = getProblemsSnapshot().problems.find(
      (p) =>
        p.id ===
        'team/team_yaml_error/members/alice/model_params/anthropic-compatible/unknown_fields',
    );
    assert.ok(
      unsupportedThinkingBudgetProblem &&
        unsupportedThinkingBudgetProblem.kind === 'team_workspace_config_error',
    );

    await recordDiagnostic(
      'unsupportedThinkingBudgetProblem',
      unsupportedThinkingBudgetProblem,
      'An unsupported Anthropic-compatible thinking-budget field is ignored.',
    );

    removeProblemsByPrefix('team/team_yaml_error/');
    await writeText(
      path.join(tmpRoot, '.minds', 'team.yaml'),
      [
        'member_defaults:',
        '  provider: codex',
        '  model: gpt-5.2',
        'default_responder: alice',
        'members:',
        '  alice:',
        '    name: Alice',
        '    model_params:',
        '      max_tokens: 123',
        '      codex:',
        '        max_tokens: 789',
        '',
      ].join('\n'),
    );

    const teamOnlyUnsupportedMaxTokens = await Team.load();
    assert.equal(
      teamOnlyUnsupportedMaxTokens.getMember('alice')?.model_params,
      undefined,
      'model_params with only unsupported max_tokens fields should be stripped completely',
    );

    // model_params.codex.web_search should accept disabled|cached|live and reject others.
    removeProblemsByPrefix('team/team_yaml_error/');
    await writeText(
      path.join(tmpRoot, '.minds', 'team.yaml'),
      [
        'member_defaults:',
        '  provider: codex',
        '  model: gpt-5.2',
        'default_responder: alice',
        'members:',
        '  alice:',
        '    name: Alice',
        '    model_params:',
        '      codex:',
        '        web_search: nope',
        '',
      ].join('\n'),
    );

    const teamWebSearch = await Team.load();
    assert.equal(
      teamWebSearch.getMember('alice')?.model_params,
      undefined,
      'invalid codex web_search mode should cause model_params to be ignored',
    );
    const snapshotWebSearch = getProblemsSnapshot();
    const aliceProblem = snapshotWebSearch.problems.find(
      (p) => p.id === 'team/team_yaml_error/members/alice/model_params/invalid_ignored',
    );
    assert.ok(aliceProblem && aliceProblem.kind === 'team_workspace_config_error');
    assert.equal(aliceProblem.severity, 'warning');

    await recordDiagnostic(
      'aliceProblem',
      aliceProblem,
      'Invalid Codex web_search mode is ignored.',
    );

    removeProblemsByPrefix('team/team_yaml_error/');
    await writeText(
      path.join(tmpRoot, '.minds', 'team.yaml'),
      [
        'member_defaults:',
        '  provider: codex',
        '  model: gpt-5.2',
        'default_responder: alice',
        'members:',
        '  alice:',
        '    name: Alice',
        '    fbr_model_params:',
        '      codex:',
        '        web_search: live',
        '',
      ].join('\n'),
    );

    const teamFbrWebSearch = await Team.load();
    assert.equal(
      teamFbrWebSearch.getMember('alice')?.fbr_model_params?.codex?.web_search,
      'live',
      'fbr_model_params should allow user override for codex web_search',
    );
    assert.ok(
      getProblemsSnapshot().problems.every((p) => !p.id.startsWith('team/team_yaml_error/')),
      'no team yaml errors expected for valid fbr_model_params.codex.web_search',
    );

    removeProblemsByPrefix('team/team_yaml_error/');
    await writeText(
      path.join(tmpRoot, '.minds', 'team.yaml'),
      [
        'member_defaults:',
        '  provider: openai',
        '  model: gpt-5.4',
        'default_responder: alice',
        'members:',
        '  alice:',
        '    name: Alice',
        '    fbr_model_params:',
        '      openai:',
        '        web_search_tool: true',
        '        web_search_context_size: high',
        '',
      ].join('\n'),
    );

    const teamFbrOpenAiWebSearch = await Team.load();
    assert.equal(
      teamFbrOpenAiWebSearch.getMember('alice')?.fbr_model_params?.openai?.web_search_tool,
      true,
      'fbr_model_params should allow user override for openai.web_search_tool',
    );
    assert.equal(
      teamFbrOpenAiWebSearch.getMember('alice')?.fbr_model_params?.openai?.web_search_context_size,
      'high',
      'fbr_model_params should allow Responses-native openai web search options',
    );
    assert.ok(
      getProblemsSnapshot().problems.every((p) => !p.id.startsWith('team/team_yaml_error/')),
      'no team yaml errors expected for valid fbr_model_params.openai.web_search_tool',
    );

    // model_params.json_response should be accepted at root as provider-agnostic config.
    removeProblemsByPrefix('team/team_yaml_error/');
    await writeText(
      path.join(tmpRoot, '.minds', 'team.yaml'),
      [
        'member_defaults:',
        '  provider: codex',
        '  model: gpt-5.2',
        'default_responder: alice',
        'members:',
        '  alice:',
        '    name: Alice',
        '    model_params:',
        '      json_response: true',
        '      codex:',
        '        json_response: false',
        '',
      ].join('\n'),
    );

    const teamJsonResponse = await Team.load();
    assert.equal(
      teamJsonResponse.getMember('alice')?.model_params?.json_response,
      true,
      'model_params.json_response root flag should be parsed',
    );
    assert.equal(
      teamJsonResponse.getMember('alice')?.model_params?.codex?.json_response,
      false,
      'provider-specific json_response should still be parsed',
    );
    assert.ok(
      getProblemsSnapshot().problems.every((p) => !p.id.startsWith('team/team_yaml_error/')),
      'no team yaml errors expected for valid model_params.json_response root usage',
    );

    // model_params.codex.service_tier should be accepted independently of reasoning_effort.
    removeProblemsByPrefix('team/team_yaml_error/');
    await writeText(
      path.join(tmpRoot, '.minds', 'team.yaml'),
      [
        'member_defaults:',
        '  provider: codex',
        '  model: gpt-5.4',
        'default_responder: alice',
        'members:',
        '  alice:',
        '    name: Alice',
        '    model_params:',
        '      codex:',
        '        service_tier: priority',
        '        reasoning_effort: high',
        '',
      ].join('\n'),
    );

    const teamServiceTier = await Team.load();
    assert.equal(
      teamServiceTier.getMember('alice')?.model_params?.codex?.service_tier,
      'priority',
      'model_params.codex.service_tier should be parsed',
    );
    assert.equal(
      teamServiceTier.getMember('alice')?.model_params?.codex?.reasoning_effort,
      'high',
      'service_tier should coexist with reasoning_effort',
    );
    assert.ok(
      getProblemsSnapshot().problems.every((p) => !p.id.startsWith('team/team_yaml_error/')),
      'no team yaml errors expected for valid model_params.codex.service_tier usage',
    );

    // GPT-5.6 exposes max inference effort beyond xhigh on the Codex and OpenAI paths.
    removeProblemsByPrefix('team/team_yaml_error/');
    await writeText(
      path.join(tmpRoot, '.minds', 'team.yaml'),
      [
        'member_defaults:',
        '  provider: codex',
        '  model: gpt-5.6-sol',
        'default_responder: alice',
        'members:',
        '  alice:',
        '    name: Alice',
        '    model_params:',
        '      codex:',
        '        reasoning_effort: max',
        '  bob:',
        '    name: Bob',
        '    provider: openai',
        '    model: gpt-5.6-terra',
        '    model_params:',
        '      openai:',
        '        reasoning_effort: max',
        '',
      ].join('\n'),
    );

    const teamGpt56 = await Team.load();
    assert.equal(teamGpt56.getMember('alice')?.model_params?.codex?.reasoning_effort, 'max');
    assert.equal(teamGpt56.getMember('bob')?.model_params?.openai?.reasoning_effort, 'max');
    assert.ok(
      getProblemsSnapshot().problems.every((p) => !p.id.startsWith('team/team_yaml_error/')),
      'no team yaml errors expected for GPT-5.6 reasoning effort levels',
    );

    // Codex Ultra is a client orchestration preset rather than an inference effort. Dominds has
    // its own provider-independent teammate coordination, so accepting Ultra here would imply a
    // behavior that this provider parameter cannot reproduce.
    removeProblemsByPrefix('team/team_yaml_error/');
    await writeText(
      path.join(tmpRoot, '.minds', 'team.yaml'),
      [
        'member_defaults:',
        '  provider: codex',
        '  model: gpt-5.6-sol',
        'default_responder: alice',
        'members:',
        '  alice:',
        '    name: Alice',
        '    model_params:',
        '      codex:',
        '        reasoning_effort: ultra',
        '',
      ].join('\n'),
    );

    const teamUltra = await Team.load();
    assert.equal(
      teamUltra.getMember('alice')?.model_params,
      undefined,
      'unsupported Codex Ultra should cause model_params to be ignored',
    );
    const ultraProblem = getProblemsSnapshot().problems.find(
      (p) => p.id === 'team/team_yaml_error/members/alice/model_params/invalid_ignored',
    );
    assert.ok(ultraProblem && ultraProblem.kind === 'team_workspace_config_error');
    assert.equal(ultraProblem.severity, 'warning');

    await recordDiagnostic(
      'ultraProblem',
      ultraProblem,
      'An unsupported reasoning effort is ignored; provider inference effort must not promise teammate orchestration.',
    );

    // shell_specialists policy:
    // - must list the only members allowed to have shell tools
    // - should surface misconfig as Problems without breaking Team.load()
    // - at runtime, non-specialists must not receive shell tools
    removeProblemsByPrefix('team/team_yaml_error/');
    await writeText(
      path.join(tmpRoot, '.minds', 'team.yaml'),
      [
        'member_defaults:',
        '  provider: openai',
        '  model: gpt-5.4',
        'default_responder: alice',
        'shell_specialists: cmdr',
        'members:',
        '  alice:',
        '    name: Alice',
        '    toolsets: [os]',
        '  cmdr:',
        '    name: Commander',
        '    toolsets: [os]',
        '',
      ].join('\n'),
    );

    const team3 = await Team.load();
    assert.ok(team3.getMember('alice'), 'alice should be loaded');
    assert.ok(team3.getMember('cmdr'), 'cmdr should be loaded');
    assert.deepEqual(team3.shellSpecialists, ['cmdr']);

    const snapshot3 = getProblemsSnapshot();
    assert.ok(
      snapshot3.problems.some(
        (p) =>
          p.id === 'team/team_yaml_error/shell_specialists/non_specialist_has_shell_tools/alice',
      ),
      'problem for alice having shell tools without being in shell_specialists should exist',
    );
    assert.ok(
      !snapshot3.problems.some((p) => {
        const prefix =
          'team/team_yaml_error/shell_specialists/non_specialist_has_shell_tools/' as const;
        if (!p.id.startsWith(prefix)) return false;
        const memberId = p.id.slice(prefix.length);
        const member = team3.getMember(memberId);
        return member !== undefined && member.hidden === true;
      }),
      'hidden members should not be validated by shell_specialists policy',
    );
    {
      const problem = snapshot3.problems.find(
        (p) =>
          p.id === 'team/team_yaml_error/shell_specialists/non_specialist_has_shell_tools/alice',
      );
      assert.ok(problem, 'shell-specialist policy problem should be present for alice');
      assert.equal(problem.severity, 'warning');
      await recordDiagnostic(
        'shell-specialist-warning',
        problem,
        'Alice has shell tools configured but cmdr alone is the shell specialist; Alice must retain non-shell work and delegate shell execution.',
      );
    }

    {
      const { systemPrompt, agentTools } = await loadAgentMinds('alice');
      const toolNames = agentTools
        .filter((t) => t.type === 'func')
        .map((t) => t.name)
        .sort();

      assert.ok(!toolNames.includes('shell_cmd'), 'alice should not receive shell_cmd');
      assert.ok(!toolNames.includes('stop_daemon'), 'alice should not receive stop_daemon');
      assert.ok(
        !toolNames.includes('get_daemon_output'),
        'alice should not receive get_daemon_output',
      );
      if (semantic) {
        cases.push({
          id: 'shell-specialist-system-prompt',
          scenario:
            'Alice requests os tools but only cmdr is a shell specialist. Alice must delegate shell work.',
          businessValue:
            'Keep shell authority restricted while giving the non-specialist a useful collaboration path.',
          context: {
            language: 'en',
            teamYaml: await fs.readFile(path.join(tmpRoot, '.minds/team.yaml'), 'utf8'),
            actualToolNames: JSON.stringify(toolNames),
          },
          reviewQuestions: [
            'Does the full prompt make the configured shell specialist discoverable without implying Alice has shell execution authority?',
            'Is the collaboration and memory guidance coherent with this actual capability set?',
          ],
          actualText: systemPrompt,
        });
      }
    }

    {
      const { agentTools } = await loadAgentMinds('cmdr');
      const toolNames = agentTools
        .filter((t) => t.type === 'func')
        .map((t) => t.name)
        .sort();

      assert.ok(toolNames.includes('shell_cmd'), 'cmdr should receive shell_cmd');
    }

    removeProblemsByPrefix('team/team_yaml_error/');
    await writeText(
      path.join(tmpRoot, '.minds', 'team.yaml'),
      [
        'member_defaults:',
        '  provider: openai',
        '  model: gpt-5.4',
        'default_responder: alice',
        'members:',
        '  alice:',
        '    name: Alice',
        '    toolsets: [os]',
        '',
      ].join('\n'),
    );

    const teamNoSpecialist = await Team.load();
    assert.ok(
      teamNoSpecialist.getMember('alice'),
      'alice should still be loaded without shell_specialists',
    );

    const noSpecialistSnapshot = getProblemsSnapshot();
    const noSpecialistProblem = noSpecialistSnapshot.problems.find(
      (p) => p.id === 'team/team_yaml_error/shell_specialists/forbidden_member/alice',
    );
    assert.ok(noSpecialistProblem, 'missing shell_specialists should remain an error');
    assert.equal(noSpecialistProblem.severity, 'error');

    await recordDiagnostic(
      'noSpecialistProblem',
      noSpecialistProblem,
      'A member requests shell tools but no shell specialist is configured.',
    );

    // gofor should preserve string/object forms, and structured list form should remain allowed
    // while surfacing a warning that object form is clearer for labeled entries.
    removeProblemsByPrefix('team/team_yaml_error/');
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
        'default_responder: coordinator',
        'members:',
        '  coordinator:',
        '    name: Coordinator',
        '    gofor:',
        '      Scope: oversee the team',
        '      Deliverables: planning and integration',
        '  reviewer:',
        '    name: Reviewer',
        '    gofor: keep reviews focused',
        '    nogo:',
        '      Avoid: net-new feature implementation',
        '      RouteTo: runtime or product specialists',
        '  listed:',
        '    name: Listed',
        '    gofor:',
        '      - Scope: triage incoming work',
        '      - Deliverables: handoff notes',
        '    nogo:',
        '      - Avoid: direct implementation asks',
        '      - RouteTo: the owning specialist',
        '  bullety:',
        '    name: Bullety',
        '    gofor:',
        '      - investigate flaky tests',
        '      - capture logs',
        '',
      ].join('\n'),
    );

    const goforTeam = await Team.load();
    assert.deepEqual(goforTeam.getMember('coordinator')?.gofor, {
      Scope: 'oversee the team',
      Deliverables: 'planning and integration',
    });
    assert.equal(goforTeam.getMember('reviewer')?.gofor, 'keep reviews focused');
    assert.deepEqual(goforTeam.getMember('reviewer')?.nogo, {
      Avoid: 'net-new feature implementation',
      RouteTo: 'runtime or product specialists',
    });
    assert.deepEqual(goforTeam.getMember('listed')?.gofor, [
      'Scope: triage incoming work',
      'Deliverables: handoff notes',
    ]);
    assert.deepEqual(goforTeam.getMember('listed')?.nogo, [
      'Avoid: direct implementation asks',
      'RouteTo: the owning specialist',
    ]);

    const goforSnapshot = getProblemsSnapshot();
    const structuredListWarning = goforSnapshot.problems.find(
      (p) => p.id === 'team/team_yaml_error/members/listed/gofor/prefer_object_for_labeled_entries',
    );
    assert.ok(
      structuredListWarning && structuredListWarning.kind === 'team_workspace_config_error',
      'structured gofor list should surface a warning problem',
    );
    assert.equal(structuredListWarning.severity, 'warning');
    const nogoStructuredListWarning = goforSnapshot.problems.find(
      (p) => p.id === 'team/team_yaml_error/members/listed/nogo/prefer_object_for_labeled_entries',
    );
    assert.ok(
      nogoStructuredListWarning && nogoStructuredListWarning.kind === 'team_workspace_config_error',
      'structured nogo list should surface a warning problem',
    );
    assert.equal(nogoStructuredListWarning.severity, 'warning');
    assert.ok(
      goforSnapshot.problems.every(
        (p) =>
          p.id !== 'team/team_yaml_error/members/bullety/gofor/prefer_object_for_labeled_entries',
      ),
      'plain gofor bullet lists should not warn',
    );

    await recordDiagnostic(
      'structuredListWarning',
      structuredListWarning,
      'Labeled gofor list entries are accepted, with advice to prefer a mapping.',
    );

    await recordDiagnostic(
      'nogoStructuredListWarning',
      nogoStructuredListWarning,
      'Labeled nogo list entries are accepted, with advice to prefer a mapping.',
    );

    // Optional routing-card fields set to YAML null should warn but must not drop the member.
    removeProblemsByPrefix('team/team_yaml_error/');
    await writeText(
      path.join(tmpRoot, '.minds', 'team.yaml'),
      [
        'member_defaults:',
        '  provider: stub',
        '  model: fake_model',
        'default_responder: mentor',
        'members:',
        '  mentor:',
        '    name: Mentor',
        '    nogo: null',
        '',
      ].join('\n'),
    );

    const nullRoutingTeam = await Team.load();
    assert.ok(nullRoutingTeam.getMember('mentor'), 'mentor should still be loaded');
    assert.equal(
      nullRoutingTeam.getMember('mentor')?.nogo,
      undefined,
      'null nogo should be ignored as unset',
    );
    const mentorMinds = await loadAgentMinds('mentor');
    assert.equal(mentorMinds.agent.id, 'mentor', 'mentor should remain selectable for dialogs');

    const nullRoutingSnapshot = getProblemsSnapshot();
    const nullRoutingWarning = nullRoutingSnapshot.problems.find(
      (p) => p.id === 'team/team_yaml_error/members/mentor/nogo/null_ignored',
    );
    assert.ok(
      nullRoutingWarning && nullRoutingWarning.kind === 'team_workspace_config_error',
      'null nogo should surface a warning problem',
    );
    assert.equal(nullRoutingWarning.severity, 'warning');

    await recordDiagnostic(
      'nullRoutingWarning',
      nullRoutingWarning,
      'YAML null is ignored for the optional nogo routing card without dropping the member.',
    );

    // Optional display/tuning/tooling fields with bad values should warn and be ignored rather
    // than dropping the member.
    removeProblemsByPrefix('team/team_yaml_error/');
    await writeText(
      path.join(tmpRoot, '.minds', 'team.yaml'),
      [
        'member_defaults:',
        '  provider: stub',
        '  model: fake_model',
        '  fbr-effort: slow',
        '  icon: {}',
        'default_responder: helper',
        'members:',
        '  helper:',
        '    name: 123',
        '    toolsets: ws_read',
        '    tools: shell_cmd',
        '    model_params: nope',
        '    fbr_model_params: nope',
        '    diligence-push-max: nope',
        '    streaming: nope',
        '    hidden: nope',
        '    icon: [robot]',
        '',
      ].join('\n'),
    );

    const softenedTeam = await Team.load();
    const helper = softenedTeam.getMember('helper');
    assert.ok(helper, 'helper should still be loaded');
    assert.equal(helper?.name, 'helper', 'invalid name should fall back to member id');
    assert.equal(helper?.toolsets, undefined, 'invalid toolsets should be ignored');
    assert.equal(helper?.tools, undefined, 'invalid tools should be ignored');
    assert.equal(helper?.model_params, undefined, 'invalid model_params should be ignored');
    assert.equal(
      helper?.fbr_model_params?.codex?.web_search,
      'disabled',
      'invalid fbr_model_params should fall back to inherited defaults',
    );
    assert.equal(helper?.diligence_push_max, undefined, 'invalid diligence cap should be ignored');
    assert.equal(helper?.streaming, undefined, 'invalid streaming should be ignored');
    assert.equal(helper?.hidden, undefined, 'invalid hidden should be ignored');
    assert.equal(helper?.icon, undefined, 'invalid icon should be ignored');
    assert.equal(
      softenedTeam.memberDefaults.fbr_effort,
      3,
      'invalid member_defaults fbr-effort should preserve bootstrap default',
    );
    assert.equal(
      softenedTeam.memberDefaults.icon,
      undefined,
      'invalid member_defaults icon should be ignored',
    );
    const helperMinds = await loadAgentMinds('helper');
    assert.equal(helperMinds.agent.id, 'helper', 'helper should remain selectable for dialogs');

    const softenedSnapshot = getProblemsSnapshot();
    const expectedSoftWarnings = [
      'team/team_yaml_error/member_defaults/fbr-effort/invalid_ignored',
      'team/team_yaml_error/member_defaults/icon/invalid_ignored',
      'team/team_yaml_error/members/helper/name/invalid_ignored',
      'team/team_yaml_error/members/helper/toolsets/invalid_ignored',
      'team/team_yaml_error/members/helper/tools/invalid_ignored',
      'team/team_yaml_error/members/helper/model_params/invalid_ignored',
      'team/team_yaml_error/members/helper/fbr_model_params/invalid_ignored',
      'team/team_yaml_error/members/helper/diligence-push-max/invalid_ignored',
      'team/team_yaml_error/members/helper/streaming/invalid_ignored',
      'team/team_yaml_error/members/helper/hidden/invalid_ignored',
      'team/team_yaml_error/members/helper/icon/invalid_ignored',
    ];
    for (const problemId of expectedSoftWarnings) {
      const problem = softenedSnapshot.problems.find((p) => p.id === problemId);
      assert.ok(problem, `expected warning problem ${problemId}`);
      assert.equal(problem?.severity, 'warning');
    }
    assert.ok(
      softenedSnapshot.problems.every((p) => p.id !== 'team/team_yaml_error/members/helper'),
      'soft-invalid optional fields should not escalate into a member-dropping error',
    );

    removeProblemsByPrefix('team/team_yaml_error/');
    await writeText(
      path.join(tmpRoot, '.minds', 'team.yaml'),
      [
        'member_defaults:',
        '  provider: stub',
        '  model: fake_model',
        'default_responder: helper',
        'members:',
        '  helper:',
        '    name: Helper',
        '    toolsets: [control]',
        '',
      ].join('\n'),
    );
    await Team.load();
    const intrinsicToolsetSnapshot = getProblemsSnapshot();
    const intrinsicToolsetProblem = intrinsicToolsetSnapshot.problems.find(
      (p) => p.id === 'team/team_yaml_error/members/helper/toolsets/control/not_assignable',
    );
    assert.ok(intrinsicToolsetProblem, 'control toolset assignment should surface a problem');
    assert.equal(intrinsicToolsetProblem?.severity, 'error');

    await recordDiagnostic(
      'intrinsicToolsetProblem',
      intrinsicToolsetProblem,
      'The intrinsic control toolset is not assignable through member toolsets.',
    );

    // Provider/model bindings:
    // - member_defaults.model must exist under the selected provider's models list.
    // - member overrides (provider/model) must remain consistent after prototype defaults.

    removeProblemsByPrefix('team/team_yaml_error/');
    await writeText(
      path.join(tmpRoot, '.minds', 'llm.yaml'),
      [
        'providers:',
        '  my_provider:',
        '    name: My Provider',
        '    apiType: openai',
        '    baseUrl: https://example.invalid',
        '    apiKeyEnvVar: MY_PROVIDER_API_KEY',
        '    models:',
        '      good_model: { name: "good-model" }',
        '',
      ].join('\n'),
    );
    await writeText(
      path.join(tmpRoot, '.minds', 'team.yaml'),
      [
        'member_defaults:',
        '  provider: my_provider',
        '  model: bad_model',
        'default_responder: alice',
        'members:',
        '  alice:',
        '    name: Alice',
        '    toolsets: [ws_read]',
        '',
      ].join('\n'),
    );

    const team4 = await Team.load();
    assert.ok(team4.getMember('alice'), 'alice should be loaded');

    const snapshot4 = getProblemsSnapshot();
    assert.ok(
      snapshot4.problems.some((p) => p.id === 'team/team_yaml_error/member_defaults/model/unknown'),
      'problem for member_defaults model binding should exist',
    );
    {
      const p = snapshot4.problems.find(
        (p2) => p2.id === 'team/team_yaml_error/member_defaults/model/unknown',
      );
      assert.ok(p && p.kind === 'team_workspace_config_error');
      assert.equal(p.detail.filePath, '.minds/team.yaml');
      await recordDiagnostic(
        p.id.replaceAll('/', '-'),
        p,
        'The configured model is absent from its provider catalog; the otherwise valid member remains loaded.',
      );
    }

    // Model binding issues should be detected for member overrides, too.
    removeProblemsByPrefix('team/team_yaml_error/');
    await writeText(
      path.join(tmpRoot, '.minds', 'team.yaml'),
      [
        'member_defaults:',
        '  provider: my_provider',
        '  model: good_model',
        'default_responder: alice',
        'members:',
        '  alice:',
        '    name: Alice',
        '    model: bad_model',
        '    toolsets: [ws_read]',
        '',
      ].join('\n'),
    );

    const team5 = await Team.load();
    assert.ok(team5.getMember('alice'), 'alice should be loaded');

    const snapshot5 = getProblemsSnapshot();
    assert.ok(
      snapshot5.problems.some((p) => p.id === 'team/team_yaml_error/members/alice/model/unknown'),
      'problem for members.alice model binding should exist',
    );
    {
      const p = snapshot5.problems.find(
        (p2) => p2.id === 'team/team_yaml_error/members/alice/model/unknown',
      );
      assert.ok(p && p.kind === 'team_workspace_config_error');
      assert.equal(p.detail.filePath, '.minds/team.yaml');
      await recordDiagnostic(
        'member-model-unknown',
        p,
        'A member model override is absent from its provider catalog; the otherwise valid member remains loaded.',
      );
    }

    // Invalid providers.<k>.models shape should be reported against llm.yaml.
    removeProblemsByPrefix('team/team_yaml_error/');
    await writeText(
      path.join(tmpRoot, '.minds', 'llm.yaml'),
      [
        'providers:',
        '  broken_provider:',
        '    name: Broken Provider',
        '    apiType: openai',
        '    baseUrl: https://example.invalid',
        '    apiKeyEnvVar: BROKEN_PROVIDER_API_KEY',
        '    models: []',
        '',
      ].join('\n'),
    );
    await writeText(
      path.join(tmpRoot, '.minds', 'team.yaml'),
      [
        'member_defaults:',
        '  provider: broken_provider',
        '  model: any_model',
        'default_responder: alice',
        'members:',
        '  alice:',
        '    name: Alice',
        '    toolsets: [ws_read]',
        '',
      ].join('\n'),
    );

    const team6 = await Team.load();
    assert.ok(team6.getMember('alice'), 'alice should be loaded');

    const snapshot6 = getProblemsSnapshot();
    assert.ok(
      snapshot6.problems.some(
        (p) => p.id === 'team/team_yaml_error/member_defaults/provider/models/invalid',
      ),
      'problem for providers.<k>.models invalid shape should exist',
    );
    {
      const p = snapshot6.problems.find(
        (p2) => p2.id === 'team/team_yaml_error/member_defaults/provider/models/invalid',
      );
      assert.ok(p && p.kind === 'team_workspace_config_error');
      assert.equal(p.detail.filePath, '.minds/llm.yaml');
      await recordDiagnostic(
        'invalid-provider-models',
        p,
        'A provider models value is a list rather than a mapping; the team member remains loaded.',
      );
    }
  }
  if (semantic) await writeSemanticEvidence(cases, 'dominds-team-guidance-');
  else console.log('team-yaml-parsing behavior tests passed');
}

void main();
