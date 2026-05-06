import { createLogger } from '../log';
import { parseMarkdownFrontmatter } from '../markdown/frontmatter';
import type { McpPromptConfig, McpResourceConfig } from './config';
import type {
  McpListedPrompt,
  McpPromptContent,
  McpReadResourceContent,
  McpSdkClient,
} from './sdk-client';
import type { ToolNameTransform } from './tool-names';
import { applyToolNameTransforms } from './tool-names';

const log = createLogger('mcp/resources');

const DEFAULT_RESOURCE_MAX_BYTES = 64_000;

type ExposureRules = Readonly<{
  whitelist: readonly string[];
  blacklist: readonly string[];
}>;

export type McpPromptCatalogEntry = Readonly<{
  id: string;
  serverId: string;
  name: string;
  title: string;
  description?: string;
  arguments?: ReadonlyArray<{
    name: string;
    description?: string;
    required?: boolean;
  }>;
}>;

export type McpResourceCatalogEntry =
  | Readonly<{
      kind: 'resource';
      id: string;
      serverId: string;
      uri: string;
      name: string;
      description?: string;
      mimeType?: string;
    }>
  | Readonly<{
      kind: 'resource_template';
      id: string;
      serverId: string;
      uriTemplate: string;
      variables: readonly string[];
      name: string;
      description?: string;
      mimeType?: string;
    }>;

export type McpVirtualSkill = Readonly<{
  id: string;
  title: string;
  description: string;
  body: string;
  serverId: string;
  resourceId: string;
  uri: string;
  declaredAllowedTools?: ReadonlyArray<string>;
  userInvocable?: boolean;
  disableModelInvocation?: boolean;
}>;

type ServerCatalog = Readonly<{
  serverId: string;
  prompts: readonly McpPromptCatalogEntry[];
  resources: readonly McpResourceCatalogEntry[];
  skills: readonly McpVirtualSkill[];
}>;

const catalogByServerId = new Map<string, ServerCatalog>();
const promptById = new Map<string, McpPromptCatalogEntry>();
const resourceById = new Map<string, McpResourceCatalogEntry>();
const skillById = new Map<string, McpVirtualSkill>();

export function unregisterMcpPromptResourceCatalog(serverId: string): void {
  const existing = catalogByServerId.get(serverId);
  if (!existing) return;
  for (const prompt of existing.prompts) {
    promptById.delete(prompt.id);
  }
  for (const resource of existing.resources) {
    resourceById.delete(resource.id);
  }
  for (const skill of existing.skills) {
    skillById.delete(skill.id);
  }
  catalogByServerId.delete(serverId);
}

export function clearMcpPromptResourceCatalog(): void {
  catalogByServerId.clear();
  promptById.clear();
  resourceById.clear();
  skillById.clear();
}

export async function refreshMcpPromptResourceCatalog(params: {
  serverId: string;
  client: McpSdkClient;
  prompts: McpPromptConfig;
  resources: McpResourceConfig;
}): Promise<void> {
  unregisterMcpPromptResourceCatalog(params.serverId);

  const prompts = await listPromptsBestEffort(params);
  const resources = await listResourcesBestEffort(params);
  const skills = await loadResourceSkills({
    serverId: params.serverId,
    client: params.client,
    cfg: params.resources,
    resources,
  });

  const catalog: ServerCatalog = {
    serverId: params.serverId,
    prompts,
    resources,
    skills,
  };
  catalogByServerId.set(params.serverId, catalog);
  for (const prompt of prompts) {
    registerUnique(promptById, prompt.id, prompt, 'MCP prompt');
  }
  for (const resource of resources) {
    registerUnique(resourceById, resource.id, resource, 'MCP resource');
  }
  for (const skill of skills) {
    registerUnique(skillById, skill.id, skill, 'MCP resource skill');
  }
}

export function listMcpPrompts(): readonly McpPromptCatalogEntry[] {
  return [...promptById.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function listMcpResources(): readonly McpResourceCatalogEntry[] {
  return [...resourceById.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function listMcpVirtualSkills(): readonly McpVirtualSkill[] {
  return [...skillById.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function getMcpVirtualSkill(skillId: string): McpVirtualSkill | undefined {
  return skillById.get(skillId);
}

export function getMcpResource(resourceId: string): McpResourceCatalogEntry | undefined {
  return resourceById.get(resourceId);
}

export function getMcpPrompt(promptId: string): McpPromptCatalogEntry | undefined {
  return promptById.get(promptId);
}

export function expandResourceTemplate(
  template: McpResourceCatalogEntry & { kind: 'resource_template' },
  args: Record<string, string>,
): string {
  for (const variable of template.variables) {
    const value = args[variable];
    if (typeof value !== 'string' || value === '') {
      throw new Error(`Missing resource template argument '${variable}' for '${template.id}'`);
    }
  }
  return template.uriTemplate.replace(/\{([^}]+)\}/g, (_whole, rawValue: string) => {
    const expression = parseTemplateExpression(rawValue);
    const pairs = expression.variables.map((name) => {
      const value = args[name];
      if (typeof value !== 'string' || value === '') {
        throw new Error(`Missing resource template argument '${name}' for '${template.id}'`);
      }
      return { name, value };
    });
    if (expression.operator === '#') {
      return `#${pairs.map((pair) => encodeUriTemplateReservedValue(pair.value)).join(',')}`;
    }
    if (expression.operator === '/') {
      return pairs.map((pair) => `/${encodeURIComponent(pair.value)}`).join('');
    }
    if (expression.operator === '.') {
      return pairs.map((pair) => `.${encodeURIComponent(pair.value)}`).join('');
    }
    if (expression.operator === ';') {
      return pairs
        .map((pair) => `;${encodeURIComponent(pair.name)}=${encodeURIComponent(pair.value)}`)
        .join('');
    }
    if (expression.operator === '?' || expression.operator === '&') {
      const prefix = expression.operator;
      return `${prefix}${pairs
        .map((pair) => `${encodeURIComponent(pair.name)}=${encodeURIComponent(pair.value)}`)
        .join('&')}`;
    }
    const encodeValue =
      expression.operator === '+'
        ? encodeUriTemplateReservedValue
        : (value: string): string => encodeURIComponent(value);
    return pairs.map((pair) => encodeValue(pair.value)).join(',');
  });
}

export async function renderMcpPrompt(params: {
  serverId: string;
  client: McpSdkClient;
  promptName: string;
  arguments?: Record<string, string>;
}): Promise<string> {
  const prompt = await params.client.getPrompt(params.promptName, params.arguments);
  return renderPromptContent(prompt);
}

export function renderPromptContent(prompt: McpPromptContent): string {
  const lines: string[] = [];
  if (prompt.description && prompt.description.trim() !== '') {
    lines.push(`<!-- ${prompt.description.trim()} -->`, '');
  }
  for (const message of prompt.messages) {
    const text = extractPromptMessageText(message);
    if (text.trim() !== '') {
      lines.push(text.trim(), '');
    }
  }
  return lines.join('\n').trim();
}

export function renderResourceContent(contents: readonly McpReadResourceContent[]): string {
  const parts: string[] = [];
  for (const content of contents) {
    if (typeof content.text === 'string') {
      parts.push(content.text);
      continue;
    }
    if (typeof content.blob === 'string') {
      parts.push(
        JSON.stringify({
          uri: content.uri,
          mimeType: content.mimeType ?? 'application/octet-stream',
          blob: `[omitted base64; length=${content.blob.length}]`,
        }),
      );
    }
  }
  return parts.join('\n\n').trim();
}

async function listPromptsBestEffort(params: {
  serverId: string;
  client: McpSdkClient;
  prompts: McpPromptConfig;
}): Promise<McpPromptCatalogEntry[]> {
  let listed: McpListedPrompt[];
  try {
    listed = await params.client.listPrompts();
  } catch (err: unknown) {
    log.debug('MCP prompts/list unavailable', err, { serverId: params.serverId });
    return [];
  }
  const out: McpPromptCatalogEntry[] = [];
  for (const prompt of listed) {
    if (!isExposed(prompt.name, params.prompts)) continue;
    const id = toStableId(applyTransforms(prompt.name, params.prompts.transform));
    out.push({
      id,
      serverId: params.serverId,
      name: prompt.name,
      title: prompt.name,
      description: prompt.description,
      arguments: prompt.arguments,
    });
  }
  return out;
}

async function listResourcesBestEffort(params: {
  serverId: string;
  client: McpSdkClient;
  resources: McpResourceConfig;
}): Promise<McpResourceCatalogEntry[]> {
  const out: McpResourceCatalogEntry[] = [];
  try {
    const listed = await params.client.listResources();
    for (const resource of listed) {
      if (!isResourceAllowed(resource.uri, resource.mimeType, params.resources)) continue;
      const id = toStableId(applyTransforms(resource.uri, params.resources.transform));
      out.push({
        kind: 'resource',
        id,
        serverId: params.serverId,
        uri: resource.uri,
        name: resource.name,
        description: resource.description,
        mimeType: resource.mimeType,
      });
    }
  } catch (err: unknown) {
    log.debug('MCP resources/list unavailable', err, { serverId: params.serverId });
  }

  try {
    const templates = await params.client.listResourceTemplates();
    for (const template of templates) {
      if (!isResourceAllowed(template.uriTemplate, template.mimeType, params.resources)) continue;
      const id = toStableId(applyTransforms(template.uriTemplate, params.resources.transform));
      out.push({
        kind: 'resource_template',
        id,
        serverId: params.serverId,
        uriTemplate: template.uriTemplate,
        variables: extractTemplateVariables(template.uriTemplate),
        name: template.name,
        description: template.description,
        mimeType: template.mimeType,
      });
    }
  } catch (err: unknown) {
    log.debug('MCP resources/templates/list unavailable', err, { serverId: params.serverId });
  }
  return out;
}

async function loadResourceSkills(params: {
  serverId: string;
  client: McpSdkClient;
  cfg: McpResourceConfig;
  resources: readonly McpResourceCatalogEntry[];
}): Promise<McpVirtualSkill[]> {
  if (!params.cfg.skills.enabled) return [];
  const out: McpVirtualSkill[] = [];
  for (const resource of params.resources) {
    if (resource.kind !== 'resource') continue;
    if (!isExposed(resource.uri, params.cfg.skills)) continue;
    if (!isMarkdownLike(resource.mimeType)) continue;
    const contents = await params.client.readResource(resource.uri);
    const text = renderResourceContent(contents);
    enforceMaxBytes(text, params.cfg.maxBytes, resource.uri);
    const parsed = parseVirtualSkill(text, resource.uri);
    const skillId = toStableId(applyTransforms(resource.uri, params.cfg.skills.transform));
    out.push({
      id: skillId,
      title: parsed.name,
      description: parsed.description,
      body: parsed.body,
      serverId: params.serverId,
      resourceId: resource.id,
      uri: resource.uri,
      declaredAllowedTools: parsed.declaredAllowedTools,
      userInvocable: parsed.userInvocable,
      disableModelInvocation: parsed.disableModelInvocation,
    });
  }
  return out;
}

function parseVirtualSkill(
  raw: string,
  sourceLabel: string,
): Readonly<{
  name: string;
  description: string;
  body: string;
  declaredAllowedTools?: readonly string[];
  userInvocable?: boolean;
  disableModelInvocation?: boolean;
}> {
  const { body, frontmatter } = parseMarkdownFrontmatter(
    raw,
    `MCP resource skill '${sourceLabel}'`,
  );
  const nameValue = frontmatter['name'];
  if (typeof nameValue !== 'string' || nameValue.trim() === '') {
    throw new Error(`Invalid MCP resource skill frontmatter: 'name' is required (${sourceLabel})`);
  }
  const descriptionValue = frontmatter['description'];
  if (typeof descriptionValue !== 'string' || descriptionValue.trim() === '') {
    throw new Error(
      `Invalid MCP resource skill frontmatter: 'description' is required (${sourceLabel})`,
    );
  }
  const prompt = body.trim();
  if (prompt === '') {
    throw new Error(`Invalid MCP resource skill: markdown body is required (${sourceLabel})`);
  }
  const allowedToolsValue = frontmatter['allowed-tools'];
  const declaredAllowedTools = parseAllowedTools(allowedToolsValue, sourceLabel);
  const userInvocable = parseOptionalBoolean(
    frontmatter['user-invocable'],
    'user-invocable',
    sourceLabel,
  );
  const disableModelInvocation = parseOptionalBoolean(
    frontmatter['disable-model-invocation'],
    'disable-model-invocation',
    sourceLabel,
  );
  for (const key of Object.keys(frontmatter)) {
    if (
      key !== 'name' &&
      key !== 'description' &&
      key !== 'allowed-tools' &&
      key !== 'user-invocable' &&
      key !== 'disable-model-invocation'
    ) {
      throw new Error(
        `Invalid MCP resource skill frontmatter: unsupported key '${key}' (${sourceLabel})`,
      );
    }
  }
  return {
    name: nameValue.trim(),
    description: descriptionValue.trim(),
    body: prompt,
    declaredAllowedTools,
    userInvocable,
    disableModelInvocation,
  };
}

function parseAllowedTools(value: unknown, sourceLabel: string): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') {
    const values = value
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item !== '');
    if (values.length === 0) {
      throw new Error(
        `Invalid MCP resource skill frontmatter: 'allowed-tools' string must not be empty (${sourceLabel})`,
      );
    }
    return values;
  }
  if (!Array.isArray(value)) {
    throw new Error(
      `Invalid MCP resource skill frontmatter: 'allowed-tools' must be string or string[] (${sourceLabel})`,
    );
  }
  const out: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (typeof item !== 'string' || item.trim() === '') {
      throw new Error(
        `Invalid MCP resource skill frontmatter: 'allowed-tools[${String(index)}]' must be non-empty string (${sourceLabel})`,
      );
    }
    out.push(item.trim());
  }
  return out;
}

function parseOptionalBoolean(
  value: unknown,
  key: string,
  sourceLabel: string,
): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  throw new Error(
    `Invalid MCP resource skill frontmatter: '${key}' must be boolean (${sourceLabel})`,
  );
}

function isResourceAllowed(
  uriOrTemplate: string,
  mimeType: string | undefined,
  cfg: McpResourceConfig,
): boolean {
  if (!isExposed(uriOrTemplate, cfg)) return false;
  if (cfg.mimeTypes.length === 0) return true;
  if (!mimeType) return false;
  return cfg.mimeTypes.includes(mimeType);
}

function isExposed(value: string, rules: ExposureRules): boolean {
  const whitelisted = rules.whitelist.some((pattern) => wildcardMatch(pattern, value));
  const blacklisted = rules.blacklist.some((pattern) => wildcardMatch(pattern, value));
  if (rules.blacklist.length > 0) {
    return whitelisted || !blacklisted;
  }
  if (rules.whitelist.length > 0) {
    return whitelisted;
  }
  return true;
}

function wildcardMatch(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(value);
}

function applyTransforms(value: string, transforms: readonly ToolNameTransform[]): string {
  return applyToolNameTransforms(value, transforms);
}

function toStableId(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  return sanitized !== '' ? sanitized : 'resource';
}

function isMarkdownLike(mimeType: string | undefined): boolean {
  return mimeType === undefined || mimeType === 'text/markdown' || mimeType === 'text/plain';
}

function enforceMaxBytes(text: string, maxBytes: number | undefined, label: string): void {
  const limit = maxBytes ?? DEFAULT_RESOURCE_MAX_BYTES;
  const byteLength = Buffer.byteLength(text, 'utf8');
  if (byteLength > limit) {
    throw new Error(`MCP resource '${label}' exceeds maxBytes (${byteLength} > ${limit})`);
  }
}

function extractTemplateVariables(uriTemplate: string): readonly string[] {
  const out = new Set<string>();
  const matches = uriTemplate.matchAll(/\{([^}]+)\}/g);
  for (const match of matches) {
    const raw = match[1];
    if (typeof raw !== 'string') continue;
    for (const name of parseTemplateExpression(raw).variables) {
      out.add(name);
    }
  }
  return [...out].sort();
}

type UriTemplateOperator = '' | '+' | '#' | '.' | '/' | ';' | '?' | '&';

function parseTemplateExpression(rawValue: string): Readonly<{
  operator: UriTemplateOperator;
  variables: readonly string[];
}> {
  const raw = rawValue.trim();
  const operator = parseUriTemplateOperator(raw);
  const body = operator === '' ? raw : raw.slice(1);
  const variables = body
    .split(',')
    .map((token) => token.replace(/\*$/, '').split(':')[0]?.trim() ?? '')
    .filter((name) => name !== '');
  if (variables.length === 0) {
    throw new Error(`Invalid MCP resource template expression '{${rawValue}}'`);
  }
  return { operator, variables };
}

function parseUriTemplateOperator(raw: string): UriTemplateOperator {
  const first = raw[0];
  if (
    first === '+' ||
    first === '#' ||
    first === '.' ||
    first === '/' ||
    first === ';' ||
    first === '?' ||
    first === '&'
  ) {
    return first;
  }
  return '';
}

function encodeUriTemplateReservedValue(value: string): string {
  return encodeURI(value).replace(/%5B/g, '[').replace(/%5D/g, ']');
}

function extractPromptMessageText(value: unknown): string {
  if (!isRecord(value) || Array.isArray(value)) return JSON.stringify(value);
  const role = typeof value.role === 'string' ? value.role : undefined;
  const content = value.content;
  const contentText = extractPromptContentText(content);
  if (!role) return contentText;
  return `<!-- role: ${role} -->\n${contentText}`;
}

function extractPromptContentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!isRecord(value) || Array.isArray(value)) return JSON.stringify(value);
  if (value.type === 'text' && typeof value.text === 'string') return value.text;
  return JSON.stringify(value);
}

function registerUnique<T>(map: Map<string, T>, id: string, value: T, label: string): void {
  if (map.has(id)) {
    throw new Error(`Duplicate ${label} id '${id}'`);
  }
  map.set(id, value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
