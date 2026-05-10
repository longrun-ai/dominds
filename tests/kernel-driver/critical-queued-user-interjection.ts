import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { driveDialogStream } from '../../main/llm/kernel-driver';
import { formatAgentFacingCriticalUserInterjectionRemediationGuide } from '../../main/runtime/driver-messages';
import { setWorkLanguage } from '../../main/runtime/work-language';

import {
  createMainDialog,
  makeDriveOptions,
  makeUserPrompt,
  withTempRtws,
  writeMockDb,
  writeStandardMinds,
} from './helpers';

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    setWorkLanguage('en');
    await writeStandardMinds(tmpRoot);
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

    const seedPrompt = 'Seed critical context before consuming queued user message.';
    const queuedPrompt = 'Queued user interjection after critical context.';
    const finalAnswer = 'Queued user interjection handled under critical context.';
    const criticalUserGuide = formatAgentFacingCriticalUserInterjectionRemediationGuide('en', {
      dialogScope: 'mainDialog',
      promptsRemainingAfterThis: 4,
    });

    await writeMockDb(tmpRoot, [
      {
        message: seedPrompt,
        role: 'user',
        response: 'Critical context seeded.',
        delayMs: 50,
        usage: { promptTokens: 190_000, completionTokens: 100 },
      },
      {
        message: queuedPrompt,
        role: 'user',
        response: finalAnswer,
        contextContains: [criticalUserGuide],
        usage: { promptTokens: 190_200, completionTokens: 80 },
      },
    ]);

    const dlg = await createMainDialog('tester');
    dlg.disableDiligencePush = true;

    const seedDrive = driveDialogStream(
      dlg,
      makeUserPrompt(seedPrompt, 'kernel-driver-critical-queued-user-seed'),
      true,
      makeDriveOptions({ suppressDiligencePush: true }),
    );

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
    dlg.queueUserPromptAtGenerationBoundary({
      prompt: queuedPrompt,
      msgId: 'kernel-driver-critical-queued-user-interjection',
      grammar: 'markdown',
      userLanguageCode: 'en',
    });

    await seedDrive;
    assert.equal(dlg.hasUpNext(), false, 'queued user interjection should be consumed by drive');

    const runtimeGuides = dlg.msgs.filter(
      (msg) => msg.type === 'transient_guide_msg' && msg.content === criticalUserGuide,
    );
    assert.equal(
      runtimeGuides.length,
      1,
      'queued critical user interjection should surface exactly one remediation guide',
    );

    const promptingMessages = dlg.msgs.filter(
      (msg) => msg.type === 'prompting_msg' && msg.role === 'user',
    );
    assert.ok(
      promptingMessages.some((msg) => msg.content === queuedPrompt),
      'queued user interjection must remain an effective prompt instead of being replaced by remediation copy',
    );
    assert.equal(
      promptingMessages.findIndex((msg) => msg.content === queuedPrompt) >
        promptingMessages.findIndex((msg) => msg.content === seedPrompt),
      true,
      'queued user interjection should be prompted after the seed user message',
    );
    assert.ok(
      dlg.msgs.some(
        (msg) =>
          msg.type === 'saying_msg' && msg.role === 'assistant' && msg.content === finalAnswer,
      ),
      'queued critical user interjection should receive a visible assistant answer',
    );
  });

  console.log('kernel-driver critical-queued-user-interjection: PASS');
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`kernel-driver critical-queued-user-interjection: FAIL\n${message}`);
  process.exit(1);
});
