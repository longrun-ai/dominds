import type { SnippetTemplateGroup } from '@longrun-ai/kernel/types/snippets';
import assert from 'node:assert/strict';
import { handleGetSnippetCatalog } from '../../main/server/snippets-routes';

function requireStartingTemplatePath(groups: ReadonlyArray<SnippetTemplateGroup>): string {
  const daily = groups.find((g) => g.key === 'daily');
  assert.ok(daily, "Expected 'daily' snippet group");
  const first = daily.templates[0];
  assert.ok(first, 'Expected at least one template');
  const pathValue = first.path;
  assert.equal(typeof pathValue, 'string');
  if (typeof pathValue !== 'string') {
    throw new Error('Expected first daily template path to be a string');
  }
  return pathValue;
}

async function run(): Promise<void> {
  const zh = await handleGetSnippetCatalog('zh');
  if (!zh.success) throw new Error(zh.error);
  assert.equal(zh.success, true);
  assert.equal(requireStartingTemplatePath(zh.groups), 'snippets/starting.zh.md');

  const en = await handleGetSnippetCatalog('en');
  if (!en.success) throw new Error(en.error);
  assert.equal(en.success, true);
  assert.equal(requireStartingTemplatePath(en.groups), 'snippets/starting.en.md');

  console.log('snippets catalog i18n tests: ok');
}

run().catch((error: unknown) => {
  const msg = error instanceof Error ? error.message : String(error);
  console.error(`snippets catalog i18n tests: failed: ${msg}`);
  process.exitCode = 1;
});
