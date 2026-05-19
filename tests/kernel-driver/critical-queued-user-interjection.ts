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
    const wrappedQueuedPrompt = `${formatAgentFacingCriticalUserInterjectionRemediationGuide('en', {
      dialogScope: 'mainDialog',
      promptsRemainingAfterThis: 4,
    })}\n\n${queuedPrompt}`;
    const finalAnswer = 'Queued user interjection handled under critical context.';

    await writeMockDb(tmpRoot, [
      {
        message: seedPrompt,
        role: 'user',
        response: 'Critical context seeded.',
        delayMs: 50,
        usage: { promptTokens: 190_000, completionTokens: 100 },
      },
      {
        message: wrappedQueuedPrompt,
        role: 'user',
        response: finalAnswer,
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
      prompt: wrappedQueuedPrompt,
      msgId: 'kernel-driver-critical-queued-user-interjection',
      grammar: 'markdown',
      userLanguageCode: 'en',
    });

    await seedDrive;
    assert.equal(
      dlg.hasQueuedPrompt(),
      false,
      'queued user interjection should be consumed by drive',
    );

    const runtimeGuides = dlg.msgs.filter((msg) => msg.type === 'transient_guide_msg');
    assert.equal(
      runtimeGuides.length,
      0,
      'kernel driver must not surface critical queued user interjection remediation as a separate runtime guide',
    );

    const promptingMessages = dlg.msgs.filter(
      (msg) => msg.type === 'prompting_msg' && msg.role === 'user',
    );
    const promptedQueuedInterjection = promptingMessages.find(
      (msg) => msg.msgId === 'kernel-driver-critical-queued-user-interjection',
    );
    assert.ok(
      promptedQueuedInterjection,
      'queued user interjection should be persisted as a user prompt',
    );
    assert.equal(promptedQueuedInterjection.content, wrappedQueuedPrompt);
    assert.ok(
      promptingMessages.some((msg) => msg.content === wrappedQueuedPrompt),
      'queued user interjection must remain an effective prompt',
    );
    assert.equal(
      promptingMessages.findIndex((msg) => msg.msgId === promptedQueuedInterjection.msgId) >
        promptingMessages.findIndex((msg) => msg.content === seedPrompt),
      true,
      'queued user interjection should be prompted after the seed user message',
    );
    const courseJsonl = await fs.readFile(
      path.join(tmpRoot, '.dialogs', 'run', dlg.id.rootId, 'course-001.jsonl'),
      'utf-8',
    );
    assert.equal(
      courseJsonl.includes('"type":"runtime_guide_record"'),
      false,
      'queued critical user interjection guide should not be persisted as a standalone runtime guide record',
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
