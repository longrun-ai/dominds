import { DILIGENCE_FALLBACK_TEXT } from '@longrun-ai/kernel/diligence';

import {
  formatAgentFacingContextHealthV3RemediationGuide,
  formatAgentFacingCriticalUserInterjectionRemediationGuide,
  formatDiligenceAutoContinuePrompt,
  formatNewCourseStartPrompt,
} from '../../main/runtime/driver-messages';
import '../../main/tools/builtins';
import { renderTeamMgmtGuideContent } from '../../main/tools/team_mgmt-manual';
import { collectBudgetExhaustion } from '../helpers/budget-exhaustion-fixture';
import { writeSemanticEvidence, type SemanticEvidence } from '../helpers/semantic-evidence';

async function main(): Promise<void> {
  const cases: SemanticEvidence[] = [];
  for (const language of ['zh', 'en'] as const) {
    for (const dialogScope of ['mainDialog', 'sideDialog'] as const) {
      for (const remaining of [null, 4, 0]) {
        cases.push({
          id: `preserve-${language}-${dialogScope}-${remaining === null ? 'caution' : `critical-${remaining}`}`,
          scenario:
            'An active dialog is at risk of losing useful context and needs a continuation package.',
          businessValue:
            'Preserve the current dialog goal and facts without drifting into other work or exceeding its authority.',
          context: {
            language,
            dialogScope,
            level: remaining === null ? 'caution' : 'critical',
            promptsRemainingAfterThis: remaining ?? 'not applicable',
            promptsTotal: 5,
          },
          reviewQuestions: [
            'Does the guidance make preservation actionable without presenting the runtime notice as a new human request or encouraging an empty acknowledgment?',
            'Does it preserve this dialog goal and enough continuation detail, and place cleanup at the appropriate course rather than demand premature compression?',
            'Does a main dialog distinguish shared Taskdoc facts from dialog-specific reminders, while a side dialog avoids changing or drafting shared Taskdoc updates during preservation?',
            'For critical cases, is the remaining allowance and impending course transition understandable for the supplied state?',
          ],
          actualText:
            remaining === null
              ? formatAgentFacingContextHealthV3RemediationGuide(language, {
                  kind: 'caution',
                  mode: 'soft',
                  dialogScope,
                })
              : formatAgentFacingContextHealthV3RemediationGuide(language, {
                  kind: 'critical',
                  mode: 'countdown',
                  dialogScope,
                  promptsRemainingAfterThis: remaining,
                  promptsTotal: 5,
                }),
        });
      }
      cases.push({
        id: `interjection-${language}-${dialogScope}`,
        scenario: 'A real user message arrives while context is critical.',
        businessValue:
          'Respond to the user rather than silently discarding the message during context preservation.',
        context: { language, dialogScope, promptsRemainingAfterThis: 4 },
        reviewQuestions: [
          'Does the agent understand that the current user input is effective and needs an actual response, including a response after any necessary tool result?',
          'Does preservation follow the response while respecting main/side Taskdoc boundaries and the supplied remaining allowance?',
          'Does the text avoid assuming a particular visual adjacency between this notice and the actual user message?',
        ],
        actualText: formatAgentFacingCriticalUserInterjectionRemediationGuide(language, {
          dialogScope,
          promptsRemainingAfterThis: 4,
        }),
      });
    }
    for (const source of ['clear_mind', 'critical_auto_clear'] as const) {
      cases.push({
        id: `new-course-${language}-${source}`,
        scenario:
          'A new course has actually started, either voluntarily or after critical context.',
        businessValue:
          'Resume the correct task instead of remaining stuck in prior-course preservation or unnecessary memory maintenance.',
        context: { language, source, nextCourse: 2 },
        reviewQuestions: [
          'Is the course transition distinguished from a new human request, and are previous-course pressure records treated as resolved?',
          'Can a main or side dialog find its own goal and continuation information without borrowing another dialog goal from a shared Taskdoc?',
          'Does cleanup correct stale or distorted continuation information when needed without requiring churn when the package is already adequate?',
        ],
        actualText: formatNewCourseStartPrompt(language, { nextCourse: 2, source }),
      });
    }
    cases.push({
      id: `continue-${language}`,
      scenario:
        'The runtime supplies its built-in continuation guidance while authorized work remains.',
      businessValue:
        'Continue the existing task with useful action instead of inventing a new human request or reporting an intention only.',
      context: { language, bodySource: 'built-in fallback; no workspace-specific diligence file' },
      reviewQuestions: [
        'Does the wrapper distinguish runtime continuation from new human intent and avoid empty acknowledgment?',
        'Does the complete guidance help the agent advance the actual goal while accounting for completion or a genuine need for human judgment?',
      ],
      actualText: formatDiligenceAutoContinuePrompt(language, DILIGENCE_FALLBACK_TEXT[language]),
    });
    const budget = await collectBudgetExhaustion(language);
    if (budget.notices.length !== 1)
      throw new Error('Cannot review a missing or duplicate budget notice');
    cases.push({
      id: `budget-notice-${language}`,
      scenario:
        'A dialog starts with no remaining continuation allowance, answers its initial user request, and emits an informational budget notice without any automatic continuation attempts.',
      businessValue:
        'Explain why automatic nudges ended without inventing an actual attempt count or a new human question.',
      context: {
        language: budget.language,
        configuredDefault: budget.configuredDefault,
        actualAutomaticPromptCount: budget.automaticPromptCount,
        remainingBudget: budget.latest?.diligencePushRemainingBudget ?? 'missing',
        humanQuestionCount: budget.questions.length,
        canDrive: budget.suspension.canDrive,
        outputSource: 'actual ui_only_markdown_record from the isolated runtime',
      },
      reviewQuestions: [
        'Does the notice accurately explain the exhausted automatic allowance using only the facts supplied?',
        'Does it avoid claiming a historical number of attempts or judging the agent effort from the configured default?',
        'Does it distinguish an informational allowance notice from a new question or an interruption that forbids further work?',
      ],
      actualText: budget.notices[0]!.content,
    });
    cases.push({
      id: `routing-card-${language}`,
      scenario: 'A manager authors gofor/nogo to help other teammates and humans route work.',
      businessValue:
        'Route requests to the right member without confusing a routing card with that member operating rules.',
      context: {
        language,
        topic: 'team',
        machineCoverage:
          'team-yaml-parsing.ts already checks freeform object/string/list preservation and structured-list warning identity/severity',
      },
      reviewQuestions: [
        'Can the reader distinguish positive request-routing information, negative routing boundaries, and the member own execution guidance?',
        'Are the accepted shapes and guidance on labeled lists understandable without imposing a fixed set of object keys?',
      ],
      actualText: await renderTeamMgmtGuideContent(language, ['team']),
    });
  }
  await writeSemanticEvidence(cases, 'dominds-context-guidance-');
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
