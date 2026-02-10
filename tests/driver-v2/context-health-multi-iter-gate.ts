import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { driveDialogStream } from '../../main/llm/driver-entry';
import { formatAgentFacingContextHealthV3RemediationGuide } from '../../main/shared/i18n/driver-messages';
import { setWorkLanguage } from '../../main/shared/runtime-language';

import { createRootDialog, withTempRtws, writeMockDb, writeStandardMinds } from './helpers';

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    setWorkLanguage('en');
    await writeStandardMinds(tmpRoot, { memberTools: ['env_get'] });
    await fs.writeFile(
      path.join(tmpRoot, '.minds', 'llm.yaml'),
      [
        'providers:',
        '  local-mock:',
        '    name: Local Mock',
        '    apiType: mock',
        '    baseUrl: mock-db',
        '    apiKeyEnvVar: MOCK_API_KEY',
        '    models:',
        '      default:',
        '        name: Default',
        '        context_length: 272000',
        '        optimal_max_tokens: 200000',
        '        critical_max_tokens: 244800',
        '',
      ].join('\n'),
      'utf-8',
    );

    const trigger = 'Context-health multi-iter guard probe.';
    const cautionGuide = formatAgentFacingContextHealthV3RemediationGuide('en', {
      kind: 'caution',
      mode: 'soft',
    });
    const finalAnswer = 'Context-health guide injected before continuing.';

    const testEnvKey = 'DOMINDS_TEST_CONTEXT_HEALTH';

    await writeMockDb(tmpRoot, [
      {
        message: trigger,
        role: 'user',
        response: 'Round-1: call env_get.',
        funcCalls: [{ name: 'env_get', arguments: { key: testEnvKey } }],
        usage: { promptTokens: 150_000, completionTokens: 100 },
      },
      {
        message: '(unset)',
        role: 'tool',
        response: 'Round-2: call env_get again to simulate tool-loop continuation.',
        funcCalls: [{ name: 'env_get', arguments: { key: testEnvKey } }],
        usage: { promptTokens: 210_000, completionTokens: 100 },
      },
      {
        message: cautionGuide,
        role: 'user',
        response: finalAnswer,
        usage: { promptTokens: 210_100, completionTokens: 100 },
      },
    ]);

    const dlg = createRootDialog('tester');
    dlg.disableDiligencePush = true;

    await driveDialogStream(
      dlg,
      {
        content: trigger,
        msgId: 'driver-v2-context-health-multi-iter-gate',
        grammar: 'markdown',
      },
      true,
    );

    const promptingMessages = dlg.msgs.filter(
      (msg) => msg.type === 'prompting_msg' && msg.role === 'user',
    );
    const injectedPrompts = promptingMessages.filter((msg) => msg.content === cautionGuide);
    assert.equal(
      injectedPrompts.length,
      1,
      `expected exactly one injected caution remediation prompt, got ${injectedPrompts.length}; prompting messages=${JSON.stringify(
        promptingMessages.map((msg) => msg.content),
      )}`,
    );

    const assistantSayings = dlg.msgs.filter(
      (msg) => msg.type === 'saying_msg' && msg.role === 'assistant',
    );
    assert.ok(assistantSayings.length >= 3, 'expected at least three assistant sayings');
    assert.equal(
      assistantSayings[assistantSayings.length - 1]?.content,
      finalAnswer,
      'final assistant saying should be produced after context-health guide injection',
    );
  });

  console.log('driver-v2 context-health-multi-iter-gate: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`driver-v2 context-health-multi-iter-gate: FAIL\n${message}`);
  process.exit(1);
});
