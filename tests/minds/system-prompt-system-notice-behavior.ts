import assert from 'node:assert/strict';
import { buildSystemPrompt } from '../../main/minds/system-prompt';
import { Team } from '../../main/team';

function buildPrompt(language: 'zh' | 'en', toolsetManualIntro: string): string {
  const agent = new Team.Member({ id: 'tester', name: 'Tester' });
  return buildSystemPrompt({
    language,
    dialogScope: 'mainline',
    contextHealthPromptMode: 'normal',
    agent,
    persona: 'persona',
    knowhow: 'knowhow',
    pitfalls: 'pitfalls',
    skillsText: 'skills',
    envIntro: 'env',
    teamIntro: 'team',
    funcToolRulesText: '',
    policyText: 'policy',
    intrinsicToolUsageText: 'intrinsic',
    toolsetManualIntro,
  });
}

function main(): void {
  const zh = buildPrompt(
    'zh',
    [
      '手册工具：`man`',
      '可用工具集：',
      '- `ws_read`：运行时工作区只读访问：列目录、读文本/图片、检索代码与文本，用于安全获取事实。查看详情：`man({ "toolsetId": "ws_read" })`',
      '何时查阅手册：当某个工具集的功能边界、参数写法、典型场景或报错处理不确定时，调用 `man` 查看详情。',
    ].join('\n'),
  );
  assert.ok(
    zh.includes(
      '如果它没有实质改变你的判断/计划/风险，禁止做任何用户可见回应（禁止写“静默吸收”“已收到”等占位语句）',
    ),
    'zh prompt should explicitly forbid placeholder replies to irrelevant system notices',
  );
  assert.ok(
    zh.includes('可用工具集：'),
    'zh prompt should include a structured available-toolsets section',
  );
  assert.ok(
    zh.includes(
      '`ws_read`：运行时工作区只读访问：列目录、读文本/图片、检索代码与文本，用于安全获取事实。查看详情：`man({ "toolsetId": "ws_read" })`',
    ),
    'zh prompt should expose toolset descriptions and man call examples',
  );
  assert.ok(
    zh.includes('直接传 `effort: 3`') &&
      zh.includes('`x3` 是绝对力度') &&
      zh.includes('不是“当前 `fbr_effort` 再乘 3”'),
    'zh prompt should clarify that FBR x3 maps to absolute effort 3 instead of multiplying the default',
  );

  const en = buildPrompt(
    'en',
    [
      'Manual tool: `man`',
      'Available toolsets:',
      '- `ws_read`: rtws read-only access: list directories, read text/images, and search code/content to gather facts safely. Details: `man({ "toolsetId": "ws_read" })`',
      'When to read the manual: call `man` when a toolset’s boundaries, argument shape, typical scenarios, or error handling are unclear.',
    ].join('\n'),
  );
  assert.ok(
    en.includes(
      'if they do not materially change your judgment/plan/risk, make no user-visible reply at all',
    ),
    'en prompt should explicitly forbid placeholder replies to irrelevant system notices',
  );
  assert.ok(
    en.includes('Available toolsets:'),
    'en prompt should include a structured available-toolsets section',
  );
  assert.ok(
    en.includes(
      '`ws_read`: rtws read-only access: list directories, read text/images, and search code/content to gather facts safely. Details: `man({ "toolsetId": "ws_read" })`',
    ),
    'en prompt should expose toolset descriptions and man call examples',
  );
  assert.ok(
    en.includes('pass `effort: 3` directly') &&
      en.includes('`x3` is the absolute effort value') &&
      en.includes('not “3 × current fbr_effort”'),
    'en prompt should clarify that FBR x3 maps to absolute effort 3 instead of multiplying the default',
  );

  console.log('OK');
}

main();
