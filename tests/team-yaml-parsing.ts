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
    assert.ok(bobProblem.detail.errorText.includes('members.bob.provider'));

    const charlieProblem = snapshot.problems.find(
      (p) => p.id === 'team/team_yaml_error/members/charlie',
    );
    assert.ok(charlieProblem && charlieProblem.kind === 'team_workspace_config_error');
    assert.ok(charlieProblem.detail.errorText.includes('members.charlie'));

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
      assert.equal(
        problem.messageI18n?.zh,
        '.minds/team.yaml 警告：有成员不是 shell 专员，但在已有其他 shell 专员时也配置了 shell 工具。',
      );
      assert.ok(
        problem.detailTextI18n?.zh?.includes('团队里已经配置了其他 shell 专员（cmdr）'),
        'shell-specialist problem detail should be localized in zh',
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
      const hasShellSpecialistLine =
        systemPrompt.includes('Shell specialists in this team: @cmdr') ||
        systemPrompt.includes('Shell specialists you can tellask: @cmdr') ||
        systemPrompt.includes('Shell specialist teammates: @cmdr');
      assert.ok(
        hasShellSpecialistLine,
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
    assert.equal(
      noSpecialistProblem.messageI18n?.zh,
      '无效的 .minds/team.yaml：已经配置了 shell 工具，但没有配置任何 shell 专员。',
    );
    assert.ok(
      noSpecialistProblem.detailTextI18n?.zh?.includes('但团队里没有其他 shell 专员'),
      'missing shell_specialists detail should explain there is no other shell specialist',
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
    assert.equal(
      structuredListWarning.messageI18n?.en,
      'Warning in .minds/team.yaml: members.listed.gofor uses a YAML list for labeled entries.',
    );
    assert.equal(
      structuredListWarning.messageI18n?.zh,
      '.minds/team.yaml 警告：members.listed.gofor 使用了带标签项的 YAML 列表。',
    );
    assert.ok(
      structuredListWarning.detailTextI18n?.zh?.includes('对象键名可以自由填写'),
      'team problem should carry zh localized detail text from backend',
    );
    assert.ok(
      structuredListWarning.detailTextI18n?.zh?.includes('YAML 对象写法'),
      'structured list guidance should read naturally in zh',
    );
    assert.ok(structuredListWarning.detail.errorText.includes('Object keys are freeform'));
    const nogoStructuredListWarning = goforSnapshot.problems.find(
      (p) => p.id === 'team/team_yaml_error/members/listed/nogo/prefer_object_for_labeled_entries',
    );
    assert.ok(
      nogoStructuredListWarning && nogoStructuredListWarning.kind === 'team_workspace_config_error',
      'structured nogo list should surface a warning problem',
    );
    assert.equal(nogoStructuredListWarning.severity, 'warning');
    assert.equal(
      nogoStructuredListWarning.messageI18n?.en,
      'Warning in .minds/team.yaml: members.listed.nogo uses a YAML list for labeled entries.',
    );
    assert.ok(
      goforSnapshot.problems.every(
        (p) =>
          p.id !== 'team/team_yaml_error/members/bullety/gofor/prefer_object_for_labeled_entries',
      ),
      'plain gofor bullet lists should not warn',
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
    assert.equal(
      nullRoutingWarning.messageI18n?.en,
      'Warning in .minds/team.yaml: members.mentor.nogo is null and will be ignored.',
    );
    assert.equal(
      nullRoutingWarning.messageI18n?.zh,
      '.minds/team.yaml 警告：members.mentor.nogo 写成了 null，这一项会被忽略。',
    );
    assert.ok(
      nullRoutingWarning.detail.errorText.includes(
        'members.mentor.nogo uses YAML null. Dominds treats this as "unset" and ignores it;',
      ),
      'warning detail should explain the ignore-as-unset behavior',
    );
    assert.equal(
      nullRoutingWarning.detailTextI18n?.zh,
      'members.mentor.nogo 这里写成了 YAML null。Dominds 会把它当作“没设置”，所以不会生效；请删除这个字段，或改成合法值。',
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
    assert.ok(
      intrinsicToolsetProblem?.detail.errorText.includes(
        "but 'control' is injected by Dominds at runtime according to dialog scope",
      ),
    );

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
      assert.equal(
        p.messageI18n?.zh,
        "无效的 .minds/team.yaml：members.alice.model 不在 provider 'my_provider' 的模型列表里。",
      );
      assert.ok(
        p.detailTextI18n?.zh?.includes('已知模型 key（预览）'),
        'provider/model problem detail should be localized in zh',
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
      assert.ok(p.detail.errorText.includes('providers.broken_provider.models'));
    }
  } finally {
    process.chdir(oldCwd);
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

void main();
