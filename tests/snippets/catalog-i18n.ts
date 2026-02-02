import assert from 'node:assert/strict';
import { handleGetSnippetCatalog } from '../../main/server/snippets-routes';
import type { SnippetTemplateGroup } from '../../main/shared/types/snippets';

function requireStartingTemplatePath(groups: ReadonlyArray<SnippetTemplateGroup>): string {
  const daily = groups.find((g) => g.key === 'daily');
  assert.ok(daily, "Expected 'daily' snippet group");
  const first = daily.templates[0];
  assert.ok(first, 'Expected at least one template');
  const pathValue = first.path;
  assert.equal(typeof pathValue, 'string');
  return pathValue;
}

async function run(): Promise<void> {
  const zh = await handleGetSnippetCatalog('zh');
  assert.equal(zh.success, true);
  if (!zh.success) throw new Error(zh.error);
  assert.equal(requireStartingTemplatePath(zh.groups), 'snippets/starting.zh.md');

  const en = await handleGetSnippetCatalog('en');
  assert.equal(en.success, true);
  if (!en.success) throw new Error(en.error);
  assert.equal(requireStartingTemplatePath(en.groups), 'snippets/starting.en.md');

  console.log('snippets catalog i18n tests: ok');
}

run().catch((error: unknown) => {
  const msg = error instanceof Error ? error.message : String(error);
  console.error(`snippets catalog i18n tests: failed: ${msg}`);
  process.exitCode = 1;
});
