import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { driveDialogStream } from '../../main/llm/kernel-driver';
import { formatAgentFacingCriticalUserInterjectionRemediationGuide } from '../../main/runtime/driver-messages';
import { setWorkLanguage } from '../../main/runtime/work-language';

import {
  createMainDialog,
  makeUserPrompt,
  withTempRtws,
  writeMockDb,
  writeStandardMinds,
} from './helpers';

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
        '        context_length: 200000',
        '        optimal_max_tokens: 180000',
        '        critical_max_tokens: 180000',
        '',
      ].join('\n'),
      'utf-8',
    );

    const trigger = 'Interjection: record this and answer me.';
    const finalAnswer = 'Recorded and answering despite critical context.';
    const criticalUserGuide = formatAgentFacingCriticalUserInterjectionRemediationGuide('en', {
      dialogScope: 'mainDialog',
      promptsRemainingAfterThis: 4,
    });

    await writeMockDb(tmpRoot, [
      {
        message: trigger,
        role: 'user',
        response: 'I will inspect one fact.',
        funcCalls: [
          {
            id: 'critical-user-tool-followup-mind-more',
            name: 'env_get',
            arguments: { key: 'DOMINDS_TEST_CRITICAL_USER_TOOL_FOLLOWUP' },
          },
        ],
        usage: { promptTokens: 190_000, completionTokens: 600 },
      },
      {
        message: '(unset)',
        role: 'tool',
        response: finalAnswer,
        contextContains: [criticalUserGuide],
        usage: { promptTokens: 190_500, completionTokens: 80 },
      },
    ]);

    const dlg = await createMainDialog('tester');
    dlg.disableDiligencePush = true;

    await driveDialogStream(
      dlg,
      makeUserPrompt(trigger, 'kernel-driver-critical-user-tool-followup'),
      true,
    );

    const runtimeGuides = dlg.msgs.filter(
      (msg) => msg.type === 'transient_guide_msg' && msg.content === criticalUserGuide,
    );
    assert.equal(
      runtimeGuides.length,
      1,
      'critical user interjection should surface exactly one visible remediation guide when the user turn first becomes known-critical',
    );

    const promptingMessages = dlg.msgs.filter(
      (msg) => msg.type === 'prompting_msg' && msg.role === 'user',
    );
    assert.equal(
      promptingMessages[0]?.content,
      trigger,
      'the real user interjection must stay as the effective user prompt, not be replaced by remediation copy',
    );

    assert.ok(
      dlg.msgs.some(
        (msg) =>
          msg.type === 'saying_msg' && msg.role === 'assistant' && msg.content === finalAnswer,
      ),
      'critical context must not silently swallow the immediate post-tool reply for a user turn',
    );
  });

  console.log('kernel-driver critical-user-tool-followup: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`kernel-driver critical-user-tool-followup: FAIL\n${message}`);
  process.exit(1);
});
