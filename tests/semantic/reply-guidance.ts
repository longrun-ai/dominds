import {
  formatReminderContextFooter,
  type ReminderContextFooterState,
} from '../../main/runtime/driver-messages';
import {
  formatAskerDialogCallPrompt,
  formatAssignmentFromAskerDialog,
} from '../../main/runtime/inter-dialog-format';
import { buildReplyToolReminderText } from '../../main/runtime/reply-prompt-copy';
import { writeSemanticEvidence, type SemanticEvidence } from '../helpers/semantic-evidence';

async function main(): Promise<void> {
  const cases: SemanticEvidence[] = [];
  function add(
    id: string,
    language: string,
    scenario: string,
    actualText: string,
    questions: string[],
    context: Record<string, string> = {},
  ) {
    cases.push({
      id: `${id}-${language}`,
      scenario,
      businessValue:
        'Keep current human intent, runtime reminders and inter-dialog reply obligations distinct so work reaches the right recipient.',
      context: { language, ...context },
      reviewQuestions: questions,
      actualText,
    });
  }
  for (const language of ['en', 'zh'] as const) {
    for (const expectedReplyCallName of [
      'replyTellask',
      'replyTellaskSessionless',
      'replyTellaskBack',
    ] as const) {
      const directive = {
        expectedReplyCallName,
        targetDialogId: 'requester-dialog',
        targetCallId: 'pending-call',
        tellaskContent: 'Complete the assigned review.',
      };
      add(
        `reply-${expectedReplyCallName}`,
        language,
        'The executor produced an answer but has not delivered the pending reply to its requester.',
        buildReplyToolReminderText({ language, directive, replyTargetAgentId: 'requester' }),
        [
          'Is the recipient and the required reply tool appropriate for this actual pending obligation?',
          'Does the guide require delivery when ready without sending the result to a different dialog or confusing a human answer with requester delivery?',
        ],
        { directive: JSON.stringify(directive) },
      );
    }
    for (const callName of ['tellask', 'tellaskSessionless'] as const) {
      const assignment = {
        callName,
        fromAgentId: 'requester',
        toAgentId: 'worker',
        mentionList: ['@worker'],
        tellaskContent: 'Inspect the controlled implementation and return findings.',
        language,
        sessionSlug: callName === 'tellask' ? 'review-session' : undefined,
        collectiveTargets: ['worker'],
      };
      add(
        `assignment-${callName}`,
        language,
        'A worker receives a new request in a side dialog.',
        formatAssignmentFromAskerDialog(assignment),
        [
          'Does the text distinguish assigned work, the requester and the appropriate completion or ask-back path?',
          'Does it avoid turning supplied assignment context into a new human request?',
        ],
        { assignment: JSON.stringify(assignment) },
      );
    }
    add(
      'askback',
      language,
      'Worker needs a missing decision from the original requester and sends an ask-back into the requester dialog.',
      formatAskerDialogCallPrompt({
        fromAgentId: 'worker',
        toAgentId: 'requester',
        sideDialogRequest: {
          callName: 'tellaskBack',
          tellaskContent: 'Which supported target should this task use?',
        },
        askerDialogAssignment: {
          callName: 'tellask',
          mentionList: ['@worker'],
          tellaskContent: 'Complete the assigned review.',
        },
        language,
      }),
      [
        'Are the original request and current ask-back distinguished so the requester answers the actual unresolved decision rather than redoing the worker task?',
      ],
    );
    const states: Array<[string, ReminderContextFooterState]> = [
      [
        'main-user',
        {
          dialogScope: { kind: 'main_dialog' },
          followingMessage: { kind: 'user_message' },
          business: { kind: 'none' },
          contextHealth: { kind: 'normal' },
        },
      ],
      [
        'main-human-answer',
        {
          dialogScope: { kind: 'main_dialog' },
          followingMessage: { kind: 'human_answer' },
          business: { kind: 'none' },
          contextHealth: { kind: 'normal' },
        },
      ],
      [
        'side-followup',
        {
          dialogScope: { kind: 'side_dialog' },
          followingMessage: { kind: 'user_message' },
          business: { kind: 'user_followup_after_completed_handoff' },
          contextHealth: { kind: 'normal' },
        },
      ],
      [
        'side-interjection',
        {
          dialogScope: { kind: 'side_dialog' },
          followingMessage: { kind: 'user_message' },
          business: { kind: 'pending_user_interjection_with_active_reply' },
          contextHealth: { kind: 'normal' },
        },
      ],
      [
        'side-critical',
        {
          dialogScope: { kind: 'side_dialog' },
          followingMessage: { kind: 'runtime_notice' },
          business: { kind: 'active_reply_obligation' },
          contextHealth: { kind: 'critical' },
        },
      ],
    ];
    for (const [id, state] of states)
      add(
        `footer-${id}`,
        language,
        `The runtime closes the reminder block with state ${id}.`,
        formatReminderContextFooter(language, state),
        [
          'Does the text identify reminder content as runtime context without swallowing the real following user message or human answer?',
          'Does it correctly handle a completed handoff versus an active reply, a local user interruption and critical preservation pressure?',
          'Does any clarification route respect the main/side dialog boundary and avoid creating unnecessary human questions?',
        ],
        { state: JSON.stringify(state) },
      );
  }
  await writeSemanticEvidence(cases, 'dominds-reply-guidance-');
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
