import { normalizeLanguageCode } from '@longrun-ai/kernel/types/language';
import assert from 'node:assert/strict';
import { detectOsDefaultWorkLanguage } from '../main/runtime/work-language';

function run(): void {
  assert.equal(normalizeLanguageCode('en'), 'en');
  assert.equal(normalizeLanguageCode('en-US'), 'en');
  assert.equal(normalizeLanguageCode('zh'), 'zh');
  assert.equal(normalizeLanguageCode('zh-CN'), 'zh');

  assert.equal(detectOsDefaultWorkLanguage({ LANG: 'en_US.UTF-8' }), 'en');
  assert.equal(detectOsDefaultWorkLanguage({ LANG: 'zh_CN.UTF-8' }), 'zh');

  console.log('language tests: ok');
}

run();
