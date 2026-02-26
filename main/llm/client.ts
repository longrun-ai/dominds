import fs from 'fs/promises';
import path from 'path';
import YAML from 'yaml';

import { log } from '../log';
import type { FuncResultContentItem, ProviderData } from '../shared/types/storage';

export type EnvironmentMsg = {
  type: 'environment_msg';
  role: 'user';
  content: string;
};

export type TransientGuideMsg = {
  type: 'transient_guide_msg';
  role: 'assistant';
  content: string;
};

export type PromptingMsg = {
  type: 'prompting_msg';
  role: 'user';
  genseq: number;
  msgId: string;
  content: string;
  grammar: 'markdown';
};

export type SayingMsg = {
  type: 'saying_msg';
  role: 'assistant';
  genseq: number;
  content: string;
  provider_data?: ProviderData;
};

export type UiOnlyMarkdownMsg = {
  type: 'ui_only_markdown_msg';
  role: 'assistant';
  genseq: number;
  content: string;
};

export type ThinkingMsg = {
  type: 'thinking_msg';
  role: 'assistant';
  genseq: number;
  content: string;
  provider_data?: ProviderData;
};

export type FuncCallMsg = {
  type: 'func_call_msg';
  role: 'assistant';
  genseq: number;
  id: string;
  name: string;
  arguments: string;
  provider_data?: ProviderData;
};

export type FuncResultMsg = {
  type: 'func_result_msg';
  role: 'tool';
  genseq: number;
  id: string;
  name: string;
  content: string;
  contentItems?: FuncResultContentItem[];
};

export type TellaskCallResultMsg = {
  type: 'tellask_result_msg';
  role: 'tool';
  responderId: string; // id of tool only
  mentionList?: string[];
  tellaskContent: string;
  status: 'completed' | 'failed';
  content: string;
  // Optional internal correlation key used for context projection.
  // UI navigation still relies on response events.
  callId?: string;
};

export type ChatMessage =
  | EnvironmentMsg
  | TransientGuideMsg
  | PromptingMsg
  | SayingMsg
  | UiOnlyMarkdownMsg
  | ThinkingMsg
  | FuncCallMsg
  | FuncResultMsg
  | TellaskCallResultMsg;

export interface ModelInfo {
  name?: string; // Optional, defaults to model key if not specified
  context_length?: number;
  input_length?: number;
  output_length?: number;
  optimal_max_tokens?: number;
  critical_max_tokens?: number;
  caution_remediation_cadence_generations?: number;
  context_window?: string;
  [key: string]: unknown;
}

type ModelParamOptionBase = {
  description: string;
  // Documentation hint: if true, UIs/manuals should call this out and prefer requiring an explicit
  // choice (instead of silently relying on provider/model defaults).
  prominent?: boolean;
};

export type ModelParamOption =
  | (ModelParamOptionBase & {
      type: 'number';
      min?: number;
      max?: number;
      default?: number;
    })
  | (ModelParamOptionBase & {
      type: 'integer';
      min?: number;
      max?: number;
      default?: number;
    })
  | (ModelParamOptionBase & {
      type: 'boolean';
      default?: boolean;
    })
  | (ModelParamOptionBase & {
      type: 'string';
      default?: string;
    })
  | (ModelParamOptionBase & {
      type: 'string_array';
      default?: string[];
    })
  | (ModelParamOptionBase & {
      type: 'record_number';
      default?: Record<string, number>;
    })
  | (ModelParamOptionBase & {
      type: 'enum';
      values: string[];
      default?: string;
    });

export type ProviderModelParamOptions = {
  general?: Record<string, ModelParamOption>;
  codex?: Record<string, ModelParamOption>;
  openai?: Record<string, ModelParamOption>;
  anthropic?: Record<string, ModelParamOption>;
};

export type ProviderApiType = 'codex' | 'anthropic' | 'mock' | 'openai' | 'openai-compatible';

export type ProviderConfig = {
  name: string;
  apiType: ProviderApiType;
  baseUrl: string;
  apiKeyEnvVar: string;
  // LLM retry policy knobs for driver-v2.
  // maxRetries means "extra retries after initial attempt". For example, 5 => up to 6 attempts total.
  llm_retry_max_retries?: number;
  llm_retry_initial_delay_ms?: number;
  llm_retry_backoff_multiplier?: number;
  llm_retry_max_delay_ms?: number;
  tech_spec_url?: string;
  api_mgmt_url?: string;
  model_param_options?: ProviderModelParamOptions;
  models: Record<string, ModelInfo>;
};

/**
 * LlmConfig
 *
 * Wraps provider configurations and exposes lookup helpers.
 */
export class LlmConfig {
  private _providers: Record<string, ProviderConfig>;
  constructor(providers: Record<string, ProviderConfig>) {
    this._providers = providers;
  }

  get providers(): Record<string, ProviderConfig> {
    return this._providers;
  }

  getProvider(providerKey: string): ProviderConfig | undefined {
    return this._providers[providerKey];
  }
}

export namespace LlmConfig {
  export async function load(): Promise<LlmConfig> {
    // Load default providers from YAML file
    const defaultsPath = path.join(__dirname, 'defaults.yaml');
    const rawDefaults = await fs.readFile(defaultsPath, 'utf-8');
    const parsedDefaults: unknown = YAML.parse(rawDefaults);
    if (!isRecord(parsedDefaults) || !isRecord(parsedDefaults.providers)) {
      throw new Error('Invalid defaults.yaml: expected providers object');
    }
    const defaultProviders: Record<string, ProviderConfig> = parsedDefaults.providers as Record<
      string,
      ProviderConfig
    >;

    // Load rtws configuration
    const cfgPath = '.minds/llm.yaml';
    let workspaceProviders: Record<string, ProviderConfig> = {};

    try {
      await fs.access(cfgPath);
      try {
        const raw = await fs.readFile(cfgPath, 'utf-8');
        const parsed: unknown = YAML.parse(raw);
        const providers = isRecord(parsed) ? parsed.providers : undefined;
        if (isRecord(providers)) {
          workspaceProviders = providers as Record<string, ProviderConfig>;
        } else {
          throw new Error('Invalid llm.yaml: missing providers object');
        }
      } catch (error) {
        log.warn('Could not load rtws llm.yaml:', error);
      }
    } catch (err) {
      log.debug('No rtws llm.yaml found, using defaults');
    }

    // Merge defaults with rtws config (rtws overrides defaults)
    const mergedProviders = { ...defaultProviders, ...workspaceProviders };

    return new LlmConfig(mergedProviders);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
