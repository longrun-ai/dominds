import fs from 'fs/promises';
import path from 'path';
import YAML from 'yaml';

import { log } from '../log';

const BUILTIN_DEFAULTS_YAML_PATH = path.join(__dirname, 'defaults.yaml');

// Special-case cache: built-in defaults are immutable at runtime, so this file may be cached
// forever to survive dogfooding rebuild windows. Do not generalize this to rtws/user-editable files.
let builtinDefaultsYamlRawCache: string | undefined;
let builtinDefaultsYamlRawReadPromise: Promise<string> | undefined;

export type {
  ChatMessage,
  EnvironmentMsg,
  FuncCallMsg,
  FuncResultMsg,
  PromptingMsg,
  SayingMsg,
  TellaskCarryoverMsg,
  TellaskResultMsg,
  ThinkingMsg,
  TransientGuideMsg,
} from '@longrun-ai/kernel/types/chat-message';

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
      value_labels?: Record<string, string>;
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
  // Optional gateway-specific behavior switches for non-standard transport quirks. Accept either a
  // single string shorthand or a string array in YAML. Quirks may register provider-specific
  // failure handlers that override the driver's default retry disposition for matched failures.
  apiQuirks?: string | string[];
  baseUrl: string;
  apiKeyEnvVar: string;
  // Transport-level cap for a single tool result text payload before provider projection.
  // Different providers / gateways may enforce different per-item string limits.
  tool_result_max_chars?: number;
  // LLM retry policy knobs for kernel dialog driving.
  // aggressive_max_retries limits only the front-loaded fast retry burst. Once exhausted,
  // provider/runtime failures still keep retrying automatically after downgrading to conservative.
  llm_retry_aggressive_max_retries?: number;
  llm_retry_initial_delay_ms?: number;
  llm_retry_conservative_delay_ms?: number;
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
    const rawDefaults = await readBuiltinDefaultsYamlRaw();
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

export function getBuiltinDefaultsYamlPath(): string {
  return BUILTIN_DEFAULTS_YAML_PATH;
}

export async function readBuiltinDefaultsYamlRaw(): Promise<string> {
  if (builtinDefaultsYamlRawCache !== undefined) return builtinDefaultsYamlRawCache;

  if (builtinDefaultsYamlRawReadPromise === undefined) {
    builtinDefaultsYamlRawReadPromise = fs
      .readFile(BUILTIN_DEFAULTS_YAML_PATH, 'utf-8')
      .then((raw) => {
        const parsed: unknown = YAML.parse(raw);
        if (!isRecord(parsed) || !isRecord(parsed.providers)) {
          throw new Error('Invalid defaults.yaml: expected providers object');
        }
        builtinDefaultsYamlRawCache = raw;
        return raw;
      })
      .catch((error: unknown) => {
        builtinDefaultsYamlRawReadPromise = undefined;
        throw error;
      });
  }

  return builtinDefaultsYamlRawReadPromise;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
