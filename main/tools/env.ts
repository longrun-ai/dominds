/**
 * Module: tools/env
 *
 * Runtime environment variable tools for local development/testing.
 *
 * These mutate the Dominds server process environment (process.env) at runtime.
 * Intended for MCP/LLM integration testing (e.g., hot-edit env vars referenced by `.minds/mcp.yaml`).
 */

import type { Dialog } from '../dialog';
import { createLogger } from '../log';
import { Team } from '../team';
import type { FuncTool, JsonSchema, ToolArguments } from '../tool';

const log = createLogger('tools/env');

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const DEFAULT_ALLOWED_PREFIXES: ReadonlyArray<string> = ['MCP_', 'UX_', 'DOMINDS_TEST_'];
const DEFAULT_ALLOWED_EXACT: ReadonlyArray<string> = ['DOMINDS_LOG_LEVEL'];

function isAllowedEnvKey(key: string): boolean {
  if (!ENV_KEY_RE.test(key)) return false;
  if (DEFAULT_ALLOWED_EXACT.includes(key)) return true;
  for (const p of DEFAULT_ALLOWED_PREFIXES) {
    if (key.startsWith(p)) return true;
  }
  return false;
}

function isSensitiveKeyName(key: string): boolean {
  const upper = key.toUpperCase();
  return (
    upper.includes('KEY') ||
    upper.includes('TOKEN') ||
    upper.includes('SECRET') ||
    upper.includes('PASSWORD')
  );
}

function redactValue(value: string): string {
  if (value.length <= 4) return '<redacted>';
  return `<redacted len=${value.length} prefix=${JSON.stringify(value.slice(0, 2))} suffix=${JSON.stringify(value.slice(-2))}>`;
}

type EnvGetArgs = Readonly<{
  key: string;
  reveal?: boolean;
}>;

type EnvSetArgs = Readonly<{
  key: string;
  value: string;
}>;

type EnvUnsetArgs = Readonly<{
  key: string;
}>;

function parseEnvGetArgs(args: ToolArguments): EnvGetArgs {
  const key = args.key;
  if (typeof key !== 'string' || !key.trim()) {
    throw new Error(`env_get.key must be a non-empty string`);
  }
  const revealVal = args.reveal;
  if (revealVal !== undefined && typeof revealVal !== 'boolean') {
    throw new Error(`env_get.reveal must be a boolean if provided`);
  }
  return { key, reveal: revealVal };
}

function parseEnvSetArgs(args: ToolArguments): EnvSetArgs {
  const key = args.key;
  if (typeof key !== 'string' || !key.trim()) {
    throw new Error(`env_set.key must be a non-empty string`);
  }
  const value = args.value;
  if (typeof value !== 'string') {
    throw new Error(`env_set.value must be a string`);
  }
  return { key, value };
}

function parseEnvUnsetArgs(args: ToolArguments): EnvUnsetArgs {
  const key = args.key;
  if (typeof key !== 'string' || !key.trim()) {
    throw new Error(`env_unset.key must be a non-empty string`);
  }
  return { key };
}

const envGetSchema: JsonSchema = {
  type: 'object',
  properties: {
    key: { type: 'string', description: 'Environment variable name to read' },
    reveal: {
      type: 'boolean',
      description:
        'When true, returns the raw value. For keys that look like secrets, default is redacted unless reveal=true.',
    },
  },
  required: ['key'],
  additionalProperties: false,
};

const envSetSchema: JsonSchema = {
  type: 'object',
  properties: {
    key: { type: 'string', description: 'Environment variable name to set' },
    value: { type: 'string', description: 'Value to set (string)' },
  },
  required: ['key', 'value'],
  additionalProperties: false,
};

const envUnsetSchema: JsonSchema = {
  type: 'object',
  properties: {
    key: { type: 'string', description: 'Environment variable name to remove' },
  },
  required: ['key'],
  additionalProperties: false,
};

function assertAllowedKey(key: string): void {
  if (!isAllowedEnvKey(key)) {
    throw new Error(
      `env key '${key}' is not allowed. Allowed: ${[
        ...DEFAULT_ALLOWED_EXACT,
        ...DEFAULT_ALLOWED_PREFIXES.map((p) => `${p}*`),
      ].join(', ')}`,
    );
  }
}

export const envGetTool: FuncTool = {
  type: 'func',
  name: 'env_get',
  description: 'Get an environment variable from the Dominds server process (local testing only).',
  descriptionI18n: {
    en: 'Get an environment variable from the Dominds server process (local testing only).',
    zh: '读取 Dominds 服务进程的环境变量（仅用于本地测试）。',
  },
  parameters: envGetSchema,
  argsValidation: 'dominds',
  call: async (_dlg: Dialog, caller: Team.Member, args: ToolArguments) => {
    const parsed = parseEnvGetArgs(args);
    assertAllowedKey(parsed.key);

    const raw = process.env[parsed.key];
    const value = raw === undefined ? undefined : String(raw);

    log.info('env_get', undefined, {
      caller: caller.id,
      key: parsed.key,
      hasValue: value !== undefined,
    });

    if (value === undefined) return '(unset)';
    if (parsed.reveal === true) return value;
    if (isSensitiveKeyName(parsed.key)) return redactValue(value);
    return value;
  },
};

export const envSetTool: FuncTool = {
  type: 'func',
  name: 'env_set',
  description: 'Set an environment variable in the Dominds server process (local testing only).',
  descriptionI18n: {
    en: 'Set an environment variable in the Dominds server process (local testing only).',
    zh: '设置 Dominds 服务进程的环境变量（仅用于本地测试）。',
  },
  parameters: envSetSchema,
  argsValidation: 'dominds',
  call: async (_dlg: Dialog, caller: Team.Member, args: ToolArguments) => {
    const parsed = parseEnvSetArgs(args);
    assertAllowedKey(parsed.key);

    const prev = process.env[parsed.key];
    process.env[parsed.key] = parsed.value;

    log.warn('env_set', undefined, {
      caller: caller.id,
      key: parsed.key,
      prevSet: prev !== undefined,
      nextLen: parsed.value.length,
    });

    const prevStr =
      prev === undefined
        ? '(unset)'
        : isSensitiveKeyName(parsed.key)
          ? redactValue(String(prev))
          : String(prev);
    const nextStr = isSensitiveKeyName(parsed.key) ? redactValue(parsed.value) : parsed.value;
    return `ok: ${parsed.key}\nprev: ${prevStr}\nnext: ${nextStr}`;
  },
};

export const envUnsetTool: FuncTool = {
  type: 'func',
  name: 'env_unset',
  description: 'Unset an environment variable in the Dominds server process (local testing only).',
  descriptionI18n: {
    en: 'Unset an environment variable in the Dominds server process (local testing only).',
    zh: '删除 Dominds 服务进程的环境变量（仅用于本地测试）。',
  },
  parameters: envUnsetSchema,
  argsValidation: 'dominds',
  call: async (_dlg: Dialog, caller: Team.Member, args: ToolArguments) => {
    const parsed = parseEnvUnsetArgs(args);
    assertAllowedKey(parsed.key);

    const prev = process.env[parsed.key];
    delete process.env[parsed.key];

    log.warn('env_unset', undefined, {
      caller: caller.id,
      key: parsed.key,
      prevSet: prev !== undefined,
    });

    const prevStr =
      prev === undefined
        ? '(unset)'
        : isSensitiveKeyName(parsed.key)
          ? redactValue(String(prev))
          : String(prev);
    return `ok: ${parsed.key}\nprev: ${prevStr}\nnext: (unset)`;
  },
};
