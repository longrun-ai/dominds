import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { Team } from '../../main/team';
import '../../main/tools/builtins';
import { MANUAL_SINGLE_REQUEST_CHAR_LIMIT } from '../../main/tools/manual/output-limit';
import { registerToolset, setToolsetMeta, unregisterToolset } from '../../main/tools/registry';
import { buildManTool } from '../../main/tools/toolset-manual';
import { rawManualForBudget } from '../helpers/manual-budget';
import { writeSemanticEvidence, type SemanticEvidence } from '../helpers/semantic-evidence';

async function main(): Promise<void> {
  assert.equal(process.env.DOMINDS_TEST_RTWS_MANAGED, '1', 'run through tests/cli.ts');
  const semantic = process.argv.includes('--semantic');
  const cases: SemanticEvidence[] = [];
  const id = 'manual_fixture_89ab';
  const privateId = 'ungranted_fixture_285e';
  const directory = path.resolve('.minds/manual-fixture');
  await fs.mkdir(directory, { recursive: true });
  const payloads = { en: 'manual-payload-en-e248', zh: 'manual-payload-zh-c2b1' };
  const tool = {
    type: 'func' as const,
    name: 'manual_fixture_lookup',
    description: 'Controlled external lookup',
    parameters: { type: 'object', properties: {} },
    async call() {
      return { outcome: 'success' as const, content: 'opaque-result' };
    },
  };
  registerToolset(id, [tool]);
  registerToolset(privateId, []);
  const files = Object.fromEntries(
    await Promise.all(
      (['en', 'zh'] as const).map(async (language) => {
        const index = path.join(directory, `index-${language}.md`);
        await fs.writeFile(index, payloads[language]);
        return [language, { index, errors: path.join(directory, `missing-${language}.md`) }];
      }),
    ),
  );
  setToolsetMeta(id, {
    source: 'dominds',
    manualSpec: { topics: ['index', 'errors'], warnOnMissing: true, topicFilesI18n: files },
  });
  const privatePayload = 'private-manual-data-82db';
  const privatePath = path.join(directory, 'private.md');
  await fs.writeFile(privatePath, privatePayload);
  setToolsetMeta(privateId, {
    source: 'dominds',
    manualSpec: {
      topics: ['index'],
      topicFilesI18n: { en: { index: privatePath }, zh: { index: privatePath } },
    },
  });
  const caller = new Team.Member({ id: 'tester', name: 'Tester', toolsets: [id] });
  const man = buildManTool();
  function record(
    key: string,
    language: string,
    text: string,
    scenario: string,
    questions: string[],
    extra: Record<string, string | number> = {},
  ): void {
    if (!semantic) return;
    cases.push({
      id: `${key}-${language}`,
      scenario,
      businessValue:
        'Discover only granted capabilities and recover useful manual guidance without receiving broken or silently truncated instructions.',
      context: { language, grantedToolset: id, ungrantedToolset: privateId, ...extra },
      reviewQuestions: questions,
      actualText: text,
    });
  }
  try {
    for (const language of ['en', 'zh'] as const) {
      const dialog = { getLastUserLanguageCode: () => language } as never;
      const listing = await man.call(dialog, caller, {});
      assert.equal(listing.outcome, 'success');
      assert.ok(listing.content.includes(id));
      assert.equal(listing.content.includes(privateId), false);
      record(
        'listing',
        language,
        listing.content,
        'An agent asks what toolset manuals it may inspect.',
        [
          'Does the list identify granted toolsets and help the agent decide when to consult their manual, without implying new permissions?',
        ],
      );
      const missing = await man.call(dialog, caller, {
        toolsetId: id,
        topics: ['index', 'errors'],
      });
      assert.equal(missing.outcome, 'success');
      assert.ok(missing.content.includes(payloads[language]));
      assert.equal(missing.content.includes(payloads[language === 'en' ? 'zh' : 'en']), false);
      record(
        'missing-topic',
        language,
        missing.content,
        'The requested index topic exists, but the errors topic file is absent.',
        [
          'Does the output preserve the available topic and make the missing section and its repair location understandable, without treating a partial manual as complete?',
        ],
        { suppliedIndex: payloads[language], missingFile: files[language].errors },
      );
      const denied = await man.call(dialog, caller, { toolsetId: privateId });
      const privateCaller = new Team.Member({
        id: 'authorized',
        name: 'Authorized',
        toolsets: [privateId],
      });
      const permitted = await man.call(dialog, privateCaller, {
        toolsetId: privateId,
        topic: 'index',
      });
      assert.ok(
        permitted.content.includes(privatePayload),
        'control reader can retrieve the private fixture body',
      );
      assert.equal(
        denied.content.includes(privatePayload),
        false,
        'an ungranted manual body must not leak',
      );
      record(
        'ungranted',
        language,
        denied.content,
        'A registered toolset was not granted to this member.',
        [
          'Does the response distinguish capability availability for this member from registration and point to the actual available alternatives?',
        ],
      );
      const head = 'oversized-head-data-a381';
      const tail = 'oversized-tail-data-5ac6';
      const body = head + '\n' + 'A'.repeat(MANUAL_SINGLE_REQUEST_CHAR_LIMIT + 2_000) + '\n' + tail;
      await fs.writeFile(files[language].index, body);
      const unbounded = await rawManualForBudget({ toolsetId: id, language, topic: 'index' });
      assert.ok(
        unbounded.length > MANUAL_SINGLE_REQUEST_CHAR_LIMIT,
        'build checks must see oversized original prose',
      );
      assert.ok(unbounded.includes(head));
      assert.ok(unbounded.includes(tail));
      const oversized = await man.call(dialog, caller, { toolsetId: id, topic: 'index' });
      assert.equal(oversized.outcome, 'success');
      assert.ok(oversized.content.length <= MANUAL_SINGLE_REQUEST_CHAR_LIMIT);
      assert.equal(oversized.content.includes(head), false);
      assert.equal(oversized.content.includes(tail), false);
      record(
        'oversized',
        language,
        oversized.content,
        'The selected manual topic exceeds the product readability budget.',
        [
          'Does the output explain that the full topic was withheld rather than silently cut, and give an actionable way to narrow the request?',
        ],
        { originalLength: body.length, limit: MANUAL_SINGLE_REQUEST_CHAR_LIMIT },
      );
    }
  } finally {
    unregisterToolset(id);
    unregisterToolset(privateId);
  }
  if (semantic) await writeSemanticEvidence(cases, 'dominds-manual-behavior-guidance-');
  else console.log('manual capability visibility, payload delivery and size behavior: passed');
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
