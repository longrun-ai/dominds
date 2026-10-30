import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { toCallSiteCourseNo, toCallSiteGenseqNo } from '@longrun-ai/kernel/types/storage';
import { loadAgentMinds } from '../../main/minds/load';
import { setWorkLanguage } from '../../main/runtime/work-language';
import '../../main/tools/builtins';
import { createMainDialog, writeStandardMinds } from '../kernel-driver/helpers';

async function main(): Promise<void> {
  assert.equal(process.env.DOMINDS_TEST_RTWS_MANAGED, '1', 'run through tests/cli.ts');
  await writeStandardMinds(process.cwd());
  const root = await createMainDialog('tester');
  const sideDialog = await root.createSideDialog('tester', ['@tester'], 'mind-scope-data', {
    callName: 'tellask',
    originMemberId: 'tester',
    askerDialogId: root.id.selfId,
    callId: 'mind-scope-call',
    callSiteCourse: toCallSiteCourseNo(1),
    callSiteGenseq: toCallSiteGenseqNo(1),
    sessionSlug: 'mind-scope',
  });
  const directory = path.resolve('.minds/team/tester');
  await fs.mkdir(directory, { recursive: true });
  const payloads = {
    neutral: 'persona-data-8927',
    en: 'persona-data-en-27b1',
    zh: 'persona-data-zh-8fa6',
    knowhow: 'knowhow-data-f481',
    pitfalls: 'pitfalls-data-9d2c',
    legacy: 'ignored-legacy-data-a13d',
  };
  await fs.writeFile(path.join(directory, 'persona.md'), payloads.neutral);
  await fs.writeFile(path.join(directory, 'persona.en.md'), payloads.en);
  await fs.writeFile(path.join(directory, 'persona.zh.md'), payloads.zh);
  await fs.writeFile(path.join(directory, 'knowhow.en.md'), payloads.knowhow);
  await fs.writeFile(path.join(directory, 'pitfalls.en.md'), payloads.pitfalls);
  await fs.writeFile(path.join(directory, 'knowledge.en.md'), payloads.legacy);
  await fs.writeFile(path.join(directory, 'lessons.en.md'), payloads.legacy);
  for (const language of ['en', 'zh'] as const) {
    setWorkLanguage(language);
    const loaded = await loadAgentMinds('tester');
    // Opaque file payload selection/fidelity, not a judgment of persona meaning.
    assert.ok(loaded.systemPrompt.includes(payloads[language]));
    assert.equal(loaded.systemPrompt.includes(payloads[language === 'en' ? 'zh' : 'en']), false);
    assert.equal(loaded.systemPrompt.includes(payloads.neutral), false);
    assert.equal(loaded.systemPrompt.includes(payloads.legacy), false);
    if (language === 'en') {
      assert.ok(loaded.systemPrompt.includes(payloads.knowhow));
      assert.ok(loaded.systemPrompt.includes(payloads.pitfalls));
    }
    const tools = new Set(loaded.agentTools.map((tool) => tool.name));
    for (const name of ['do_mind', 'mind_more', 'change_mind', 'never_mind'])
      assert.ok(tools.has(name));
    const side = await loadAgentMinds('tester', sideDialog);
    const sideTools = new Set(side.agentTools.map((tool) => tool.name));
    for (const name of ['do_mind', 'mind_more', 'change_mind', 'never_mind'])
      assert.equal(sideTools.has(name), false);
    assert.ok(sideTools.has('recall_taskdoc'));
  }
  await fs.rm(path.join(directory, 'persona.en.md'));
  setWorkLanguage('en');
  assert.ok((await loadAgentMinds('tester')).systemPrompt.includes(payloads.neutral));
  for (const language of ['en', 'zh'] as const) {
    setWorkLanguage(language);
    const builtin = await loadAgentMinds('fuxi');
    assert.equal(builtin.agent.id, 'fuxi');
    assert.equal(
      builtin.agentTools.some((tool) => tool.name === 'shell_cmd'),
      false,
      'the manager remains a valid hidden member without shell execution',
    );
    assert.ok(builtin.agentTools.some((tool) => tool.name === 'team_mgmt_validate_team_cfg'));
    const source = await fs.readFile(
      path.resolve(__dirname, '../../main/minds/builtin/fuxi', `persona.${language}.md`),
      'utf8',
    );
    assert.ok(
      builtin.systemPrompt.includes(source.trim()),
      'the selected built-in persona asset is actually delivered',
    );
  }
  const operator = await loadAgentMinds('pangu');
  assert.ok(
    operator.agentTools.some((tool) => tool.name === 'shell_cmd'),
    'hidden operator retains its existing shell authority',
  );
  console.log('mind asset selection and Taskdoc authority: passed');
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
