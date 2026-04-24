import fs from 'node:fs';
import path from 'node:path';

import { parseIdToken } from '../oauth/tokenParsing.js';
import { AuthDotJson, CodexStoredAuthMode, resolveAuthDotJsonMode } from './schema.js';
import { readAuthFile, resolveCodexHome } from './storage.js';

export type CodexCliAuthStoreMode = 'file' | 'keyring' | 'auto' | 'ephemeral';

const CLI_AUTH_CREDENTIALS_STORE_ASSIGNMENT = 'cli_auth_credentials_store = "file"';
const CLI_AUTH_CREDENTIALS_STORE_PATTERN =
  /^[ \t]*cli_auth_credentials_store[ \t]*=[ \t]*(?:"([^"]*)"|'([^']*)'|([A-Za-z0-9_-]+))[ \t]*(?:#.*)?$/m;

export type CodexFileAuthPreparationResult =
  | {
      kind: 'ready';
      codexHome: string;
      configPath: string;
      changedConfigToFile: boolean;
      previousStoreMode?: CodexCliAuthStoreMode;
    }
  | {
      kind: 'action_required';
      codexHome: string;
      configPath: string;
      reason:
        | 'config_write_failed'
        | 'invalid_file_auth'
        | 'missing_file_auth'
        | 'api_key_auth'
        | 'unsupported_auth_mode'
        | 'incomplete_chatgpt_auth';
      message: string;
      steps: string[];
      changedConfigToFile: boolean;
      previousStoreMode?: CodexCliAuthStoreMode;
    };

export interface PrepareCodexFileAuthOptions {
  codexHome?: string;
  codexHomeEnvVar?: string;
  providerName?: string;
}

export interface CodexCliAuthStoreModeConfig {
  configPath: string;
  mode?: CodexCliAuthStoreMode;
}

export function readCodexCliAuthStoreMode(codexHome: string): CodexCliAuthStoreModeConfig {
  const configPath = codexConfigPath(codexHome);
  if (!fs.existsSync(configPath)) {
    return { configPath };
  }

  const raw = fs.readFileSync(configPath, 'utf8');
  const match = topLevelTomlPrefix(raw).match(CLI_AUTH_CREDENTIALS_STORE_PATTERN);
  if (!match) {
    return { configPath };
  }

  const mode = parseStoreMode(match[1] ?? match[2] ?? match[3] ?? '');
  return mode === undefined ? { configPath } : { configPath, mode };
}

export function setCodexCliAuthStoreModeToFile(codexHome: string): {
  configPath: string;
  previousStoreMode?: CodexCliAuthStoreMode;
  changed: boolean;
} {
  const configPath = codexConfigPath(codexHome);
  const before = readCodexCliAuthStoreMode(codexHome);
  if (before.mode === 'file') {
    return { configPath, previousStoreMode: before.mode, changed: false };
  }

  let raw = '';
  if (fs.existsSync(configPath)) {
    raw = fs.readFileSync(configPath, 'utf8');
  }

  const topLevel = topLevelTomlPrefix(raw);
  const nextRaw = CLI_AUTH_CREDENTIALS_STORE_PATTERN.test(topLevel)
    ? raw.replace(CLI_AUTH_CREDENTIALS_STORE_PATTERN, CLI_AUTH_CREDENTIALS_STORE_ASSIGNMENT)
    : prependTopLevelTomlAssignment(raw, CLI_AUTH_CREDENTIALS_STORE_ASSIGNMENT);

  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(configPath, nextRaw, { mode: 0o600 });
  return {
    configPath,
    previousStoreMode: before.mode,
    changed: true,
  };
}

export function prepareCodexFileAuth(
  options: PrepareCodexFileAuthOptions = {},
): CodexFileAuthPreparationResult {
  const codexHome = resolveCodexHome(options.codexHome);
  const providerName = options.providerName ?? 'Dominds codex provider';

  let configPath = codexConfigPath(codexHome);
  let previousStoreMode: CodexCliAuthStoreMode | undefined;
  let changedConfigToFile = false;

  try {
    const change = setCodexCliAuthStoreModeToFile(codexHome);
    configPath = change.configPath;
    previousStoreMode = change.previousStoreMode;
    changedConfigToFile = change.changed;
  } catch (err: unknown) {
    const details = err instanceof Error ? err.message : String(err);
    return actionRequired({
      codexHome,
      configPath,
      reason: 'config_write_failed',
      changedConfigToFile,
      previousStoreMode,
      message: `${providerName} requires Codex CLI auth to be stored in file mode, but Dominds could not update ${configPath}: ${details}`,
      steps: fileModeSteps(codexHome, options.codexHomeEnvVar),
    });
  }

  let auth: AuthDotJson | null;
  try {
    auth = readAuthFile(codexHome, 'file');
  } catch (err: unknown) {
    const details = err instanceof Error ? err.message : String(err);
    return actionRequired({
      codexHome,
      configPath,
      reason: 'invalid_file_auth',
      changedConfigToFile,
      previousStoreMode,
      message: `${providerName} could not read ${path.join(codexHome, 'auth.json')}: ${details}`,
      steps: loginSteps(codexHome, options.codexHomeEnvVar),
    });
  }
  if (!auth) {
    const movedFrom =
      previousStoreMode && previousStoreMode !== 'file'
        ? ` Codex was configured for ${previousStoreMode} auth storage; Dominds switched the config to file mode, but cannot extract existing secrets from ${previousStoreMode} storage.`
        : '';
    return actionRequired({
      codexHome,
      configPath,
      reason: 'missing_file_auth',
      changedConfigToFile,
      previousStoreMode,
      message: `${providerName} needs ChatGPT OAuth tokens in ${path.join(codexHome, 'auth.json')}.${movedFrom}`,
      steps: loginSteps(codexHome, options.codexHomeEnvVar),
    });
  }

  let mode: CodexStoredAuthMode;
  try {
    mode = resolveAuthDotJsonMode(auth);
  } catch (err: unknown) {
    const details = err instanceof Error ? err.message : String(err);
    return actionRequired({
      codexHome,
      configPath,
      reason: 'unsupported_auth_mode',
      changedConfigToFile,
      previousStoreMode,
      message: `${providerName} cannot use the current Codex auth: ${details}`,
      steps: loginSteps(codexHome, options.codexHomeEnvVar),
    });
  }

  const chatgptIssue = validateChatgptAuth(mode, auth);
  if (chatgptIssue !== undefined) {
    const { reason, message } = chatgptIssue;
    return actionRequired({
      codexHome,
      configPath,
      reason,
      changedConfigToFile,
      previousStoreMode,
      message: `${providerName} cannot use the current Codex auth: ${message}`,
      steps: loginSteps(codexHome, options.codexHomeEnvVar),
    });
  }

  return {
    kind: 'ready',
    codexHome,
    configPath,
    changedConfigToFile,
    previousStoreMode,
  };
}

export function formatCodexFileAuthActionRequired(
  result: Extract<CodexFileAuthPreparationResult, { kind: 'action_required' }>,
): string {
  return [
    result.message,
    '',
    'Recommended steps:',
    ...result.steps.map((step, idx) => `${idx + 1}. ${step}`),
  ].join('\n');
}

function validateChatgptAuth(
  mode: CodexStoredAuthMode,
  auth: AuthDotJson,
):
  | {
      reason: Extract<CodexFileAuthPreparationResult, { kind: 'action_required' }>['reason'];
      message: string;
    }
  | undefined {
  if (mode === 'apikey') {
    return {
      reason: 'api_key_auth',
      message:
        'auth.json is in API key mode. Dominds uses the ChatGPT Codex backend and needs ChatGPT OAuth tokens, not only an OpenAI API key.',
    };
  }
  if (mode === 'agentIdentity') {
    return {
      reason: 'unsupported_auth_mode',
      message:
        'auth.json uses agentIdentity auth. Agent identity auth is not equivalent to reusable ChatGPT OAuth file auth.',
    };
  }
  if (mode === 'chatgptAuthTokens') {
    return {
      reason: 'unsupported_auth_mode',
      message:
        'auth.json uses externally managed chatgptAuthTokens. Those tokens are host-managed and cannot be converted into managed file auth safely.',
    };
  }

  const tokens = auth.tokens;
  if (
    !tokens ||
    !isNonEmptyString(tokens.id_token) ||
    !isNonEmptyString(tokens.access_token) ||
    !isNonEmptyString(tokens.refresh_token)
  ) {
    return {
      reason: 'incomplete_chatgpt_auth',
      message:
        'auth.json declares ChatGPT auth but is missing id_token, access_token, or refresh_token.',
    };
  }

  let idTokenInfo: ReturnType<typeof parseIdToken>;
  try {
    idTokenInfo = parseIdToken(tokens.id_token);
  } catch (err: unknown) {
    const details = err instanceof Error ? err.message : String(err);
    return {
      reason: 'invalid_file_auth',
      message: `auth.json contains an invalid ChatGPT id_token: ${details}`,
    };
  }

  if (!isNonEmptyString(tokens.account_id) && !isNonEmptyString(idTokenInfo.chatgpt_account_id)) {
    return {
      reason: 'incomplete_chatgpt_auth',
      message:
        'auth.json ChatGPT tokens do not include a ChatGPT account id. Re-run Codex login so auth.json can be regenerated.',
    };
  }
  return undefined;
}

function actionRequired(
  result: Omit<Extract<CodexFileAuthPreparationResult, { kind: 'action_required' }>, 'kind'>,
): CodexFileAuthPreparationResult {
  return { kind: 'action_required', ...result };
}

function codexConfigPath(codexHome: string): string {
  return path.join(codexHome, 'config.toml');
}

function parseStoreMode(value: string): CodexCliAuthStoreMode | undefined {
  const normalized = value.trim().toLowerCase();
  if (
    normalized === 'file' ||
    normalized === 'keyring' ||
    normalized === 'auto' ||
    normalized === 'ephemeral'
  ) {
    return normalized;
  }
  return undefined;
}

function prependTopLevelTomlAssignment(raw: string, assignment: string): string {
  if (raw.length === 0) {
    return `${assignment}\n`;
  }
  return `${assignment}\n${raw}`;
}

function topLevelTomlPrefix(raw: string): string {
  const tableMatch = raw.match(/^[ \t]*(?:\[\[[^\]]+\]\]|\[[^\]]+\])[ \t]*(?:#.*)?$/m);
  if (!tableMatch || tableMatch.index === undefined) {
    return raw;
  }
  return raw.slice(0, tableMatch.index);
}

function fileModeSteps(codexHome: string, codexHomeEnvVar: string | undefined): string[] {
  const envPrefix = codexHomeEnvVar ? `${codexHomeEnvVar}=${shellQuote(codexHome)} ` : '';
  return [
    `Set Codex CLI auth storage to file mode: ${envPrefix}codex -c cli_auth_credentials_store=file login status`,
    `Or edit ${codexConfigPath(codexHome)} and add: cli_auth_credentials_store = "file"`,
  ];
}

function loginSteps(codexHome: string, codexHomeEnvVar: string | undefined): string[] {
  const envPrefix = codexHomeEnvVar ? `${codexHomeEnvVar}=${shellQuote(codexHome)} ` : '';
  return [
    `Run ChatGPT login in file mode: ${envPrefix}codex -c cli_auth_credentials_store=file login`,
    `Verify file auth exists: ${envPrefix}codex -c cli_auth_credentials_store=file login status`,
    `Then retry Dominds. Expected file: ${path.join(codexHome, 'auth.json')}`,
  ];
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
