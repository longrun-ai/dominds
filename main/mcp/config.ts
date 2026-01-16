import YAML from 'yaml';
import { createLogger } from '../log';
import type { ToolNameTransform } from './tool-names';

const log = createLogger('mcp/config');

export type McpEnvValue = { kind: 'literal'; value: string } | { kind: 'from_env'; env: string };

export type McpHeaderValue = { kind: 'literal'; value: string } | { kind: 'from_env'; env: string };

export type McpTransport = 'stdio' | 'streamable_http';

type McpServerConfigBase = {
  serverId: string;
  tools: {
    whitelist: string[];
    blacklist: string[];
  };
  transform: ToolNameTransform[];
};

export type McpStdioServerConfig = McpServerConfigBase & {
  transport: 'stdio';
  command: string;
  args: string[];
  env: Record<string, McpEnvValue>;
};

export type McpStreamableHttpServerConfig = McpServerConfigBase & {
  transport: 'streamable_http';
  url: string;
  headers: Record<string, McpHeaderValue>;
  sessionId?: string;
};

export type McpServerConfig = McpStdioServerConfig | McpStreamableHttpServerConfig;

export type McpWorkspaceConfig = {
  version: 1;
  servers: Record<string, McpServerConfig>;
};

export type McpConfigLoadResult =
  | {
      ok: true;
      config: McpWorkspaceConfig;
      invalidServers: ReadonlyArray<{ serverId: string; errorText: string }>;
      serverIdsInYamlOrder: ReadonlyArray<string>;
      validServerIdsInYamlOrder: ReadonlyArray<string>;
      rawText: string;
    }
  | { ok: false; errorText: string; rawText?: string };

/**
 * NOTE: This loader parses external YAML (untrusted input). Runtime type checks are unavoidable
 * here to keep the core code statically safe.
 */
export function parseMcpYaml(rawText: string): McpConfigLoadResult {
  const doc = YAML.parseDocument(rawText, { prettyErrors: true });
  if (doc.errors.length > 0) {
    const errText = doc.errors.map((e) => String(e)).join('\n');
    return { ok: false, errorText: errText, rawText };
  }

  const parsed: unknown = doc.toJS();
  try {
    const res = parseWorkspaceConfig(parsed);
    return {
      ok: true,
      config: res.config,
      invalidServers: res.invalidServers,
      serverIdsInYamlOrder: res.serverIdsInYamlOrder,
      validServerIdsInYamlOrder: res.validServerIdsInYamlOrder,
      rawText,
    };
  } catch (err) {
    return { ok: false, errorText: err instanceof Error ? err.message : String(err), rawText };
  }
}

function parseWorkspaceConfig(value: unknown): {
  config: McpWorkspaceConfig;
  invalidServers: ReadonlyArray<{ serverId: string; errorText: string }>;
  serverIdsInYamlOrder: ReadonlyArray<string>;
  validServerIdsInYamlOrder: ReadonlyArray<string>;
} {
  const root = asRecord(value, 'mcp.yaml root');

  const version = root.version;
  if (version !== 1) {
    throw new Error(`Invalid mcp.yaml: expected version: 1`);
  }

  const serversVal = root.servers;
  const serversRecord = serversVal === undefined ? {} : asRecord(serversVal, 'servers');
  const servers: Record<string, McpServerConfig> = {};
  const invalidServers: Array<{ serverId: string; errorText: string }> = [];
  const serverIdsInYamlOrder: string[] = [];
  const validServerIdsInYamlOrder: string[] = [];

  for (const [serverId, serverRaw] of Object.entries(serversRecord)) {
    serverIdsInYamlOrder.push(serverId);
    try {
      servers[serverId] = parseServerConfig(serverId, serverRaw);
      validServerIdsInYamlOrder.push(serverId);
    } catch (err) {
      invalidServers.push({
        serverId,
        errorText: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    config: { version: 1, servers },
    invalidServers,
    serverIdsInYamlOrder,
    validServerIdsInYamlOrder,
  };
}

function parseServerConfig(serverId: string, value: unknown): McpServerConfig {
  const obj = asRecord(value, `servers.${serverId}`);

  const transport = obj.transport;
  if (transport !== 'stdio' && transport !== 'streamable_http') {
    throw new Error(
      `Invalid mcp.yaml: servers.${serverId}.transport must be 'stdio' or 'streamable_http'`,
    );
  }

  const toolsVal = obj.tools;
  const toolsObj = toolsVal === undefined ? {} : asRecord(toolsVal, `servers.${serverId}.tools`);
  const whitelist = parseStringArrayOptional(
    toolsObj.whitelist,
    `servers.${serverId}.tools.whitelist`,
  );
  const blacklist = parseStringArrayOptional(
    toolsObj.blacklist,
    `servers.${serverId}.tools.blacklist`,
  );

  const transformVal = obj.transform;
  const transform = transformVal === undefined ? [] : parseTransformArray(transformVal, serverId);

  if (transport === 'stdio') {
    const command = obj.command;
    if (typeof command !== 'string' || !command.trim()) {
      throw new Error(`Invalid mcp.yaml: servers.${serverId}.command must be a non-empty string`);
    }

    const argsVal = obj.args;
    const args =
      argsVal === undefined
        ? []
        : Array.isArray(argsVal) && argsVal.every((a) => typeof a === 'string')
          ? argsVal
          : (() => {
              throw new Error(`Invalid mcp.yaml: servers.${serverId}.args must be string[]`);
            })();

    const envVal = obj.env;
    const envRecord = envVal === undefined ? {} : asRecord(envVal, `servers.${serverId}.env`);
    const env: Record<string, McpEnvValue> = {};
    for (const [k, v] of Object.entries(envRecord)) {
      if (typeof v === 'string') {
        env[k] = { kind: 'literal', value: v };
        continue;
      }
      const mapped = asRecord(v, `servers.${serverId}.env.${k}`);
      const fromEnv = mapped.env;
      if (typeof fromEnv !== 'string' || !fromEnv.trim()) {
        throw new Error(
          `Invalid mcp.yaml: servers.${serverId}.env.${k} must be a string or { env: 'NAME' }`,
        );
      }
      env[k] = { kind: 'from_env', env: fromEnv };
    }

    return {
      serverId,
      transport: 'stdio',
      command,
      args,
      env,
      tools: { whitelist, blacklist },
      transform,
    };
  }

  const url = obj.url;
  if (typeof url !== 'string' || !url.trim()) {
    throw new Error(`Invalid mcp.yaml: servers.${serverId}.url must be a non-empty string`);
  }
  const parsedUrl = safeParseUrl(url);
  if (!parsedUrl) {
    throw new Error(`Invalid mcp.yaml: servers.${serverId}.url must be a valid http(s) URL`);
  }

  const headersVal = obj.headers;
  const headersRecord =
    headersVal === undefined ? {} : asRecord(headersVal, `servers.${serverId}.headers`);
  const headers: Record<string, McpHeaderValue> = {};
  for (const [k, v] of Object.entries(headersRecord)) {
    if (typeof v === 'string') {
      headers[k] = { kind: 'literal', value: v };
      continue;
    }
    const mapped = asRecord(v, `servers.${serverId}.headers.${k}`);
    const fromEnv = mapped.env;
    if (typeof fromEnv !== 'string' || !fromEnv.trim()) {
      throw new Error(
        `Invalid mcp.yaml: servers.${serverId}.headers.${k} must be a string or { env: 'NAME' }`,
      );
    }
    headers[k] = { kind: 'from_env', env: fromEnv };
  }

  const sessionIdVal = obj.sessionId;
  const sessionId =
    sessionIdVal === undefined
      ? undefined
      : typeof sessionIdVal === 'string' && sessionIdVal.trim()
        ? sessionIdVal
        : (() => {
            throw new Error(`Invalid mcp.yaml: servers.${serverId}.sessionId must be a string`);
          })();

  return {
    serverId,
    transport: 'streamable_http',
    url: parsedUrl.toString(),
    headers,
    sessionId,
    tools: { whitelist, blacklist },
    transform,
  };
}

function parseTransformArray(value: unknown, serverId: string): ToolNameTransform[] {
  if (!Array.isArray(value)) {
    throw new Error(`Invalid mcp.yaml: servers.${serverId}.transform must be an array`);
  }
  const out: ToolNameTransform[] = [];
  for (let i = 0; i < value.length; i++) {
    const item = asRecord(value[i], `servers.${serverId}.transform[${i}]`);
    if ('prefix' in item) {
      const p = item.prefix;
      if (typeof p === 'string') {
        out.push({ kind: 'prefix_add', add: p });
        continue;
      }
      const po = asRecord(p, `servers.${serverId}.transform[${i}].prefix`);
      const remove = po.remove;
      const add = po.add;
      if (typeof remove !== 'string' || typeof add !== 'string') {
        throw new Error(
          `Invalid mcp.yaml: servers.${serverId}.transform[${i}].prefix must be string or { remove, add }`,
        );
      }
      out.push({ kind: 'prefix_replace', remove, add });
      continue;
    }
    if ('suffix' in item) {
      const s = item.suffix;
      if (typeof s !== 'string') {
        throw new Error(
          `Invalid mcp.yaml: servers.${serverId}.transform[${i}].suffix must be a string`,
        );
      }
      out.push({ kind: 'suffix_add', add: s });
      continue;
    }
    log.warn(`Unknown transform entry ignored in servers.${serverId}.transform[${i}]`);
  }
  return out;
}

function parseStringArrayOptional(value: unknown, pathLabel: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
    throw new Error(`Invalid mcp.yaml: ${pathLabel} must be string[]`);
  }
  return value.filter((s) => s.trim().length > 0);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value) || Array.isArray(value)) {
    throw new Error(`Invalid mcp.yaml: expected object at ${label}`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function safeParseUrl(value: string): URL | undefined {
  try {
    const u = new URL(value);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
    return u;
  } catch {
    return undefined;
  }
}
