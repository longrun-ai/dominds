import assert from 'node:assert/strict';
import { mergeModelParams } from '../../main/llm/kernel-driver/guardrails';
import type { Team } from '../../main/team';

const base: Team.ModelParams = {
  json_response: false,
  codex: { reasoning_effort: 'low' },
  openai: { temperature: 0.2 },
  'openai-compatible': { temperature: 0.3 },
  anthropic: { max_tokens: 1024 },
  'anthropic-compatible': { temperature: 0.4, thinking: false },
};

const overlay: Team.ModelParams = {
  json_response: true,
  codex: { reasoning_effort: 'high' },
  openai: { top_p: 0.9 },
  'openai-compatible': { top_p: 0.8 },
  anthropic: { temperature: 0.1 },
  'anthropic-compatible': { thinking: true },
};

const merged = mergeModelParams(base, overlay);
assert.deepEqual(merged, {
  json_response: true,
  codex: { reasoning_effort: 'high' },
  openai: { temperature: 0.2, top_p: 0.9 },
  'openai-compatible': { temperature: 0.3, top_p: 0.8 },
  anthropic: { max_tokens: 1024, temperature: 0.1 },
  'anthropic-compatible': { temperature: 0.4, thinking: true },
});

console.log('✓ FBR model_params merge preserves all provider namespaces');
