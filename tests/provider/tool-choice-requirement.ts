import assert from 'node:assert/strict';
import type { ChatGptTool } from '@longrun-ai/codex-auth';
import type { Tool } from 'openai/resources/responses/responses';
import { resolveCodexToolChoice } from '../../main/llm/gen/codex';
import type { LlmRequestContext } from '../../main/llm/gen';
import { resolveOpenAiToolChoice } from '../../main/llm/gen/openai';

const baseContext: LlmRequestContext = {
  dialogSelfId: 'tool-choice-test',
  dialogRootId: 'tool-choice-test',
};

const openAiTool = {
  type: 'function',
  name: 'askHuman',
  description: 'Ask the human.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  strict: true,
} as unknown as Tool;

const codexTool: ChatGptTool = {
  type: 'function',
  name: 'askHuman',
  description: 'Ask the human.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
};

assert.equal(resolveOpenAiToolChoice([openAiTool], baseContext), 'auto');
assert.equal(
  resolveOpenAiToolChoice([openAiTool], { ...baseContext, toolUseRequirement: 'required' }),
  'required',
);
assert.equal(
  resolveOpenAiToolChoice([openAiTool], { ...baseContext, toolUseRequirement: 'none' }),
  'none',
);
assert.throws(
  () => resolveOpenAiToolChoice([], { ...baseContext, toolUseRequirement: 'required' }),
  /toolUseRequirement=required but no tools are available/,
);

assert.equal(resolveCodexToolChoice([codexTool], baseContext), 'auto');
assert.equal(
  resolveCodexToolChoice([codexTool], { ...baseContext, toolUseRequirement: 'required' }),
  'required',
);
assert.equal(
  resolveCodexToolChoice([codexTool], { ...baseContext, toolUseRequirement: 'none' }),
  'none',
);
assert.throws(
  () => resolveCodexToolChoice([], { ...baseContext, toolUseRequirement: 'required' }),
  /toolUseRequirement=required but no tools are available/,
);

console.log('provider tool-choice requirement: PASS');
