import type { I18nText } from './types/i18n';
import type { FuncResultContentItem } from './types/storage';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;
export type JsonObject = { [key: string]: JsonValue };
export type JsonArray = JsonValue[];

function isJsonPrimitive(value: unknown): value is JsonPrimitive {
  return (
    typeof value === 'string' ||
    (typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0)) ||
    typeof value === 'boolean' ||
    value === null
  );
}

function hasPlainObjectPrototype(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  if (prototype === null) return true;
  if (Object.getPrototypeOf(prototype) !== null) return false;
  const constructor = Object.getOwnPropertyDescriptor(prototype, 'constructor')?.value;
  return typeof constructor === 'function' && constructor.name === 'Object';
}

function hasPlainArrayPrototype(value: ReadonlyArray<unknown>): boolean {
  const prototype = Object.getPrototypeOf(value);
  if (prototype === null) return false;
  const objectPrototype = Object.getPrototypeOf(prototype);
  if (objectPrototype === null || Object.getPrototypeOf(objectPrototype) !== null) return false;
  const constructor = Object.getOwnPropertyDescriptor(prototype, 'constructor')?.value;
  return typeof constructor === 'function' && constructor.name === 'Array';
}

function hasOnlyJsonObjectProperties(value: Readonly<Record<string, unknown>>): boolean {
  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== 'string') return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return (
      descriptor?.enumerable === true && Object.prototype.hasOwnProperty.call(descriptor, 'value')
    );
  });
}

function hasOnlyJsonArrayProperties(value: ReadonlyArray<unknown>): boolean {
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== value.length + 1 || !ownKeys.includes('length')) return false;
  for (let index = 0; index < value.length; index += 1) {
    const key = String(index);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor?.enumerable !== true ||
      !Object.prototype.hasOwnProperty.call(descriptor, 'value')
    ) {
      return false;
    }
  }
  return true;
}

export function isJsonValue(
  value: unknown,
  ancestors: Set<object> = new Set(),
): value is JsonValue {
  if (isJsonPrimitive(value)) return true;
  if (Array.isArray(value)) {
    if (!hasPlainArrayPrototype(value) || !hasOnlyJsonArrayProperties(value)) return false;
    if (ancestors.has(value)) return false;
    ancestors.add(value);
    for (let index = 0; index < value.length; index += 1) {
      if (!isJsonValue(value[index], ancestors)) {
        ancestors.delete(value);
        return false;
      }
    }
    ancestors.delete(value);
    return true;
  }
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (!hasPlainObjectPrototype(record) || !hasOnlyJsonObjectProperties(record)) return false;
  if (ancestors.has(record)) return false;
  ancestors.add(record);
  for (const item of Object.values(record)) {
    if (!isJsonValue(item, ancestors)) {
      ancestors.delete(record);
      return false;
    }
  }
  ancestors.delete(record);
  return true;
}

export type ToolArguments = JsonObject;
// JSON Schema authoring stays structurally open so callers can build schemas incrementally.
// parseDomindsAppInstallJson() is the trust boundary that requires the final value to be a
// lossless JsonObject before it enters the install/runtime contract.
export type JsonSchema = Record<string, unknown>;
export type ToolOutcome = 'success' | 'failure' | 'partial_failure';
export type ToolCallOutput = Readonly<{
  content: string;
  outcome: ToolOutcome;
  contentItems?: ReadonlyArray<FuncResultContentItem>;
}>;

export function toolResult(
  content: string,
  outcome: ToolOutcome,
  contentItems?: ReadonlyArray<FuncResultContentItem>,
): ToolCallOutput {
  return {
    content,
    outcome,
    ...(contentItems === undefined ? {} : { contentItems }),
  };
}

export function toolSuccess(
  content: string,
  contentItems?: ReadonlyArray<FuncResultContentItem>,
): ToolCallOutput {
  return toolResult(content, 'success', contentItems);
}

export function toolFailure(
  content: string,
  contentItems?: ReadonlyArray<FuncResultContentItem>,
): ToolCallOutput {
  return toolResult(content, 'failure', contentItems);
}

export function toolPartialFailure(
  content: string,
  contentItems?: ReadonlyArray<FuncResultContentItem>,
): ToolCallOutput {
  return toolResult(content, 'partial_failure', contentItems);
}
export type ReminderUpdateResult = Readonly<
  | { treatment: 'drop' }
  | { treatment: 'keep' }
  | { treatment: 'update'; updatedContent: string; updatedMeta?: JsonValue }
>;

export type DomindsAppToolJson = Readonly<{
  name: string;
  description?: string;
  descriptionI18n?: I18nText;
  parameters: JsonSchema;
}>;

export type DomindsAppToolsetJson = Readonly<{
  id: string;
  descriptionI18n?: I18nText;
  tools: ReadonlyArray<DomindsAppToolJson>;
}>;

export type DomindsAppReminderOwnerJson = Readonly<{
  ref: string;
  manager?: Readonly<{
    tool: string;
  }>;
  update?: Readonly<{
    altInstruction: string;
  }>;
  delete?: Readonly<{
    altInstruction: string;
  }>;
}>;

export type DomindsAppContributesJson = Readonly<{
  teammatesYamlRelPath?: string;
  toolsets?: ReadonlyArray<DomindsAppToolsetJson>;
  reminderOwners?: ReadonlyArray<DomindsAppReminderOwnerJson>;
}>;

export type DomindsAppHostEntryJson = Readonly<{
  kind: 'node_module';
  moduleRelPath: string;
  exportName: string;
}>;

export type DomindsAppFrontendJson = Readonly<{
  kind: 'http';
  defaultPort?: number;
  basePath?: string;
  wsPath?: string;
}>;

export type DomindsAppInstallJson = Readonly<{
  appId: string;
  displayName?: string;
  package: Readonly<{
    name: string;
    version: string | null;
    rootAbs: string;
  }>;
  host: DomindsAppHostEntryJson;
  frontend?: DomindsAppFrontendJson;
  contributes?: DomindsAppContributesJson;
}>;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && hasPlainObjectPrototype(v);
}

function listUnsupportedProperties(
  value: Readonly<Record<string, unknown>>,
  allowedProperties: ReadonlyArray<string>,
): string[] {
  const allowed = new Set(allowedProperties);
  return Reflect.ownKeys(value)
    .filter((key) => {
      if (typeof key !== 'string' || !allowed.has(key)) return true;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return (
        descriptor?.enumerable !== true ||
        !Object.prototype.hasOwnProperty.call(descriptor, 'value')
      );
    })
    .map(String)
    .sort();
}

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function isI18nText(v: unknown): v is I18nText {
  return (
    isRecord(v) &&
    listUnsupportedProperties(v, ['zh', 'en']).length === 0 &&
    typeof v['zh'] === 'string' &&
    typeof v['en'] === 'string'
  );
}

function isJsonSchema(v: unknown): v is JsonSchema {
  return isRecord(v) && isJsonValue(v);
}

function parseToolJson(
  v: unknown,
  at: string,
): { ok: true; tool: DomindsAppToolJson } | { ok: false; errorText: string } {
  if (!isRecord(v)) return { ok: false, errorText: `Invalid ${at}: expected object` };
  const unsupportedKeys = listUnsupportedProperties(v, [
    'name',
    'description',
    'descriptionI18n',
    'parameters',
  ]);
  if (unsupportedKeys.length > 0) {
    return {
      ok: false,
      errorText: `Invalid ${at}: contains unsupported properties: ${unsupportedKeys.join(', ')}`,
    };
  }
  const name = asString(v['name']);
  if (!name || name.trim() === '') return { ok: false, errorText: `Invalid ${at}.name: required` };
  const descriptionRaw = v['description'];
  if (descriptionRaw !== undefined && typeof descriptionRaw !== 'string') {
    return { ok: false, errorText: `Invalid ${at}.description: expected string` };
  }
  const description = descriptionRaw;
  const descriptionI18n = v['descriptionI18n'];
  if (descriptionI18n !== undefined && !isI18nText(descriptionI18n)) {
    return { ok: false, errorText: `Invalid ${at}.descriptionI18n: expected {zh,en} string` };
  }
  const parameters = v['parameters'];
  if (!isJsonSchema(parameters)) {
    return {
      ok: false,
      errorText: `Invalid ${at}.parameters: expected lossless JSON object`,
    };
  }
  return {
    ok: true,
    tool: {
      name,
      ...(description === undefined ? {} : { description }),
      ...(descriptionI18n === undefined ? {} : { descriptionI18n }),
      parameters,
    },
  };
}

function parseToolsetJson(
  v: unknown,
  at: string,
): { ok: true; toolset: DomindsAppToolsetJson } | { ok: false; errorText: string } {
  if (!isRecord(v)) return { ok: false, errorText: `Invalid ${at}: expected object` };
  const unsupportedKeys = listUnsupportedProperties(v, ['id', 'descriptionI18n', 'tools']);
  if (unsupportedKeys.length > 0) {
    return {
      ok: false,
      errorText: `Invalid ${at}: contains unsupported properties: ${unsupportedKeys.join(', ')}`,
    };
  }
  const id = asString(v['id']);
  if (!id || id.trim() === '') return { ok: false, errorText: `Invalid ${at}.id: required` };
  const descriptionI18n = v['descriptionI18n'];
  if (descriptionI18n !== undefined && !isI18nText(descriptionI18n)) {
    return { ok: false, errorText: `Invalid ${at}.descriptionI18n: expected {zh,en} string` };
  }
  const toolsRaw = v['tools'];
  if (!Array.isArray(toolsRaw))
    return { ok: false, errorText: `Invalid ${at}.tools: expected array` };
  const tools: DomindsAppToolJson[] = [];
  for (let i = 0; i < toolsRaw.length; i += 1) {
    const parsed = parseToolJson(toolsRaw[i], `${at}.tools[${i}]`);
    if (!parsed.ok) return parsed;
    tools.push(parsed.tool);
  }
  return {
    ok: true,
    toolset: {
      id,
      ...(descriptionI18n === undefined ? {} : { descriptionI18n }),
      tools,
    },
  };
}

function parseReminderOwnerJson(
  v: unknown,
  at: string,
): { ok: true; owner: DomindsAppReminderOwnerJson } | { ok: false; errorText: string } {
  if (!isRecord(v)) return { ok: false, errorText: `Invalid ${at}: expected object` };
  const unsupportedOwnerKeys = listUnsupportedProperties(v, ['ref', 'manager', 'update', 'delete']);
  if (unsupportedOwnerKeys.length > 0) {
    return {
      ok: false,
      errorText: `Invalid ${at}: contains unsupported properties: ${unsupportedOwnerKeys.join(', ')}`,
    };
  }
  const ref = asString(v['ref']);
  if (!ref || ref.trim() === '') return { ok: false, errorText: `Invalid ${at}.ref: required` };
  const managerRaw = v['manager'];
  let manager: DomindsAppReminderOwnerJson['manager'];
  if (managerRaw !== undefined) {
    if (!isRecord(managerRaw)) {
      return { ok: false, errorText: `Invalid ${at}.manager: expected object` };
    }
    const unsupportedManagerKeys = listUnsupportedProperties(managerRaw, ['tool']);
    if (unsupportedManagerKeys.length > 0) {
      return {
        ok: false,
        errorText: `Invalid ${at}.manager: contains unsupported properties: ${unsupportedManagerKeys.join(', ')}`,
      };
    }
    const tool = asString(managerRaw['tool']);
    if (!tool || tool.trim() === '') {
      return { ok: false, errorText: `Invalid ${at}.manager.tool: required` };
    }
    manager = { tool };
  }

  const updateRaw = v['update'];
  let update: DomindsAppReminderOwnerJson['update'];
  if (updateRaw !== undefined) {
    if (!isRecord(updateRaw)) {
      return { ok: false, errorText: `Invalid ${at}.update: expected object` };
    }
    const unsupportedUpdateKeys = listUnsupportedProperties(updateRaw, ['altInstruction']);
    if (unsupportedUpdateKeys.length > 0) {
      return {
        ok: false,
        errorText: `Invalid ${at}.update: contains unsupported properties: ${unsupportedUpdateKeys.join(', ')}`,
      };
    }
    const altInstruction = asString(updateRaw['altInstruction']);
    if (!altInstruction || altInstruction.trim() === '') {
      return { ok: false, errorText: `Invalid ${at}.update.altInstruction: required` };
    }
    update = { altInstruction };
  }

  const deleteRaw = v['delete'];
  let del: DomindsAppReminderOwnerJson['delete'];
  if (deleteRaw !== undefined) {
    if (!isRecord(deleteRaw)) {
      return { ok: false, errorText: `Invalid ${at}.delete: expected object` };
    }
    const unsupportedDeleteKeys = listUnsupportedProperties(deleteRaw, ['altInstruction']);
    if (unsupportedDeleteKeys.length > 0) {
      return {
        ok: false,
        errorText: `Invalid ${at}.delete: contains unsupported properties: ${unsupportedDeleteKeys.join(', ')}`,
      };
    }
    const altInstruction = asString(deleteRaw['altInstruction']);
    if (!altInstruction || altInstruction.trim() === '') {
      return { ok: false, errorText: `Invalid ${at}.delete.altInstruction: required` };
    }
    del = { altInstruction };
  }
  return {
    ok: true,
    owner: {
      ref,
      ...(manager === undefined ? {} : { manager }),
      ...(update === undefined ? {} : { update }),
      ...(del === undefined ? {} : { delete: del }),
    },
  };
}

export function parseDomindsAppInstallJson(
  v: unknown,
): { ok: true; json: DomindsAppInstallJson } | { ok: false; errorText: string } {
  if (!isRecord(v)) {
    return {
      ok: false,
      errorText:
        'Invalid app --dominds-app output: expected a plain JSON object (class instances are not supported)',
    };
  }
  const unsupportedRootKeys = listUnsupportedProperties(v, [
    'appId',
    'displayName',
    'package',
    'host',
    'frontend',
    'contributes',
  ]);
  if (unsupportedRootKeys.length > 0) {
    return {
      ok: false,
      errorText: `Invalid app json: contains unsupported properties: ${unsupportedRootKeys.join(', ')}`,
    };
  }
  const appId = asString(v['appId']);
  if (!appId || appId.trim() === '')
    return { ok: false, errorText: 'Invalid app json: appId required' };
  const displayNameRaw = v['displayName'];
  if (displayNameRaw !== undefined && typeof displayNameRaw !== 'string') {
    return { ok: false, errorText: 'Invalid app json: displayName must be a string' };
  }
  const displayName = displayNameRaw;

  const pkg = v['package'];
  if (!isRecord(pkg))
    return { ok: false, errorText: 'Invalid app json: package must be an object' };
  const unsupportedPackageKeys = listUnsupportedProperties(pkg, ['name', 'version', 'rootAbs']);
  if (unsupportedPackageKeys.length > 0) {
    return {
      ok: false,
      errorText: `Invalid app json: package contains unsupported properties: ${unsupportedPackageKeys.join(', ')}`,
    };
  }
  const packageName = asString(pkg['name']);
  const packageVersionRaw = pkg['version'];
  if (packageVersionRaw !== null && typeof packageVersionRaw !== 'string') {
    return { ok: false, errorText: 'Invalid app json: package.version must be string|null' };
  }
  const packageVersion = packageVersionRaw;
  const rootAbs = asString(pkg['rootAbs']);
  if (!packageName || packageName.trim() === '') {
    return { ok: false, errorText: 'Invalid app json: package.name required' };
  }
  if (packageVersion !== null && (!packageVersion || packageVersion.trim() === '')) {
    return { ok: false, errorText: 'Invalid app json: package.version must be string|null' };
  }
  if (!rootAbs || rootAbs.trim() === '') {
    return { ok: false, errorText: 'Invalid app json: package.rootAbs required' };
  }

  const host = v['host'];
  if (!isRecord(host)) return { ok: false, errorText: 'Invalid app json: host must be an object' };
  const unsupportedHostKeys = listUnsupportedProperties(host, [
    'kind',
    'moduleRelPath',
    'exportName',
  ]);
  if (unsupportedHostKeys.length > 0) {
    return {
      ok: false,
      errorText: `Invalid app json: host contains unsupported properties: ${unsupportedHostKeys.join(', ')}`,
    };
  }
  const hostKind = asString(host['kind']);
  if (hostKind !== 'node_module') {
    return { ok: false, errorText: "Invalid app json: host.kind must be 'node_module'" };
  }
  const moduleRelPath = asString(host['moduleRelPath']);
  const exportName = asString(host['exportName']);
  if (!moduleRelPath || moduleRelPath.trim() === '') {
    return { ok: false, errorText: 'Invalid app json: host.moduleRelPath required' };
  }
  if (!exportName || exportName.trim() === '') {
    return { ok: false, errorText: 'Invalid app json: host.exportName required' };
  }

  const frontendRaw = v['frontend'];
  let frontend: DomindsAppFrontendJson | undefined;
  if (frontendRaw !== undefined) {
    if (!isRecord(frontendRaw))
      return { ok: false, errorText: 'Invalid app json: frontend must be an object' };
    const unsupportedFrontendKeys = listUnsupportedProperties(frontendRaw, [
      'kind',
      'defaultPort',
      'basePath',
      'wsPath',
    ]);
    if (unsupportedFrontendKeys.length > 0) {
      return {
        ok: false,
        errorText: `Invalid app json: frontend contains unsupported properties: ${unsupportedFrontendKeys.join(', ')}`,
      };
    }
    const kind = asString(frontendRaw['kind']);
    if (kind !== 'http')
      return { ok: false, errorText: "Invalid app json: frontend.kind must be 'http'" };
    const defaultPortRaw = frontendRaw['defaultPort'];
    const defaultPort =
      defaultPortRaw === undefined
        ? undefined
        : typeof defaultPortRaw === 'number' &&
            Number.isInteger(defaultPortRaw) &&
            !Object.is(defaultPortRaw, -0)
          ? defaultPortRaw
          : null;
    if (
      defaultPort === null ||
      (defaultPort !== undefined && (defaultPort < 0 || defaultPort > 65_535))
    ) {
      return {
        ok: false,
        errorText:
          'Invalid app json: frontend.defaultPort must be an integer between 0 and 65535; negative zero (-0) is not supported',
      };
    }
    const basePathRaw = frontendRaw['basePath'];
    if (basePathRaw !== undefined && typeof basePathRaw !== 'string') {
      return { ok: false, errorText: 'Invalid app json: frontend.basePath must be a string' };
    }
    const wsPathRaw = frontendRaw['wsPath'];
    if (wsPathRaw !== undefined && typeof wsPathRaw !== 'string') {
      return { ok: false, errorText: 'Invalid app json: frontend.wsPath must be a string' };
    }
    const basePath = basePathRaw;
    const wsPath = wsPathRaw;
    frontend = {
      kind: 'http',
      ...(defaultPort === undefined ? {} : { defaultPort }),
      ...(basePath === undefined ? {} : { basePath }),
      ...(wsPath === undefined ? {} : { wsPath }),
    };
  }

  const contributesRaw = v['contributes'];
  let contributes: DomindsAppContributesJson | undefined;
  if (contributesRaw !== undefined) {
    if (!isRecord(contributesRaw))
      return { ok: false, errorText: 'Invalid app json: contributes must be an object' };
    const unsupportedContributesKeys = listUnsupportedProperties(contributesRaw, [
      'teammatesYamlRelPath',
      'toolsets',
      'reminderOwners',
    ]);
    if (unsupportedContributesKeys.length > 0) {
      return {
        ok: false,
        errorText:
          'Invalid app json: contributes contains unsupported properties: ' +
          unsupportedContributesKeys.join(', '),
      };
    }
    const teammatesYamlRelPathRaw = contributesRaw['teammatesYamlRelPath'];
    if (
      teammatesYamlRelPathRaw !== undefined &&
      (typeof teammatesYamlRelPathRaw !== 'string' || teammatesYamlRelPathRaw.trim() === '')
    ) {
      return {
        ok: false,
        errorText: 'Invalid app json: contributes.teammatesYamlRelPath must be a non-empty string',
      };
    }
    const teammatesYamlRelPath = teammatesYamlRelPathRaw;

    const toolsetsRaw = contributesRaw['toolsets'];
    let toolsets: DomindsAppToolsetJson[] | undefined;
    if (toolsetsRaw !== undefined) {
      if (!Array.isArray(toolsetsRaw)) {
        return { ok: false, errorText: 'Invalid app json: contributes.toolsets must be an array' };
      }
      toolsets = [];
      const toolsetIds = new Set<string>();
      const toolNames = new Set<string>();
      for (let i = 0; i < toolsetsRaw.length; i += 1) {
        const parsed = parseToolsetJson(toolsetsRaw[i], `contributes.toolsets[${i}]`);
        if (!parsed.ok) return parsed;
        if (toolsetIds.has(parsed.toolset.id)) {
          return {
            ok: false,
            errorText: `Invalid app json: duplicate toolset id '${parsed.toolset.id}'`,
          };
        }
        toolsetIds.add(parsed.toolset.id);
        for (const tool of parsed.toolset.tools) {
          if (toolNames.has(tool.name)) {
            return {
              ok: false,
              errorText: `Invalid app json: duplicate tool name '${tool.name}'`,
            };
          }
          toolNames.add(tool.name);
        }
        toolsets.push(parsed.toolset);
      }
    }

    const reminderOwnersRaw = contributesRaw['reminderOwners'];
    let reminderOwners: DomindsAppReminderOwnerJson[] | undefined;
    if (reminderOwnersRaw !== undefined) {
      if (!Array.isArray(reminderOwnersRaw)) {
        return {
          ok: false,
          errorText: 'Invalid app json: contributes.reminderOwners must be an array',
        };
      }
      reminderOwners = [];
      const reminderOwnerRefs = new Set<string>();
      for (let i = 0; i < reminderOwnersRaw.length; i += 1) {
        const parsed = parseReminderOwnerJson(
          reminderOwnersRaw[i],
          `contributes.reminderOwners[${i}]`,
        );
        if (!parsed.ok) return parsed;
        if (reminderOwnerRefs.has(parsed.owner.ref)) {
          return {
            ok: false,
            errorText: `Invalid app json: duplicate reminder owner ref '${parsed.owner.ref}'`,
          };
        }
        reminderOwnerRefs.add(parsed.owner.ref);
        reminderOwners.push(parsed.owner);
      }
    }
    contributes = {
      ...(teammatesYamlRelPath === undefined ? {} : { teammatesYamlRelPath }),
      ...(toolsets === undefined ? {} : { toolsets }),
      ...(reminderOwners === undefined ? {} : { reminderOwners }),
    };
  }

  return {
    ok: true,
    json: {
      appId,
      ...(displayName === undefined ? {} : { displayName }),
      package: { name: packageName, version: packageVersion, rootAbs },
      host: { kind: 'node_module', moduleRelPath, exportName },
      ...(frontend === undefined ? {} : { frontend }),
      ...(contributes === undefined ? {} : { contributes }),
    },
  };
}

export type DomindsAppHostToolContext = Readonly<{
  dialogId: string;
  mainDialogId: string;
  agentId: string;
  taskDocPath: string;
  sessionSlug?: string;
  callerId: string;
}>;

export type DomindsAppDialogTargetRef = Readonly<
  | { dialogId: string }
  | {
      mainDialogId?: string;
      agentId: string;
      sessionSlug?: string;
    }
>;

export type DomindsAppDialogInfo = Readonly<{
  dialogId: string;
  mainDialogId: string;
  agentId: string;
  sessionSlug?: string;
}>;

export type DomindsAppReminderState = Readonly<{
  content: string;
  meta?: JsonValue;
  echoback?: boolean;
  renderMode?: 'plain' | 'markdown';
}>;

export type DomindsAppReminderApplyRequest = Readonly<
  | {
      kind: 'upsert';
      ownerRef: string;
      content: string;
      meta?: JsonValue;
      position?: number;
      echoback?: boolean;
      renderMode?: 'plain' | 'markdown';
    }
  | {
      kind: 'delete';
      ownerRef: string;
      meta?: JsonValue;
    }
>;

export type DomindsAppReminderApplyResult = Readonly<
  | { treatment: 'noop' }
  | { treatment: 'add'; reminder: DomindsAppReminderState; position?: number }
  | { treatment: 'update'; ownedIndex: number; reminder: DomindsAppReminderState }
  | { treatment: 'delete'; ownedIndex: number }
>;

export type DomindsAppDialogReminderRequestBatch = Readonly<{
  target: DomindsAppDialogTargetRef;
  reminderRequests: ReadonlyArray<DomindsAppReminderApplyRequest>;
}>;

export type DomindsAppHostToolResult = Readonly<{
  output: ToolCallOutput;
  reminderRequests?: ReadonlyArray<DomindsAppReminderApplyRequest>;
  dialogReminderRequests?: ReadonlyArray<DomindsAppDialogReminderRequestBatch>;
}>;

type DomindsAppHostToolResultOptions = Readonly<{
  reminderRequests?: ReadonlyArray<DomindsAppReminderApplyRequest>;
  dialogReminderRequests?: ReadonlyArray<DomindsAppDialogReminderRequestBatch>;
}>;

export function appToolResult(
  output: ToolCallOutput,
  options?: DomindsAppHostToolResultOptions,
): DomindsAppHostToolResult {
  return {
    output,
    ...(options?.reminderRequests === undefined
      ? {}
      : { reminderRequests: options.reminderRequests }),
    ...(options?.dialogReminderRequests === undefined
      ? {}
      : { dialogReminderRequests: options.dialogReminderRequests }),
  };
}

export function appToolSuccess(
  content: string,
  options?: DomindsAppHostToolResultOptions &
    Readonly<{ contentItems?: ReadonlyArray<FuncResultContentItem> }>,
): DomindsAppHostToolResult {
  return appToolResult(toolSuccess(content, options?.contentItems), options);
}

export function appToolFailure(
  content: string,
  options?: DomindsAppHostToolResultOptions &
    Readonly<{ contentItems?: ReadonlyArray<FuncResultContentItem> }>,
): DomindsAppHostToolResult {
  return appToolResult(toolFailure(content, options?.contentItems), options);
}

export function appToolPartialFailure(
  content: string,
  options?: DomindsAppHostToolResultOptions &
    Readonly<{ contentItems?: ReadonlyArray<FuncResultContentItem> }>,
): DomindsAppHostToolResult {
  return appToolResult(toolPartialFailure(content, options?.contentItems), options);
}

export type DomindsAppHostToolHandler = (
  args: ToolArguments,
  ctx: DomindsAppHostToolContext,
) => Promise<DomindsAppHostToolResult>;

export type DomindsAppHostReminderUpdateResult = ReminderUpdateResult;
