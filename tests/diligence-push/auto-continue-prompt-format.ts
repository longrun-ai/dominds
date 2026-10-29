import assert from 'node:assert/strict';

import { formatDiligenceAutoContinuePrompt } from '../../main/runtime/driver-messages';

// These are opaque payloads: preserve the supplied body, not prescribed wording.
for (const language of ['zh', 'en'] as const) {
  const body = `payload-${language}-7c8a\n{ "reference": "task-42" }`;
  const output = formatDiligenceAutoContinuePrompt(language, body);
  assert.ok(output.endsWith(body), 'the caller-supplied continuation body must survive wrapping');
  assert.throws(() => formatDiligenceAutoContinuePrompt(language, ''), { name: 'Error' });
}

console.log('diligence continuation body preservation: PASS');
