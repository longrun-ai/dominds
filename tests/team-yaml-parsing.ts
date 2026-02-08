import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadAgentMinds } from '../main/minds/load';
import { getProblemsSnapshot, removeProblemsByPrefix } from '../main/problems';
import { Team } from '../main/team';
import '../main/tools/builtins';

async function writeText(p: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content, 'utf-8');
}

async function main(): Promise<void> {
  const oldCwd = process.cwd();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-team-yaml-'));

  try {
    process.chdir(tmpRoot);

    removeProblemsByPrefix('team/team_yaml_error/');

    await writeText(
      path.join(tmpRoot, '.minds', 'team.yaml'),
      [
        'member_defaults:',
        '  provider: openai',
        '  model: gpt-4',
        'default_responder: alice',
        'members:',
        '  alice:',
        '    name: Alice',
        '    toolsets: [ws_read]',
        '  bob:',
        '    name: 123',
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
      team.getMember('alice')?.fbr_model_params?.codex?.web_search,
      'disabled',
      'member should inherit default fbr codex.web_search=disabled',
    );
    assert.equal(
      team.getMember('alice')?.fbr_model_params?.openai?.web_search,
      'disabled',
      'member should inherit default fbr openai.web_search=disabled',
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
    assert.ok(bobProblem.detail.errorText.includes('members.bob.name'));
    assert.ok(bobProblem.detail.errorText.includes('members.bob.toolsets'));

    const charlieProblem = snapshot.problems.find(
      (p) => p.id === 'team/team_yaml_error/members/charlie',
    );
    assert.ok(charlieProblem && charlieProblem.kind === 'team_workspace_config_error');
    assert.ok(charlieProblem.detail.errorText.includes('members.charlie'));

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
    assert.ok(mdUnknown.detail.errorText.includes('member_defaults.reasoning_effort'));
    assert.ok(
      mdUnknown.detail.errorText.includes('member_defaults.model_params.codex.reasoning_effort'),
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
      teamWebSearch.getMember('alice'),
      undefined,
      'alice should be omitted due to invalid codex web_search mode',
    );
    const snapshotWebSearch = getProblemsSnapshot();
    const aliceProblem = snapshotWebSearch.problems.find(
      (p) => p.id === 'team/team_yaml_error/members/alice',
    );
    assert.ok(aliceProblem && aliceProblem.kind === 'team_workspace_config_error');
    assert.ok(
      aliceProblem.detail.errorText.includes('members.alice.model_params.codex.web_search'),
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

    // shell_specialists policy:
    // - must list the only members allowed to have shell tools
    // - should surface misconfig as Problems (fail-open runtime)
    // - at runtime, non-specialists must not receive shell tools
    removeProblemsByPrefix('team/team_yaml_error/');
    await writeText(
      path.join(tmpRoot, '.minds', 'team.yaml'),
      [
        'member_defaults:',
        '  provider: openai',
        '  model: gpt-4',
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
      assert.ok(
        systemPrompt.includes('Shell specialist teammates: @cmdr'),
        'system prompt should point to the configured shell specialist',
      );
      assert.ok(
        systemPrompt.includes('### Memory System (Important)'),
        'system prompt should include the memory system guidance',
      );
    }

    {
      const { agentTools } = await loadAgentMinds('cmdr');
      const toolNames = agentTools
        .filter((t) => t.type === 'func')
        .map((t) => t.name)
        .sort();

      assert.ok(toolNames.includes('shell_cmd'), 'cmdr should receive shell_cmd');
    }

    console.log('✅ team-yaml-parsing tests passed');

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
      assert.ok(p.detail.errorText.includes('providers.my_provider.models.bad_model'));
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
      assert.ok(p.detail.errorText.includes('providers.my_provider.models.bad_model'));
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
      assert.ok(p.detail.errorText.includes('providers.broken_provider.models'));
    }
  } finally {
    process.chdir(oldCwd);
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

void main();
