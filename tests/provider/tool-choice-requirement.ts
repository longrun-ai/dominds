import type { ChatGptTool } from '@longrun-ai/codex-auth';
import assert from 'node:assert/strict';
import type { Tool } from 'openai/resources/responses/responses';
import type { LlmRequestContext } from '../../main/llm/gen';
import { resolveCodexToolChoice } from '../../main/llm/gen/codex';
import { resolveOpenAiToolChoice } from '../../main/llm/gen/openai';
import { resolveOpenAiCompatibleToolChoice } from '../../main/llm/gen/openai-compatible';
import type { FuncTool } from '../../main/tool';
import { semanticEvidenceCollector } from '../helpers/semantic-evidence';
const evidence = semanticEvidenceCollector('dominds-provider-tool-choice-');

let refusals = 0;
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
} satisfies Tool;

const codexTool: ChatGptTool = {
  type: 'function',
  strict: false,
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
  (error: unknown) => {
    assert.ok(error instanceof Error);
    evidence.record({
      id: 'required-without-tools-' + refusals++,
      scenario:
        'A local provider resolver is asked to require a tool with an empty supplied tool list.',
      businessValue: 'Invalid mandatory-tool requests stop locally with actionable diagnostics.',
      context: {
        provider: ['openai', 'codex', 'openai-compatible'][refusals - 1]!,
        tools: 0,
        requirement: 'required',
        compatibleSupportsToolChoice: refusals === 3 ? 'false' : 'not applicable',
        scope: 'Pure public choice resolver; no request is sent and no tool is executed.',
      },
      reviewQuestions: [
        'Does the actual refusal explain the impossible mandatory-tool request accurately and identify its scope?',
      ],
      actualText: error.message,
    });
    return true;
  },
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
  (error: unknown) => {
    assert.ok(error instanceof Error);
    evidence.record({
      id: 'required-without-tools-' + refusals++,
      scenario:
        'A local provider resolver is asked to require a tool with an empty supplied tool list.',
      businessValue: 'Invalid mandatory-tool requests stop locally with actionable diagnostics.',
      context: {
        provider: ['openai', 'codex', 'openai-compatible'][refusals - 1]!,
        tools: 0,
        requirement: 'required',
        compatibleSupportsToolChoice: refusals === 3 ? 'false' : 'not applicable',
        scope: 'Pure public choice resolver; no request is sent and no tool is executed.',
      },
      reviewQuestions: [
        'Does the actual refusal explain the impossible mandatory-tool request accurately and identify its scope?',
      ],
      actualText: error.message,
    });
    return true;
  },
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
  (error: unknown) => {
    assert.ok(error instanceof Error);
    evidence.record({
      id: 'required-without-tools-' + refusals++,
      scenario:
        'A local provider resolver is asked to require a tool with an empty supplied tool list.',
      businessValue: 'Invalid mandatory-tool requests stop locally with actionable diagnostics.',
      context: {
        provider: ['openai', 'codex', 'openai-compatible'][refusals - 1]!,
        tools: 0,
        requirement: 'required',
        compatibleSupportsToolChoice: refusals === 3 ? 'false' : 'not applicable',
        scope: 'Pure public choice resolver; no request is sent and no tool is executed.',
      },
      reviewQuestions: [
        'Does the actual refusal explain the impossible mandatory-tool request accurately and identify its scope?',
      ],
      actualText: error.message,
    });
    return true;
  },
);

for (const requirement of ['auto', 'none'] as const) {
  assert.equal(
    resolveOpenAiToolChoice([], { ...baseContext, toolUseRequirement: requirement }),
    'none',
  );
  assert.equal(
    resolveCodexToolChoice([], { ...baseContext, toolUseRequirement: requirement }),
    'none',
  );
  assert.equal(
    resolveOpenAiCompatibleToolChoice([], { ...baseContext, toolUseRequirement: requirement }),
    'none',
  );
}
assert.equal(refusals, 3);
void evidence
  .write()
  .then(() => console.log('provider tool-choice requirement: PASS'))
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
