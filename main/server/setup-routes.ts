import fs from 'fs';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import YAML from 'yaml';

import { LlmConfig, type ProviderConfig } from '../llm/client';
import { createLogger } from '../log';
import {
  type SetupFileKind,
  type SetupFileResponse,
  type SetupProminentEnumModelParam,
  type SetupProminentModelParamNamespace,
  type SetupStatusResponse,
  type SetupWriteShellEnvRequest,
  type SetupWriteShellEnvResponse,
  type SetupWriteTeamYamlRequest,
  type SetupWriteTeamYamlResponse,
  type SetupWriteWorkspaceLlmYamlRequest,
  type SetupWriteWorkspaceLlmYamlResponse,
} from '../shared/types/setup';

const log = createLogger('setup-routes');

const TEAM_YAML_PATH = path.join('.minds', 'team.yaml');
const WORKSPACE_LLM_YAML_PATH = path.join('.minds', 'llm.yaml');
const BUILTIN_DEFAULTS_YAML_PATH = path.join(__dirname, '..', 'llm', 'defaults.yaml');

const DOMINDS_ENV_BLOCK_START = '# >>> dominds env >>>';
const DOMINDS_ENV_BLOCK_END = '# <<< dominds env <<<';

type BuiltinProvidersLoadResult =
  | { kind: 'ok'; providers: Record<string, ProviderConfig>; providerKeysInOrder: string[] }
  | { kind: 'error'; errorText: string };

export async function buildSetupStatusResponse(): Promise<SetupStatusResponse> {
  const builtin = await loadBuiltinProviders();
  const merged = await LlmConfig.load();

  const shellEnv = typeof process.env.SHELL === 'string' ? process.env.SHELL : null;
  const shellKind = resolveShellKind(shellEnv);

  const home = os.homedir();
  const bashrcPath = path.join(home, '.bashrc');
  const zshrcPath = path.join(home, '.zshrc');
  const rc = {
    bashrc: await statRcFile(bashrcPath),
    zshrc: await statRcFile(zshrcPath),
  };

  const teamYaml = await readTeamYamlMemberDefaults();

  const requirement = await resolveSetupRequirement({
    teamYaml,
    llmProviders: merged.providers,
  });

  const workspaceLlmYaml = await readWorkspaceLlmYamlProviderKeys();

  if (builtin.kind === 'error') {
    return {
      success: false,
      requirement,
      shell: { env: shellEnv, kind: shellKind, defaultRc: shellKindToDefaultRc(shellKind) },
      rc,
      teamYaml,
      workspaceLlmYaml,
      providers: [],
      error: builtin.errorText,
    };
  }

  const providers = await buildProviderSummaries(builtin.providers, builtin.providerKeysInOrder, {
    bashrcPath,
    zshrcPath,
  });

  return {
    success: true,
    requirement,
    shell: { env: shellEnv, kind: shellKind, defaultRc: shellKindToDefaultRc(shellKind) },
    rc,
    teamYaml,
    workspaceLlmYaml,
    providers,
  };
}

export async function buildSetupFileResponse(kind: SetupFileKind): Promise<SetupFileResponse> {
  if (kind === 'defaults_yaml') {
    try {
      const raw = await fsPromises.readFile(BUILTIN_DEFAULTS_YAML_PATH, 'utf-8');
      return { success: true, kind, path: BUILTIN_DEFAULTS_YAML_PATH, raw };
    } catch {
      return {
        success: false,
        kind,
        path: BUILTIN_DEFAULTS_YAML_PATH,
        error: 'Failed to read defaults.yaml',
      };
    }
  }

  if (kind === 'workspace_llm_yaml') {
    const p = WORKSPACE_LLM_YAML_PATH;
    const exists = await fileExists(p);
    if (!exists) {
      return { success: false, kind, path: p, error: 'Missing .minds/llm.yaml' };
    }
    try {
      const raw = await fsPromises.readFile(p, 'utf-8');
      return { success: true, kind, path: p, raw };
    } catch {
      return { success: false, kind, path: p, error: 'Failed to read .minds/llm.yaml' };
    }
  }

  const _exhaustive: never = kind;
  return { success: false, kind: _exhaustive, path: '', error: 'Unsupported kind' };
}

export async function handleWriteShellEnv(
  rawBody: string,
): Promise<
  | { kind: 'ok'; response: SetupWriteShellEnvResponse }
  | { kind: 'bad_request'; errorText: string }
  | { kind: 'error'; errorText: string }
> {
  let parsed: unknown;
  try {
    parsed = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    return { kind: 'bad_request', errorText: 'Invalid JSON body' };
  }

  const req = parseWriteShellEnvRequest(parsed);
  if (!req) {
    return { kind: 'bad_request', errorText: 'Invalid request body' };
  }

  const allowed = await buildAllowedEnvVarSet();
  if (!allowed.has(req.envVar)) {
    return { kind: 'bad_request', errorText: `Unsupported env var: ${req.envVar}` };
  }

  try {
    // Apply to the current backend process immediately so setup can proceed without a restart.
    process.env[req.envVar] = req.value;

    const home = os.homedir();
    const targets = req.targets;
    type WriteOk = Extract<SetupWriteShellEnvResponse, { success: true }>;
    const outcomes: WriteOk['outcomes'] = [];
    for (const target of targets) {
      const filePath = path.join(home, target === 'bashrc' ? '.bashrc' : '.zshrc');
      const result = await upsertEnvVarIntoRcFile(filePath, req.envVar, req.value);
      outcomes.push({ target, path: filePath, result });
    }

    return { kind: 'ok', response: { success: true, outcomes } };
  } catch (error) {
    log.error('Failed to write shell env vars', error);
    return { kind: 'error', errorText: 'Failed to write shell env vars' };
  }
}

export async function handleWriteTeamYaml(
  rawBody: string,
): Promise<
  | { kind: 'ok'; response: SetupWriteTeamYamlResponse }
  | { kind: 'conflict'; errorText: string; path: string }
  | { kind: 'bad_request'; errorText: string; path: string }
  | { kind: 'error'; errorText: string; path: string }
> {
  const outPath = TEAM_YAML_PATH;

  let parsed: unknown;
  try {
    parsed = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    return { kind: 'bad_request', errorText: 'Invalid JSON body', path: outPath };
  }

  const req = parseWriteTeamYamlRequest(parsed);
  if (!req) {
    return { kind: 'bad_request', errorText: 'Invalid request body', path: outPath };
  }

  const llmCfg = await LlmConfig.load();
  const providerCfg = llmCfg.providers[req.provider];
  if (!providerCfg) {
    return { kind: 'bad_request', errorText: `Unknown provider: ${req.provider}`, path: outPath };
  }
  const models = providerCfg.models ?? {};
  if (!Object.prototype.hasOwnProperty.call(models, req.model)) {
    return {
      kind: 'bad_request',
      errorText: `Unknown model for provider ${req.provider}: ${req.model}`,
      path: outPath,
    };
  }

  const exists = await fileExists(outPath);
  if (exists && req.overwrite !== true) {
    return { kind: 'conflict', errorText: 'team.yaml already exists', path: outPath };
  }

  try {
    await fsPromises.mkdir(path.dirname(outPath), { recursive: true });
    const content = buildMinimalTeamYaml(req);
    await fsPromises.writeFile(outPath, content, 'utf-8');
    return {
      kind: 'ok',
      response: {
        success: true,
        path: outPath,
        action: exists ? 'overwritten' : 'created',
      },
    };
  } catch (error) {
    log.error('Failed to write team.yaml', error);
    return { kind: 'error', errorText: 'Failed to write team.yaml', path: outPath };
  }
}

export async function handleWriteWorkspaceLlmYaml(
  rawBody: string,
): Promise<
  | { kind: 'ok'; response: SetupWriteWorkspaceLlmYamlResponse }
  | { kind: 'conflict'; errorText: string; path: string }
  | { kind: 'bad_request'; errorText: string; path: string }
  | { kind: 'error'; errorText: string; path: string }
> {
  const outPath = WORKSPACE_LLM_YAML_PATH;

  let parsed: unknown;
  try {
    parsed = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    return { kind: 'bad_request', errorText: 'Invalid JSON body', path: outPath };
  }

  const req = parseWriteWorkspaceLlmYamlRequest(parsed);
  if (!req) {
    return { kind: 'bad_request', errorText: 'Invalid request body', path: outPath };
  }

  // Guardrails: ensure it is valid YAML and has a providers object.
  try {
    const parsedYaml: unknown = YAML.parse(req.raw);
    if (!isRecord(parsedYaml) || !isRecord(parsedYaml['providers'])) {
      return {
        kind: 'bad_request',
        errorText: 'Invalid llm.yaml: expected a top-level providers object',
        path: outPath,
      };
    }
  } catch {
    return { kind: 'bad_request', errorText: 'Invalid YAML content', path: outPath };
  }

  const exists = await fileExists(outPath);
  if (exists && req.overwrite !== true) {
    return { kind: 'conflict', errorText: 'llm.yaml already exists', path: outPath };
  }

  try {
    await fsPromises.mkdir(path.dirname(outPath), { recursive: true });
    await fsPromises.writeFile(outPath, req.raw.endsWith('\n') ? req.raw : `${req.raw}\n`, 'utf-8');
    return {
      kind: 'ok',
      response: {
        success: true,
        path: outPath,
        action: exists ? 'overwritten' : 'created',
      },
    };
  } catch (error) {
    log.error('Failed to write llm.yaml', error);
    return { kind: 'error', errorText: 'Failed to write llm.yaml', path: outPath };
  }
}

async function loadBuiltinProviders(): Promise<BuiltinProvidersLoadResult> {
  try {
    const raw = await fsPromises.readFile(BUILTIN_DEFAULTS_YAML_PATH, 'utf-8');
    const doc = YAML.parseDocument(raw);
    const parsed: unknown = doc.toJS();
    if (!isRecord(parsed) || !isRecord(parsed.providers)) {
      return { kind: 'error', errorText: 'Invalid defaults.yaml: expected providers object' };
    }
    const providerKeysInOrder = extractProvidersKeysFromDefaultsYamlDoc(doc);
    return {
      kind: 'ok',
      providers: parsed.providers as Record<string, ProviderConfig>,
      providerKeysInOrder,
    };
  } catch (error) {
    return { kind: 'error', errorText: 'Failed to load defaults.yaml' };
  }
}

async function buildAllowedEnvVarSet(): Promise<Set<string>> {
  const out = new Set<string>();
  const builtin = await loadBuiltinProviders();
  if (builtin.kind === 'ok') {
    for (const provider of Object.values(builtin.providers)) {
      if (typeof provider.apiKeyEnvVar === 'string') out.add(provider.apiKeyEnvVar);
    }
  }
  const merged = await LlmConfig.load();
  for (const provider of Object.values(merged.providers)) {
    if (typeof provider.apiKeyEnvVar === 'string') out.add(provider.apiKeyEnvVar);
  }
  return out;
}

async function buildProviderSummaries(
  providers: Record<string, ProviderConfig>,
  providerKeysInOrder: string[],
  paths: { bashrcPath: string; zshrcPath: string },
): Promise<SetupStatusResponse['providers']> {
  const envSet: SetupStatusResponse['providers'] = [];
  const envMissing: SetupStatusResponse['providers'] = [];

  for (const [providerKey, cfg] of orderedProviderEntries(providers, providerKeysInOrder)) {
    const envVar = cfg.apiKeyEnvVar;
    const envVarIsSet = typeof process.env[envVar] === 'string' && process.env[envVar] !== '';

    const bashrcHas = await rcHasEnvVar(paths.bashrcPath, envVar);
    const zshrcHas = await rcHasEnvVar(paths.zshrcPath, envVar);

    const models = Object.entries(cfg.models ?? {}).map(([modelKey, modelInfo]) => {
      const info = isRecord(modelInfo) ? modelInfo : {};
      const name = typeof info.name === 'string' ? info.name : undefined;
      const contextWindow =
        typeof info.context_window === 'string' ? info.context_window : undefined;
      const contextLength =
        typeof info.context_length === 'number' ? info.context_length : undefined;
      const inputLength = typeof info.input_length === 'number' ? info.input_length : undefined;
      const outputLength = typeof info.output_length === 'number' ? info.output_length : undefined;
      return {
        key: modelKey,
        name,
        contextWindow,
        contextLength,
        inputLength,
        outputLength,
        verified: envVarIsSet,
      };
    });

    const prominent = extractProminentEnumModelParams(cfg.model_param_options);
    const summary: SetupStatusResponse['providers'][number] = {
      providerKey,
      name: cfg.name,
      apiType: cfg.apiType,
      baseUrl: cfg.baseUrl,
      apiKeyEnvVar: envVar,
      techSpecUrl: cfg.tech_spec_url,
      apiMgmtUrl: cfg.api_mgmt_url,
      envVar: { isSet: envVarIsSet, bashrcHas, zshrcHas },
      models,
      ...(prominent.length > 0 ? { prominentModelParams: prominent } : {}),
    };

    // Keep YAML order stable, but list env-var-ready providers first.
    if (envVarIsSet) {
      envSet.push(summary);
    } else {
      envMissing.push(summary);
    }
  }

  return [...envSet, ...envMissing];
}

function extractProminentEnumModelParams(
  modelParamOptions: ProviderConfig['model_param_options'],
): SetupProminentEnumModelParam[] {
  if (!modelParamOptions) return [];

  const out: SetupProminentEnumModelParam[] = [];
  const sections: Array<[SetupProminentEnumModelParam['namespace'], Record<string, unknown>]> = [];

  const addSection = (
    namespace: SetupProminentEnumModelParam['namespace'],
    section: unknown,
  ): void => {
    if (section && typeof section === 'object') {
      sections.push([namespace, section as Record<string, unknown>]);
    }
  };

  addSection('general', modelParamOptions.general);
  addSection('codex', modelParamOptions.codex);
  addSection('openai', modelParamOptions.openai);
  addSection('anthropic', modelParamOptions.anthropic);

  for (const [namespace, section] of sections) {
    for (const [key, optUnknown] of Object.entries(section)) {
      if (!optUnknown || typeof optUnknown !== 'object') continue;
      const opt = optUnknown as {
        type?: unknown;
        prominent?: unknown;
        description?: unknown;
        values?: unknown;
        default?: unknown;
      };
      if (opt.type !== 'enum') continue;
      if (opt.prominent !== true) continue;
      if (typeof opt.description !== 'string') continue;
      if (!Array.isArray(opt.values) || !opt.values.every((v) => typeof v === 'string')) continue;

      const defaultValue =
        typeof opt.default === 'string' && (opt.values as string[]).includes(opt.default)
          ? opt.default
          : undefined;

      out.push({
        namespace,
        key,
        description: opt.description,
        values: opt.values as string[],
        ...(defaultValue ? { defaultValue } : {}),
      });
    }
  }

  return out;
}

function orderedProviderEntries(
  providers: Record<string, ProviderConfig>,
  providerKeysInOrder: string[],
): Array<[string, ProviderConfig]> {
  const out: Array<[string, ProviderConfig]> = [];
  const seen = new Set<string>();

  for (const k of providerKeysInOrder) {
    const cfg = providers[k];
    if (!cfg) continue;
    out.push([k, cfg]);
    seen.add(k);
  }

  // Any providers not present in the YAML map (should be rare) are appended.
  for (const [k, cfg] of Object.entries(providers)) {
    if (seen.has(k)) continue;
    out.push([k, cfg]);
  }

  return out;
}

function extractYamlMapStringKeys(value: unknown): string[] {
  if (!YAML.isMap(value)) return [];
  const out: string[] = [];
  for (const pair of value.items) {
    if (!YAML.isPair(pair)) continue;
    const keyNode = pair.key;
    if (!YAML.isScalar(keyNode)) continue;
    const keyValue = keyNode.value;
    if (typeof keyValue !== 'string' || keyValue === '') continue;
    out.push(keyValue);
  }
  return out;
}

function extractProvidersKeysFromDefaultsYamlDoc(doc: YAML.Document.Parsed): string[] {
  const root = doc.contents;
  if (!YAML.isMap(root)) return [];
  for (const pair of root.items) {
    if (!YAML.isPair(pair)) continue;
    const keyNode = pair.key;
    if (!YAML.isScalar(keyNode)) continue;
    if (keyNode.value !== 'providers') continue;
    const valNode = pair.value;
    return extractYamlMapStringKeys(valNode);
  }
  return [];
}

async function statRcFile(filePath: string): Promise<SetupStatusResponse['rc']['bashrc']> {
  const exists = await fileExists(filePath);
  const writable = exists ? await isWritable(filePath) : await isWritable(path.dirname(filePath));
  return { path: filePath, exists, writable };
}

async function readTeamYamlMemberDefaults(): Promise<SetupStatusResponse['teamYaml']> {
  const exists = await fileExists(TEAM_YAML_PATH);
  if (!exists) return { path: TEAM_YAML_PATH, exists: false };

  try {
    const raw = await fsPromises.readFile(TEAM_YAML_PATH, 'utf-8');
    const parsed: unknown = YAML.parse(raw);
    if (!isRecord(parsed)) {
      return {
        path: TEAM_YAML_PATH,
        exists: true,
        parseError: 'Invalid team.yaml (not an object)',
      };
    }
    const memberDefaultsUnknown = parsed['member_defaults'];
    if (!isRecord(memberDefaultsUnknown)) {
      return {
        path: TEAM_YAML_PATH,
        exists: true,
        parseError: 'Invalid team.yaml (missing member_defaults object)',
      };
    }
    const provider =
      typeof memberDefaultsUnknown['provider'] === 'string'
        ? memberDefaultsUnknown['provider']
        : undefined;
    const model =
      typeof memberDefaultsUnknown['model'] === 'string'
        ? memberDefaultsUnknown['model']
        : undefined;
    return { path: TEAM_YAML_PATH, exists: true, memberDefaults: { provider, model } };
  } catch (error) {
    return { path: TEAM_YAML_PATH, exists: true, parseError: 'Failed to parse team.yaml' };
  }
}

async function readWorkspaceLlmYamlProviderKeys(): Promise<
  SetupStatusResponse['workspaceLlmYaml']
> {
  const exists = await fileExists(WORKSPACE_LLM_YAML_PATH);
  if (!exists) return { path: WORKSPACE_LLM_YAML_PATH, exists: false };
  try {
    const raw = await fsPromises.readFile(WORKSPACE_LLM_YAML_PATH, 'utf-8');
    const parsed: unknown = YAML.parse(raw);
    if (!isRecord(parsed)) {
      return {
        path: WORKSPACE_LLM_YAML_PATH,
        exists: true,
        parseError: 'Invalid llm.yaml (not an object)',
      };
    }
    const providersUnknown = parsed['providers'];
    if (!isRecord(providersUnknown)) {
      return {
        path: WORKSPACE_LLM_YAML_PATH,
        exists: true,
        parseError: 'Invalid llm.yaml (missing providers object)',
      };
    }
    return {
      path: WORKSPACE_LLM_YAML_PATH,
      exists: true,
      providerKeys: Object.keys(providersUnknown).sort(),
    };
  } catch (error) {
    return { path: WORKSPACE_LLM_YAML_PATH, exists: true, parseError: 'Failed to parse llm.yaml' };
  }
}

async function resolveSetupRequirement(params: {
  teamYaml: SetupStatusResponse['teamYaml'];
  llmProviders: Record<string, ProviderConfig>;
}): Promise<SetupStatusResponse['requirement']> {
  const ty = params.teamYaml;
  if (!ty.exists) {
    return { kind: 'missing_team_yaml', teamYamlPath: ty.path };
  }
  if (typeof ty.parseError === 'string') {
    return { kind: 'invalid_team_yaml', teamYamlPath: ty.path, errorText: ty.parseError };
  }

  const md = ty.memberDefaults;
  if (
    !md ||
    typeof md.provider !== 'string' ||
    md.provider === '' ||
    typeof md.model !== 'string' ||
    md.model === ''
  ) {
    const missing: Array<'provider' | 'model'> = [];
    if (!md || typeof md.provider !== 'string' || md.provider === '') missing.push('provider');
    if (!md || typeof md.model !== 'string' || md.model === '') missing.push('model');
    return { kind: 'missing_member_defaults_fields', teamYamlPath: ty.path, missing };
  }

  const providerKey: string = md.provider;
  const modelKey: string = md.model;

  const providerCfg = params.llmProviders[providerKey];
  if (!providerCfg) {
    return { kind: 'unknown_provider', provider: providerKey };
  }

  const models = providerCfg.models ?? {};
  if (!Object.prototype.hasOwnProperty.call(models, modelKey)) {
    return { kind: 'unknown_model', provider: providerKey, model: modelKey };
  }

  const envVar = providerCfg.apiKeyEnvVar;
  const rawEnv = process.env[envVar];
  const envSet = typeof rawEnv === 'string' && rawEnv !== '';
  if (!envSet) {
    return { kind: 'missing_provider_env', provider: providerKey, envVar };
  }

  return { kind: 'ok' };
}

type ShellKind = SetupStatusResponse['shell']['kind'];

function resolveShellKind(shellEnv: string | null): ShellKind {
  if (!shellEnv) return 'other';
  const base = path.basename(shellEnv);
  if (base === 'zsh') return 'zsh';
  if (base === 'bash') return 'bash';
  return 'other';
}

function shellKindToDefaultRc(kind: ShellKind): SetupStatusResponse['shell']['defaultRc'] {
  if (kind === 'bash') return 'bashrc';
  if (kind === 'zsh') return 'zshrc';
  return 'unknown';
}

function parseWriteShellEnvRequest(value: unknown): SetupWriteShellEnvRequest | null {
  if (!isRecord(value)) return null;
  const envVar = value['envVar'];
  const rawVal = value['value'];
  const targetsUnknown = value['targets'];
  if (typeof envVar !== 'string' || !isSafeEnvVarName(envVar)) return null;
  if (typeof rawVal !== 'string') return null;
  if (!Array.isArray(targetsUnknown)) return null;
  const targets: Array<'bashrc' | 'zshrc'> = [];
  for (const t of targetsUnknown) {
    if (t === 'bashrc' || t === 'zshrc') targets.push(t);
  }
  if (targets.length === 0) return null;
  return { envVar, value: rawVal, targets };
}

function parseWriteTeamYamlRequest(value: unknown): SetupWriteTeamYamlRequest | null {
  if (!isRecord(value)) return null;
  const provider = value['provider'];
  const model = value['model'];
  const overwrite = value['overwrite'];
  if (typeof provider !== 'string' || provider === '') return null;
  if (typeof model !== 'string' || model === '') return null;
  if (typeof overwrite !== 'boolean') return null;

  const modelParamsUnknown = value['modelParams'];
  const modelParams = parseOptionalTeamModelParams(modelParamsUnknown);
  if (modelParamsUnknown !== undefined && !modelParams) return null;

  return modelParams ? { provider, model, overwrite, modelParams } : { provider, model, overwrite };
}

function parseWriteWorkspaceLlmYamlRequest(
  value: unknown,
): SetupWriteWorkspaceLlmYamlRequest | null {
  if (!isRecord(value)) return null;
  const raw = value['raw'];
  const overwrite = value['overwrite'];
  if (typeof raw !== 'string') return null;
  if (typeof overwrite !== 'boolean') return null;
  return { raw, overwrite };
}

function buildMinimalTeamYaml(req: SetupWriteTeamYamlRequest): string {
  // Minimal config, intentionally no members.
  const memberDefaults: Record<string, unknown> = {
    provider: req.provider,
    model: req.model,
  };
  if (req.modelParams && Object.keys(req.modelParams).length > 0) {
    memberDefaults['model_params'] = req.modelParams;
  }

  const doc = { member_defaults: memberDefaults };
  return YAML.stringify(doc);
}

function parseOptionalTeamModelParams(
  value: unknown,
): SetupWriteTeamYamlRequest['modelParams'] | null {
  if (value === undefined) return null;
  if (!isRecord(value)) return null;

  const out: Partial<Record<SetupProminentModelParamNamespace, Record<string, string>>> = {};

  for (const [namespace, nsUnknown] of Object.entries(value)) {
    if (
      namespace !== 'general' &&
      namespace !== 'codex' &&
      namespace !== 'openai' &&
      namespace !== 'anthropic'
    )
      return null;
    if (!isRecord(nsUnknown)) return null;
    const nsOut: Record<string, string> = {};
    for (const [k, v] of Object.entries(nsUnknown)) {
      if (typeof v !== 'string') return null;
      nsOut[k] = v;
    }
    if (Object.keys(nsOut).length > 0) out[namespace] = nsOut;
  }

  return Object.keys(out).length > 0 ? out : {};
}

function isSafeEnvVarName(name: string): boolean {
  return /^[A-Z_][A-Z0-9_]*$/.test(name);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fsPromises.access(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function isWritable(filePath: string): Promise<boolean> {
  try {
    await fsPromises.access(filePath, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function rcHasEnvVar(rcPath: string, envVar: string): Promise<boolean> {
  try {
    const raw = await fsPromises.readFile(rcPath, 'utf-8');
    const re = new RegExp(`(^|\\n)\\s*export\\s+${escapeRegExp(envVar)}=`, 'm');
    return re.test(raw);
  } catch {
    return false;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function shellQuoteSingle(value: string): string {
  // Safe POSIX shell single-quoted string: close quote, escape single quote, reopen.
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function upsertEnvVarIntoRcFile(
  filePath: string,
  envVar: string,
  value: string,
): Promise<'created' | 'updated'> {
  const exportLine = `export ${envVar}=${shellQuoteSingle(value)}`;

  const exists = await fileExists(filePath);
  const original = exists ? await fsPromises.readFile(filePath, 'utf-8') : '';
  const normalized = original.replace(/\r\n/g, '\n');
  const lines = normalized === '' ? [] : normalized.split('\n');

  const startIdx = lines.findIndex((l) => l.trim() === DOMINDS_ENV_BLOCK_START);
  const endIdx = lines.findIndex((l) => l.trim() === DOMINDS_ENV_BLOCK_END);

  let nextLines = lines;
  if (startIdx >= 0 && endIdx > startIdx) {
    const blockLines = lines.slice(startIdx + 1, endIdx);
    const updatedBlock = upsertExportLine(blockLines, envVar, exportLine);
    nextLines = [...lines.slice(0, startIdx + 1), ...updatedBlock, ...lines.slice(endIdx)];
  } else {
    // Append a new managed block.
    const block = [DOMINDS_ENV_BLOCK_START, exportLine, DOMINDS_ENV_BLOCK_END];
    const joiner: string[] = nextLines.length > 0 ? [''] : [];
    nextLines = [...nextLines, ...joiner, ...block];
  }

  // Ensure file ends with newline for friendliness.
  let next = nextLines.join('\n');
  if (!next.endsWith('\n')) next += '\n';

  await fsPromises.writeFile(filePath, next, 'utf-8');
  return exists ? 'updated' : 'created';
}

function upsertExportLine(lines: string[], envVar: string, exportLine: string): string[] {
  const re = new RegExp(`^\\s*export\\s+${escapeRegExp(envVar)}=`);
  const idx = lines.findIndex((l) => re.test(l));
  if (idx >= 0) {
    const copy = [...lines];
    copy[idx] = exportLine;
    return copy;
  }
  return [...lines, exportLine];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
