import assert from 'node:assert/strict';
import yaml from 'yaml';

/** Parse the public YAML data block, not the meaning of summary/next prose. */
export function toolOutputData(content: string): Record<string, unknown> {
  const block = /^```yaml\r?\n([\s\S]*?)\r?\n```/m.exec(content);
  assert.ok(block, 'expected a complete public YAML data block');
  const data: unknown = yaml.parse(block[1]);
  assert.ok(data !== null && typeof data === 'object' && !Array.isArray(data));
  return data as Record<string, unknown>;
}
