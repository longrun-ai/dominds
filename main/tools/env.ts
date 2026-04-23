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
import type { FuncTool, JsonSchema, ToolArguments, ToolCallOutput } from '../tool';
import { toolSuccess } from '../tool';

const log = createLogger('tools/env');

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

type EnvGetArgs = Readonly<{
  key: string;
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
  assertValidEnvKey('env_get', key);
  return { key };
}

function parseEnvSetArgs(args: ToolArguments): EnvSetArgs {
  const key = args.key;
  if (typeof key !== 'string' || !key.trim()) {
    throw new Error(`env_set.key must be a non-empty string`);
  }
  assertValidEnvKey('env_set', key);
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
  assertValidEnvKey('env_unset', key);
  return { key };
}

const envGetSchema: JsonSchema = {
  type: 'object',
  properties: {
    key: { type: 'string', description: 'Environment variable name to read' },
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

function assertValidEnvKey(toolName: string, key: string): void {
  if (!ENV_KEY_RE.test(key)) {
    throw new Error(
      `${toolName}.key must be a valid environment variable name matching ${ENV_KEY_RE.source}`,
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
  call: async (_dlg: Dialog, caller: Team.Member, args: ToolArguments): Promise<ToolCallOutput> => {
    const parsed = parseEnvGetArgs(args);

    const raw = process.env[parsed.key];
    const value = raw === undefined ? undefined : String(raw);

    log.debug('env_get', undefined, {
      caller: caller.id,
      key: parsed.key,
      hasValue: value !== undefined,
    });

    if (value === undefined) return toolSuccess('(unset)');
    return toolSuccess(value);
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
  call: async (_dlg: Dialog, caller: Team.Member, args: ToolArguments): Promise<ToolCallOutput> => {
    const parsed = parseEnvSetArgs(args);

    const prev = process.env[parsed.key];
    process.env[parsed.key] = parsed.value;

    log.warn('env_set', undefined, {
      caller: caller.id,
      key: parsed.key,
      prevSet: prev !== undefined,
      nextLen: parsed.value.length,
    });

    const prevStr = prev === undefined ? '(unset)' : String(prev);
    const nextStr = parsed.value;
    return toolSuccess(`ok: ${parsed.key}\nprev: ${prevStr}\nnext: ${nextStr}`);
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
  call: async (_dlg: Dialog, caller: Team.Member, args: ToolArguments): Promise<ToolCallOutput> => {
    const parsed = parseEnvUnsetArgs(args);

    const prev = process.env[parsed.key];
    delete process.env[parsed.key];

    log.warn('env_unset', undefined, {
      caller: caller.id,
      key: parsed.key,
      prevSet: prev !== undefined,
    });

    const prevStr = prev === undefined ? '(unset)' : String(prev);
    return toolSuccess(`ok: ${parsed.key}\nprev: ${prevStr}\nnext: (unset)`);
  },
};
