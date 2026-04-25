import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadAgentMinds } from '../../main/minds/load';
import { taskdocCanonicalCopy } from '../../main/minds/minds-i18n';
import { setWorkLanguage } from '../../main/runtime/work-language';
import '../../main/tools/builtins';

async function writeText(filePath: string, value: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, value, 'utf-8');
}

async function main(): Promise<void> {
  const oldCwd = process.cwd();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-mindset-i18n-'));

  try {
    process.chdir(tmpRoot);

    await writeText(
      path.join(tmpRoot, '.minds', 'team.yaml'),
      [
        'member_defaults:',
        '  provider: test',
        '  model: test',
        'members:',
        '  alice:',
        '    name: Alice',
        'default_responder: alice',
        '',
      ].join('\n'),
    );

    await writeText(path.join(tmpRoot, '.minds', 'team', 'alice', 'persona.md'), 'persona-default');

    // Prefer persona.<lang>.md when present.
    await writeText(path.join(tmpRoot, '.minds', 'team', 'alice', 'persona.en.md'), 'persona-en');
    setWorkLanguage('en');
    {
      const { systemPrompt } = await loadAgentMinds('alice');
      assert.ok(systemPrompt.includes('persona-en'));
      assert.ok(!systemPrompt.includes('persona-default'));
    }

    {
      const { agentTools } = await loadAgentMinds('alice');
      const toolNames = new Set(agentTools.map((tool) => tool.name));
      assert.ok(toolNames.has('mind_more'), 'main dialog should expose mind_more');
      assert.ok(toolNames.has('change_mind'), 'main dialog should expose change_mind');
      assert.ok(toolNames.has('never_mind'), 'main dialog should expose never_mind');
    }

    {
      const fakeSideDialog = {
        askerDialog: {},
        getLastContextHealth: () => undefined,
      };
      const { agentTools } = await loadAgentMinds('alice', fakeSideDialog as never);
      const toolNames = new Set(agentTools.map((tool) => tool.name));
      assert.ok(!toolNames.has('mind_more'), 'side dialog should not expose mind_more');
      assert.ok(!toolNames.has('change_mind'), 'side dialog should not expose change_mind');
      assert.ok(!toolNames.has('never_mind'), 'side dialog should not expose never_mind');
      assert.ok(toolNames.has('recall_taskdoc'), 'side dialog should still expose recall_taskdoc');
    }

    assert.ok(
      taskdocCanonicalCopy('en').includes('mind_more'),
      'canonical Taskdoc copy should mention mind_more in English',
    );
    assert.ok(
      taskdocCanonicalCopy('zh').includes('mind_more'),
      'canonical Taskdoc copy should mention mind_more in Chinese',
    );

    // Fall back to persona.md when persona.<lang>.md is absent.
    await fs.rm(path.join(tmpRoot, '.minds', 'team', 'alice', 'persona.en.md'));
    setWorkLanguage('en');
    {
      const { systemPrompt } = await loadAgentMinds('alice');
      assert.ok(systemPrompt.includes('persona-default'));
    }

    // Work-language-specific loading is independent per language.
    await writeText(path.join(tmpRoot, '.minds', 'team', 'alice', 'persona.zh.md'), 'persona-zh');
    setWorkLanguage('zh');
    {
      const { systemPrompt } = await loadAgentMinds('alice');
      assert.ok(systemPrompt.includes('persona-zh'));
      assert.ok(!systemPrompt.includes('persona-default'));
    }

    // Builtin minds are also language-specific (no .minds/team/<id> overrides required).
    setWorkLanguage('en');
    {
      const { systemPrompt } = await loadAgentMinds('fuxi');
      assert.ok(systemPrompt.includes('Fuxi @fuxi'));
      assert.ok(systemPrompt.includes('team management'));
      assert.ok(systemPrompt.includes('team_mgmt'));
    }

    setWorkLanguage('zh');
    {
      const { systemPrompt } = await loadAgentMinds('fuxi');
      assert.ok(systemPrompt.includes('伏羲'));
      assert.ok(systemPrompt.includes('team_mgmt'));
      assert.ok(systemPrompt.includes('团队管理'));
    }

    console.log('✅ mindset-i18n tests: ok');
  } finally {
    process.chdir(oldCwd);
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  console.error('❌ mindset-i18n test failed', err);
  process.exit(1);
});
