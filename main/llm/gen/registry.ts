/**
 * Module: llm/gen/registry
 *
 * Registry for `LlmGenerator` implementations and built-in initialization.
 */
import { LlmGenerator } from '../gen';
import { AnthropicGen } from './anthropic';
import { MockGen } from './mock';

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
  registerLlmGenerator(new MockGen());
})();
