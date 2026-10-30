import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';

import { loadAgentMinds } from '../../main/minds/load';
import { setWorkLanguage } from '../../main/runtime/work-language';
import { loadWorkspaceSkills } from '../../main/skills/load';

async function writeText(filePath: string, value: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, value, 'utf-8');
}

async function main(): Promise<void> {
  assert.equal(process.env.DOMINDS_TEST_RTWS_MANAGED, '1', 'run through tests/cli.ts');
  const tmpRoot = process.cwd();
  {
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

    await writeText(
      path.join(tmpRoot, '.minds', 'skills', 'team_shared', 'reviewer', 'SKILL.cn.md'),
      [
        '---',
        'name: reviewer-workflow',
        'description: 中文评审技能',
        'allowed-tools:',
        '  - read_file',
        '---',
        '',
        '先梳理改动面，再确认验证路径。',
      ].join('\n'),
    );
    await writeText(
      path.join(tmpRoot, '.minds', 'skills', 'team_shared', 'reviewer', 'SKILL.en.md'),
      [
        '---',
        'name: reviewer-workflow',
        'description: English review skill',
        'allowed-tools:',
        '  - read_file',
        '---',
        '',
        'Map the change surface before proposing verification.',
      ].join('\n'),
    );
    await writeText(
      path.join(tmpRoot, '.minds', 'skills', 'team_shared', 'fallback', 'SKILL.md'),
      [
        '---',
        'name: fallback-skill',
        'description: Neutral fallback skill',
        '---',
        '',
        'Use neutral fallback instructions.',
      ].join('\n'),
    );
    await writeText(
      path.join(tmpRoot, '.minds', 'skills', 'individual', 'alice', 'private-notes', 'SKILL.cn.md'),
      [
        '---',
        'name: alice-private-skill',
        'description: 仅 Alice 可见',
        '---',
        '',
        '这是 Alice 的个人技能。',
      ].join('\n'),
    );
    await writeText(
      path.join(tmpRoot, '.minds', 'skills', 'team_shared', 'en-only', 'SKILL.en.md'),
      [
        '---',
        'name: english-only-skill',
        'description: English only',
        'user-invocable: true',
        'disable-model-invocation: false',
        '---',
        '',
        'This skill should only load in English mode.',
      ].join('\n'),
    );

    setWorkLanguage('zh');
    {
      const { systemPrompt } = await loadAgentMinds('alice');
      assert.ok(systemPrompt.includes('中文评审技能'));
      assert.ok(!systemPrompt.includes('先梳理改动面，再确认验证路径。'));
      assert.ok(systemPrompt.includes('Neutral fallback skill'));
      assert.ok(!systemPrompt.includes('Use neutral fallback instructions.'));
      assert.ok(systemPrompt.includes('仅 Alice 可见'));
      assert.ok(!systemPrompt.includes('这是 Alice 的个人技能。'));
      assert.ok(!systemPrompt.includes('English only'));
      assert.ok(!systemPrompt.includes('This skill should only load in English mode.'));
    }

    setWorkLanguage('en');
    {
      const { systemPrompt } = await loadAgentMinds('alice');
      assert.ok(systemPrompt.includes('English review skill'));
      assert.ok(!systemPrompt.includes('Map the change surface before proposing verification.'));
      assert.ok(systemPrompt.includes('English only'));
      assert.ok(!systemPrompt.includes('This skill should only load in English mode.'));
      assert.ok(systemPrompt.includes('Neutral fallback skill'));
      assert.ok(!systemPrompt.includes('Use neutral fallback instructions.'));
      assert.ok(!systemPrompt.includes('这是 Alice 的个人技能。'));
    }

    const aliceSkills = await loadWorkspaceSkills({
      rtwsRootAbs: tmpRoot,
      memberId: 'alice',
      language: 'en',
    });
    const reviewer = aliceSkills.find((skill) => skill.id === 'reviewer');
    assert.ok(reviewer);
    assert.deepEqual(reviewer.declaredAllowedTools, ['read_file']);
    assert.equal(reviewer.scope, 'team_shared');
    assert.equal(reviewer.body.trim(), 'Map the change surface before proposing verification.');
    const bobSkills = await loadWorkspaceSkills({
      rtwsRootAbs: tmpRoot,
      memberId: 'bob',
      language: 'en',
    });
    assert.equal(
      bobSkills.some((skill) => skill.id === 'private-notes'),
      false,
    );
    const { agentTools } = await loadAgentMinds('alice');
    assert.equal(
      agentTools.some((tool) => tool.name === 'read_file'),
      false,
      'skill metadata cannot grant a tool',
    );
    assert.ok(agentTools.some((tool) => tool.name === 'read_skill'));
    console.log('skill locale, scope and permission behavior: passed');
  }
}

main().catch((err: unknown) => {
  console.error('❌ skills-i18n test failed', err);
  process.exit(1);
});
