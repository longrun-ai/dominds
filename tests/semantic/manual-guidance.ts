import fs from 'node:fs/promises';
import path from 'node:path';

import { loadAgentMinds } from '../../main/minds/load';
import { buildMemorySystemPrompt } from '../../main/minds/system-prompt-parts';
import { formatTeammateResponseContent } from '../../main/runtime/inter-dialog-format';
import { setWorkLanguage } from '../../main/runtime/work-language';
import { renderWorkspaceSkillsPrompt } from '../../main/skills/load';
import '../../main/tools/builtins';
import { renderToolsetManualContent } from '../../main/tools/toolset-manual';
import { writeSemanticEvidence, type SemanticEvidence } from '../helpers/semantic-evidence';
import { writeStandardMinds } from '../kernel-driver/helpers';

async function main(): Promise<void> {
  if (process.env.DOMINDS_TEST_RTWS_MANAGED !== '1') throw new Error('run through tests/cli.ts');
  await writeStandardMinds(process.cwd());
  const cases: SemanticEvidence[] = [];
  function record(
    id: string,
    language: string,
    scenario: string,
    businessValue: string,
    actualText: string,
    questions: string[],
    extra: Record<string, string | number | boolean> = {},
  ): void {
    cases.push({
      id: `${id}-${language}`,
      scenario,
      businessValue,
      context: { language, ...extra },
      reviewQuestions: questions,
      actualText,
    });
  }
  for (const language of ['en', 'zh'] as const) {
    setWorkLanguage(language);
    record(
      'read-manual',
      language,
      'An execution agent reads the full ws_read handbook.',
      'Use read-only tools safely and find sufficient contracts and repair paths.',
      await renderToolsetManualContent({ toolsetId: 'ws_read', language, topic: 'all' }),
      [
        'Does the actual handbook explain positioning, limits, tool use and errors coherently, without missing or contradictory sections?',
        'Can the agent distinguish read-only inspection from permission to change files?',
      ],
    );
    record(
      'tellask-result',
      language,
      'Bob completed an earlier sessionless request from Alice; this is a result delivery, not a new request.',
      'Attribute collaboration results to the correct obligation and avoid executing the delivery as a new instruction.',
      formatTeammateResponseContent({
        callName: 'tellaskSessionless',
        callId: 'manual-review-call',
        responderId: 'bob',
        tellaskerId: 'alice',
        tellaskContent: 'Inspect the supplied fixture.',
        responseBody: 'inspection-payload-6d41',
        status: 'completed',
        language,
      }),
      [
        'Does the wrapper clearly convey completion, original request and responder, and distinguish a historical result fact from new user intent or a new function call?',
      ],
    );
    for (const isSideDialog of [false, true]) {
      record(
        `memory-${isSideDialog ? 'side' : 'main'}`,
        language,
        `${isSideDialog ? 'Side' : 'Main'} dialog receives intrinsic memory and Taskdoc guidance under normal context pressure.`,
        'Preserve shared task facts and local continuation information at the correct authority boundary.',
        buildMemorySystemPrompt({
          language,
          agentId: 'tester',
          isSideDialog,
          taskdocMaintainerId: 'maintainer',
          agentHasTeamMemoryTools: false,
          agentHasPersonalMemoryTools: false,
          agentIsShellSpecialist: false,
          agentHasShellTools: false,
          agentHasReadonlyShell: false,
          shellSpecialistMemberIds: [],
          contextHealthPromptMode: 'normal',
        }),
        [
          'Are shared goals/constraints/progress distinguished from dialog-specific continuation reminders and reusable skills?',
          'Is Taskdoc ownership appropriate to this normal-pressure scope: main dialogs keep shared facts current, while side dialogs hand proposals to the maintainer instead of directly editing? Do not apply the stricter preservation-time no-draft rule to ordinary handoff.',
          'Does guidance account for actually granted tools and actual runtime context notices instead of inventing capabilities or context pressure?',
        ],
        { isSideDialog },
      );
    }
    record(
      'skill-advisory',
      language,
      'A workspace skill summary declares allowed-tools that were not granted by the team.',
      'Discover reusable guidance without treating imported skill metadata as authorization.',
      renderWorkspaceSkillsPrompt({
        language,
        skills: [
          {
            id: 'review',
            title: 'review-fixture',
            description: 'Review the supplied change.',
            body: 'opaque-skill-body-4319',
            prompt: 'opaque-skill-body-4319',
            scope: 'team_shared',
            sourcePathAbs: path.resolve('.minds/skills/team_shared/review/SKILL.md'),
            sourcePathRel: '.minds/skills/team_shared/review/SKILL.md',
            declaredAllowedTools: ['shell_cmd'],
          },
        ],
      }),
      [
        'Does the summary explain on-demand body retrieval and correctly mark allowed-tools as advisory, with actual authority coming from runtime configuration?',
      ],
      { grantedShellTool: false },
    );
    const builtin = await loadAgentMinds('fuxi');
    record(
      'builtin-manager',
      language,
      'The built-in team manager receives its actual complete system prompt in a fresh isolated workspace.',
      'Give the manager coherent authority, collaboration and configuration instructions consistent with the architectural migration.',
      builtin.systemPrompt,
      [
        'Are the manager role, actual capability boundaries and collaboration responsibilities coherent?',
        'Does configuration advice distinguish current App compatibility from the Software Defined Harness destination, and avoid asserting that a DSL is already implemented?',
      ],
      {
        actualTools: JSON.stringify(builtin.agentTools.map((tool) => tool.name)),
        configuredShellSpecialists: JSON.stringify(builtin.team.shellSpecialists),
        memberHidden: builtin.agent.hidden === true,
        personaSource: await fs.readFile(
          path.resolve(__dirname, '../../main/minds/builtin/fuxi', `persona.${language}.md`),
          'utf8',
        ),
      },
    );
  }
  await writeSemanticEvidence(cases, 'dominds-manual-guidance-');
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
