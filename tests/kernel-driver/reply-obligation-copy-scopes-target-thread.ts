import assert from 'node:assert/strict';

import {
  formatAskerDialogCallPrompt,
  formatAssignmentFromAskerDialog,
} from '../../main/runtime/inter-dialog-format';
import {
  buildReplyObligationReassertionText,
  buildReplyToolReminderText,
  buildSideDialogRoleHeaderCopy,
} from '../../main/runtime/reply-prompt-copy';
import { getTellaskKindLabel } from '../../main/runtime/tellask-labels';

function main(): void {
  assert.equal(
    getTellaskKindLabel({ language: 'zh', name: 'tellaskBack', bracketed: true }),
    '【回问诉请】',
  );
  assert.equal(
    getTellaskKindLabel({ language: 'zh', name: 'tellask', bracketed: true }),
    '【长线诉请】',
  );
  assert.equal(
    getTellaskKindLabel({ language: 'zh', name: 'replyTellaskSessionless', bracketed: true }),
    '【一次性诉请】',
  );
  assert.equal(
    getTellaskKindLabel({ language: 'en', name: 'tellaskBack', bracketed: true }),
    '【TellaskBack】',
  );
  assert.equal(
    getTellaskKindLabel({ language: 'en', name: 'replyTellask', bracketed: true }),
    '【Tellask Session】',
  );
  assert.equal(
    buildSideDialogRoleHeaderCopy({
      language: 'zh',
      tellaskerId: 'tester',
      expectedReplyTool: 'replyTellask',
    }),
    '@tester 已通过【长线诉请】安排你处理下述诉请内容。等你准备好回复内容后，调用 `replyTellask` 完成回复。只有确实需要向诉请者回问、且现有规程无法直接判责时，才调用 `tellaskBack`。',
  );
  assert.equal(
    buildSideDialogRoleHeaderCopy({
      language: 'en',
      tellaskerId: 'tester',
      expectedReplyTool: 'replyTellaskSessionless',
    }),
    '@tester has assigned you, via this 【Fresh Tellask】, to handle the request content below. Once your reply content is ready, call `replyTellaskSessionless` to deliver it. Call `tellaskBack` only when you truly need to ask the tellasker back and existing SOP cannot directly identify another owner.',
  );

  const startAssignment = formatAssignmentFromAskerDialog({
    callName: 'tellask',
    fromAgentId: 'tester',
    toAgentId: 'pangu',
    mentionList: ['@pangu'],
    tellaskContent: 'Please review this task.',
    language: 'zh',
    sessionSlug: 'sticky',
    collectiveTargets: ['pangu'],
  });
  assert.match(startAssignment, /@tester 已通过【长线诉请】安排你处理下述诉请内容/u);
  assert.match(startAssignment, /诉请内容（sticky）：/u);

  const askBackPrompt = formatAskerDialogCallPrompt({
    fromAgentId: 'pangu',
    toAgentId: 'tester',
    sideDialogRequest: {
      callName: 'tellaskBack',
      tellaskContent: 'Please confirm the exact final answer.',
    },
    askerDialogAssignment: {
      callName: 'tellask',
      mentionList: ['@pangu'],
      tellaskContent: 'Please answer 1+1.',
    },
    language: 'zh',
  });
  assert.match(askBackPrompt, /@pangu 发来一条 【回问诉请】 给 @tester。/u);
  assert.match(askBackPrompt, /原诉请：/u);
  assert.match(askBackPrompt, /回问内容：/u);

  const askBackDirective = {
    expectedReplyCallName: 'replyTellaskBack' as const,
    targetCallId: 'reply-back-target',
    targetDialogId: 'side dialog-dialog-42',
    tellaskContent: 'Please confirm the side dialog result.',
  };
  const askBackReminder = buildReplyToolReminderText({
    language: 'zh',
    directive: askBackDirective,
    prefix: '[Dominds 必须调用回复工具]',
    replyTargetAgentId: 'pangu',
  });
  assert.match(askBackReminder, /@pangu 的【回问诉请】还在等你的回复/u);
  assert.match(askBackReminder, /请现在调用 `replyTellaskBack\(\{ replyContent \}\)` 完成回复/u);
  assert.match(askBackReminder, /你刚才已经写了正文，但还没调用 `replyTellaskBack`/u);

  const askBackReassertion = buildReplyObligationReassertionText({
    language: 'en',
    directive: askBackDirective,
    replyTargetAgentId: 'pangu',
  });
  assert.match(askBackReassertion, /@pangu's 【TellaskBack】 is still waiting for your reply/u);
  assert.match(askBackReassertion, /call `replyTellaskBack` to deliver it/u);
  assert.match(askBackReassertion, /not asking you to reply immediately/u);

  const assignmentDirective = {
    expectedReplyCallName: 'replyTellaskSessionless' as const,
    targetDialogId: 'main-dialog',
    targetCallId: 'root-to-pangu-call',
    tellaskContent: 'Finish the parent side dialog after the nested work returns.',
  };
  const assignmentReassertion = buildReplyObligationReassertionText({
    language: 'zh',
    directive: assignmentDirective,
    replyTargetAgentId: 'tester',
  });
  assert.match(assignmentReassertion, /@tester 的【一次性诉请】还在等你的回复/u);
  assert.match(assignmentReassertion, /调用 `replyTellaskSessionless` 完成回复/u);
  assert.match(assignmentReassertion, /这里不是催你立刻回复/u);

  console.log('kernel-driver reply-obligation-copy-scopes-target-thread: PASS');
}

try {
  main();
} catch (err: unknown) {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error('kernel-driver reply-obligation-copy-scopes-target-thread: FAIL\n' + message);
  process.exit(1);
}
