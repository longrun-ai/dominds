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
    const wrappedTrigger = `${formatAgentFacingCriticalUserInterjectionRemediationGuide('en', {
      dialogScope: 'mainDialog',
      promptsRemainingAfterThis: 4,
    })}\n\n${trigger}`;

    await writeMockDb(tmpRoot, [
      {
        message: wrappedTrigger,
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
        usage: { promptTokens: 190_500, completionTokens: 80 },
      },
    ]);

    const dlg = await createMainDialog('tester');
    dlg.disableDiligencePush = true;

    await driveDialogStream(
      dlg,
      makeUserPrompt(wrappedTrigger, 'kernel-driver-critical-user-tool-followup'),
      true,
    );

    const runtimeGuides = dlg.msgs.filter((msg) => msg.type === 'transient_guide_msg');
    assert.equal(
      runtimeGuides.length,
      0,
      'kernel driver must not surface critical user interjection remediation as a separate runtime guide',
    );

    const promptingMessages = dlg.msgs.filter(
      (msg) => msg.type === 'prompting_msg' && msg.role === 'user',
    );
    const promptedInterjection = promptingMessages.find(
      (msg) => msg.msgId === 'kernel-driver-critical-user-tool-followup',
    );
    assert.ok(
      promptedInterjection,
      'critical user interjection should be persisted as a user prompt',
    );
    assert.equal(promptedInterjection.content, wrappedTrigger);
    const courseJsonl = await fs.readFile(
      path.join(tmpRoot, '.dialogs', 'run', dlg.id.rootId, 'course-001.jsonl'),
      'utf-8',
    );
    assert.equal(
      courseJsonl.includes('"type":"runtime_guide_record"'),
      false,
      'critical user interjection guide should not be persisted as a standalone runtime guide record',
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
