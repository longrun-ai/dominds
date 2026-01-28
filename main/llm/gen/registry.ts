/**
 * Module: llm/gen/registry
 *
 * Registry for `LlmGenerator` implementations and built-in initialization.
 */
import { LlmGenerator } from '../gen';
import { AnthropicGen } from './anthropic';
import { CodexGen } from './codex';
import { MockGen } from './mock';
import { OpenAiGen } from './openai';

export const generatorsRegistry: Map<string, LlmGenerator> = new Map<string, LlmGenerator>();

export function registerLlmGenerator(gen: LlmGenerator): void {
  generatorsRegistry.set(gen.apiType, gen);
}

export function unregisterLlmGenerator(apiType: string): void {
  generatorsRegistry.delete(apiType);
}

export function getLlmGenerator(apiType: string): LlmGenerator | undefined {
  return generatorsRegistry.get(apiType);
}

(function initializeBuiltins() {
  registerLlmGenerator(new AnthropicGen());
  registerLlmGenerator(new CodexGen());
  registerLlmGenerator(new MockGen());
  registerLlmGenerator(new OpenAiGen());
})();
