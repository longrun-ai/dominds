import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadAgentMinds } from '../../main/minds/load';
import { setWorkLanguage } from '../../main/shared/runtime-language';

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
