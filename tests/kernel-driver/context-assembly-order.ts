import assert from 'node:assert/strict';

import type { ChatMessage } from '../../main/llm/client';
import { assembleDriveContextMessages } from '../../main/llm/kernel-driver/context';

function msgSummary(msg: ChatMessage): string {
  if (msg.type === 'prompting_msg') {
    return `prompting:${msg.content}`;
  }
  if (msg.type === 'environment_msg') {
    return `env:${msg.content}`;
  }
  if (msg.type === 'transient_guide_msg') {
    return `guide:${msg.content}`;
  }
  if (msg.type === 'tellask_result_msg') {
    return `tellask:${msg.content}`;
  }
  return `${msg.type}:${'content' in msg ? String(msg.content) : ''}`;
}

function assertOrder(actual: ChatMessage[], expected: string[], label: string): void {
  const actualSummaries = actual.map(msgSummary);
  assert.deepEqual(actualSummaries, expected, label);
}

async function main(): Promise<void> {
  {
    const result = assembleDriveContextMessages({
      base: {
        prependedContextMessages: [{ type: 'environment_msg', role: 'user', content: 'prep' }],
        memories: [{ type: 'environment_msg', role: 'user', content: 'mem' }],
        taskDocMsg: { type: 'environment_msg', role: 'user', content: 'taskdoc' },
        coursePrefixMsgs: [{ type: 'environment_msg', role: 'user', content: 'course' }],
        historicalDialogMsgsForContext: [
          {
            type: 'prompting_msg',
            role: 'user',
            genseq: 1,
            msgId: 'u0',
            grammar: 'markdown',
            content: 'historical-user',
          },
          { type: 'saying_msg', role: 'assistant', genseq: 1, content: 'historical-assistant' },
        ],
        currentTurnDialogMsgsForContext: [
          {
            type: 'prompting_msg',
            role: 'user',
            genseq: 2,
            msgId: 'u1',
            grammar: 'markdown',
            content: 'latest-user',
          },
        ],
      },
      tail: {
        renderedReminders: [
          { type: 'environment_msg', role: 'user', content: 'reminder-1' },
          { type: 'environment_msg', role: 'user', content: 'reminder-2' },
        ],
        activeReplyObligationContext: [
          { type: 'environment_msg', role: 'user', content: 'reply-obligation' },
        ],
        runtimeGuideMsgs: [
          { type: 'transient_guide_msg', role: 'assistant', content: 'runtime-guide' },
        ],
      },
    });

    assertOrder(
      result,
      [
        'env:prep',
        'env:mem',
        'env:taskdoc',
        'env:course',
        'prompting:historical-user',
        'saying_msg:historical-assistant',
        'env:reminder-1',
        'env:reminder-2',
        'env:reply-obligation',
        'guide:runtime-guide',
        'prompting:latest-user',
      ],
      'dynamic runtime context should preserve historical prefix cache and sit before current turn',
    );
  }

  {
    const result = assembleDriveContextMessages({
      base: {
        prependedContextMessages: [],
        memories: [],
        taskDocMsg: undefined,
        coursePrefixMsgs: [],
        historicalDialogMsgsForContext: [],
        currentTurnDialogMsgsForContext: [],
      },
      tail: {
        renderedReminders: [{ type: 'environment_msg', role: 'user', content: 'reminder-only' }],
        activeReplyObligationContext: [],
        runtimeGuideMsgs: [],
      },
    });

    assertOrder(
      result,
      ['env:reminder-only'],
      'when no prior user prompt exists, rendered reminders still append directly',
    );
  }

  {
    const result = assembleDriveContextMessages({
      base: {
        prependedContextMessages: [{ type: 'environment_msg', role: 'user', content: 'prep' }],
        memories: [],
        taskDocMsg: undefined,
        coursePrefixMsgs: [],
        historicalDialogMsgsForContext: [
          {
            type: 'prompting_msg',
            role: 'user',
            genseq: 1,
            msgId: 'u0',
            grammar: 'markdown',
            content: 'historical-user',
          },
        ],
        currentTurnDialogMsgsForContext: [],
      },
      tail: {
        renderedReminders: [{ type: 'environment_msg', role: 'user', content: 'reminder-only' }],
        activeReplyObligationContext: [
          { type: 'environment_msg', role: 'user', content: 'reply-obligation' },
        ],
        runtimeGuideMsgs: [
          { type: 'transient_guide_msg', role: 'assistant', content: 'runtime-guide' },
        ],
      },
    });

    assertOrder(
      result,
      [
        'env:prep',
        'prompting:historical-user',
        'env:reminder-only',
        'env:reply-obligation',
        'guide:runtime-guide',
      ],
      'tool-followup dynamic context should append after historical cache prefix when no current turn follows',
    );
  }

  {
    const result = assembleDriveContextMessages({
      base: {
        prependedContextMessages: [],
        memories: [],
        taskDocMsg: undefined,
        coursePrefixMsgs: [],
        historicalDialogMsgsForContext: [],
        currentTurnDialogMsgsForContext: [],
      },
      tail: {
        renderedReminders: [],
        activeReplyObligationContext: [],
        runtimeGuideMsgs: [],
      },
    });
    assertOrder(result, [], 'empty tail should leave context unchanged');
  }

  console.log('kernel-driver context-assembly-order: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`kernel-driver context-assembly-order: FAIL\n${message}`);
  process.exit(1);
});
