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
        dialogMsgsForContext: [
          {
            type: 'prompting_msg',
            role: 'user',
            genseq: 1,
            msgId: 'u1',
            grammar: 'markdown',
            content: 'latest-user',
          },
        ],
      },
      ephemeral: {},
      tail: {
        renderedReminders: [
          { type: 'environment_msg', role: 'user', content: 'reminder-1' },
          { type: 'environment_msg', role: 'user', content: 'reminder-2' },
        ],
        languageGuideMsg: {
          type: 'transient_guide_msg',
          role: 'assistant',
          content: 'language-guide',
        },
      },
    });

    assertOrder(
      result,
      [
        'env:prep',
        'env:mem',
        'env:taskdoc',
        'env:course',
        'prompting:latest-user',
        'env:reminder-1',
        'env:reminder-2',
        'guide:language-guide',
      ],
      'tail insertions should happen after the last user prompt-like message',
    );
  }

  {
    const result = assembleDriveContextMessages({
      base: {
        prependedContextMessages: [],
        memories: [],
        taskDocMsg: undefined,
        coursePrefixMsgs: [],
        dialogMsgsForContext: [],
      },
      ephemeral: {},
      tail: {
        renderedReminders: [{ type: 'environment_msg', role: 'user', content: 'reminder-only' }],
        languageGuideMsg: {
          type: 'transient_guide_msg',
          role: 'assistant',
          content: 'language-guide-only',
        },
      },
    });

    assertOrder(
      result,
      ['guide:language-guide-only', 'env:reminder-only'],
      'when no prior user prompt exists, reminder append still provides user anchor for language guide',
    );
  }

  {
    const result = assembleDriveContextMessages({
      base: {
        prependedContextMessages: [],
        memories: [],
        taskDocMsg: undefined,
        coursePrefixMsgs: [],
        dialogMsgsForContext: [],
      },
      ephemeral: {},
      tail: {
        renderedReminders: [],
        languageGuideMsg: {
          type: 'transient_guide_msg',
          role: 'assistant',
          content: 'guide-final',
        },
      },
    });
    assertOrder(
      result,
      ['guide:guide-final'],
      'guide should append when no insertion anchor exists',
    );
  }

  console.log('kernel-driver context-assembly-order: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`kernel-driver context-assembly-order: FAIL\n${message}`);
  process.exit(1);
});
