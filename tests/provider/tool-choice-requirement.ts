import type { ChatGptTool } from '@longrun-ai/codex-auth';
import assert from 'node:assert/strict';
import type { Tool } from 'openai/resources/responses/responses';
import type { LlmRequestContext } from '../../main/llm/gen';
import { resolveCodexToolChoice } from '../../main/llm/gen/codex';
import { resolveOpenAiToolChoice } from '../../main/llm/gen/openai';
import { resolveOpenAiCompatibleToolChoice } from '../../main/llm/gen/openai-compatible';
import type { FuncTool } from '../../main/tool';

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

const openAiCompatibleTool: FuncTool = {
  type: 'func',
  name: 'askHuman',
  description: 'Ask the human.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  call: async () => {
    throw new Error('not executed');
  },
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

assert.equal(resolveOpenAiCompatibleToolChoice([openAiCompatibleTool], baseContext), 'auto');
assert.equal(
  resolveOpenAiCompatibleToolChoice([openAiCompatibleTool], {
    ...baseContext,
    toolUseRequirement: 'required',
  }),
  'required',
);
assert.equal(
  resolveOpenAiCompatibleToolChoice(
    [openAiCompatibleTool],
    { ...baseContext, toolUseRequirement: 'required' },
    { supports_tool_choice: false },
  ),
  undefined,
);
assert.equal(
  resolveOpenAiCompatibleToolChoice(
    [openAiCompatibleTool],
    { ...baseContext, toolUseRequirement: 'none' },
    { supports_tool_choice: false },
  ),
  undefined,
);
assert.throws(
  () =>
    resolveOpenAiCompatibleToolChoice(
      [],
      { ...baseContext, toolUseRequirement: 'required' },
      { supports_tool_choice: false },
    ),
  /toolUseRequirement=required but no tools are available/,
);

console.log('provider tool-choice requirement: PASS');
