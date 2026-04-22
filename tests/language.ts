import { normalizeLanguageCode } from '@longrun-ai/kernel/types/language';
import assert from 'node:assert/strict';
import { formatTeammateResponseContent } from '../main/runtime/inter-dialog-format';
import { detectOsDefaultWorkLanguage } from '../main/runtime/work-language';

function run(): void {
  assert.equal(normalizeLanguageCode('en'), 'en');
  assert.equal(normalizeLanguageCode('en-US'), 'en');
  assert.equal(normalizeLanguageCode('zh'), 'zh');
  assert.equal(normalizeLanguageCode('zh-CN'), 'zh');

  assert.equal(detectOsDefaultWorkLanguage({ LANG: 'en_US.UTF-8' }), 'en');
  assert.equal(detectOsDefaultWorkLanguage({ LANG: 'zh_CN.UTF-8' }), 'zh');

  {
    const actual = formatTeammateResponseContent({
      callName: 'tellaskSessionless',
      callId: 'language-en-call',
      responderId: 'bob',
      requesterId: 'alice',
      tellaskContent: '@bob hello',
      responseBody: 'ok',
      status: 'completed',
      language: 'en',
    });
    const expected = `【Completed】

@bob provided response:

> ok

regarding the original tellask: @alice

> @bob hello

[Dominds tellask status]
- Function: \`tellaskSessionless\`
- callId: language-en-call
- Note: This is a reply fact for an earlier tellask, not a new user request or a newly initiated function call in the current course.
`;
    assert.equal(actual, expected);
  }

  {
    const actual = formatTeammateResponseContent({
      callName: 'tellaskSessionless',
      callId: 'language-zh-call',
      responderId: 'bob',
      requesterId: 'alice',
      tellaskContent: '@bob hello',
      responseBody: 'ok',
      status: 'completed',
      language: 'zh',
    });
    const expected = `【最终完成】

@bob 已回复：

> ok

针对原始诉请： @alice

> @bob hello

[Dominds 诉请状态]
- 函数: \`tellaskSessionless\`
- callId: language-zh-call
- 说明: 这是前序诉请的回贴事实，不是新的用户请求，也不是当前程新发起的函数调用。
`;
    assert.equal(actual, expected);
  }

  console.log('language tests: ok');
}

run();
