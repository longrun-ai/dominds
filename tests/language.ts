import assert from 'node:assert/strict';
import { detectOsDefaultWorkLanguage } from '../main/shared/runtime-language';
import { normalizeLanguageCode } from '../main/shared/types/language';
import { formatTeammateResponseContent } from '../main/shared/utils/inter-dialog-format';

function run(): void {
  assert.equal(normalizeLanguageCode('en'), 'en');
  assert.equal(normalizeLanguageCode('en-US'), 'en');
  assert.equal(normalizeLanguageCode('zh'), 'zh');
  assert.equal(normalizeLanguageCode('zh-CN'), 'zh');

  assert.equal(detectOsDefaultWorkLanguage({ LANG: 'en_US.UTF-8' }), 'en');
  assert.equal(detectOsDefaultWorkLanguage({ LANG: 'zh_CN.UTF-8' }), 'zh');

  {
    const actual = formatTeammateResponseContent({
      responderId: 'bob',
      requesterId: 'alice',
      originalCallHeadLine: '@bob hello',
      responseBody: 'ok',
      language: 'en',
    });
    const expected = `Hi @alice, @bob provided response:

> ok

to your original call:

> @bob hello
`;
    assert.equal(actual, expected);
  }

  {
    const actual = formatTeammateResponseContent({
      responderId: 'bob',
      requesterId: 'alice',
      originalCallHeadLine: '@bob hello',
      responseBody: 'ok',
      language: 'zh',
    });
    const expected = `你好 @alice，@bob 已回复：

> ok

针对你最初的诉请：

> @bob hello
`;
    assert.equal(actual, expected);
  }

  console.log('language tests: ok');
}

run();
