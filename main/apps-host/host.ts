#!/usr/bin/env node

import path from 'path';
import { pathToFileURL } from 'url';

import type {
  CreateDomindsAppFn,
  DomindsAppHostInstance,
  DomindsAppHostStartResult,
  DomindsAppReminderOwnerHandler,
  DomindsAppReminderRenderedMessage,
} from '@longrun-ai/kernel/app-host-contract';
import {
  isJsonValue,
  type DomindsAppDialogReminderRequestBatch,
  type DomindsAppDialogTargetRef,
  type DomindsAppHostReminderUpdateResult,
  type DomindsAppHostToolResult,
  type DomindsAppReminderApplyRequest,
  type DomindsAppReminderApplyResult,
  type DomindsAppReminderState,
} from '@longrun-ai/kernel/app-json';
import type { FuncResultContentItem } from '@longrun-ai/kernel/types/storage';
import { resolveDomindsAppRtwsDirAbs } from '../apps/app-id';
import { createLogger } from '../log';
import {
  parseAppsHostMessageFromKernel,
  type AppsHostKernelInitMessage,
  type AppsHostMessageToKernel,
} from './ipc-types';

const log = createLogger('apps-host');

const dynamicImport: (specifier: string) => Promise<unknown> = new Function(
  'specifier',
  'return import(specifier)',
) as (specifier: string) => Promise<unknown>;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isLosslessFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0);
}

function assertSupportedProperties(
  value: Readonly<Record<string, unknown>>,
  allowedProperties: ReadonlyArray<string>,
  label: string,
): void {
  const allowed = new Set(allowedProperties);
  const ownKeys = Reflect.ownKeys(value);
  const unsupported = ownKeys
    .filter((key) => typeof key !== 'string' || !allowed.has(key))
    .map((key) => String(key))
    .sort();
  if (unsupported.length > 0) {
    throw new Error(`${label} contains unsupported properties: ${unsupported.join(', ')}`);
  }
  for (const key of ownKeys) {
    if (typeof key !== 'string') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor?.enumerable !== true ||
      !Object.prototype.hasOwnProperty.call(descriptor, 'value')
    ) {
      throw new Error(`${label}.${key} must be an enumerable data property`);
    }
  }
}

function assertEnumerableDataProperties(
  value: Readonly<Record<string, unknown>>,
  label: string,
): void {
  const ownKeys = Reflect.ownKeys(value);
  for (const key of ownKeys) {
    if (typeof key !== 'string') {
      throw new Error(`${label} contains unsupported symbol property ${String(key)}`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor?.enumerable !== true ||
      !Object.prototype.hasOwnProperty.call(descriptor, 'value')
    ) {
      throw new Error(`${label}.${key} must be an enumerable data property`);
    }
  }
}

function hasExactProperties(
  value: Readonly<Record<string, unknown>>,
  expectedProperties: ReadonlyArray<string>,
): boolean {
  const keys = Object.keys(value).sort();
  const expected = [...expectedProperties].sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function isToolResultImageArtifact(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!hasExactProperties(value, ['rootId', 'selfId', 'status', 'relPath'])) return false;
  const status = value['status'];
  return (
    typeof value['rootId'] === 'string' &&
    value['rootId'].trim() !== '' &&
    typeof value['selfId'] === 'string' &&
    value['selfId'].trim() !== '' &&
    (status === 'running' || status === 'completed' || status === 'archived') &&
    typeof value['relPath'] === 'string' &&
    value['relPath'].trim() !== ''
  );
}

function isFuncResultContentItem(value: unknown): value is FuncResultContentItem {
  if (!isRecord(value)) return false;
  if (value['type'] === 'input_text') {
    return hasExactProperties(value, ['type', 'text']) && typeof value['text'] === 'string';
  }
  if (value['type'] === 'input_image') {
    return (
      hasExactProperties(value, ['type', 'mimeType', 'byteLength', 'artifact']) &&
      typeof value['mimeType'] === 'string' &&
      value['mimeType'].trim() !== '' &&
      typeof value['byteLength'] === 'number' &&
      Number.isInteger(value['byteLength']) &&
      value['byteLength'] >= 0 &&
      isToolResultImageArtifact(value['artifact'])
    );
  }
  return false;
}

function normalizeFuncResultContentItem(item: FuncResultContentItem): FuncResultContentItem {
  if (item.type === 'input_text') {
    return { type: 'input_text', text: item.text };
  }
  return {
    type: 'input_image',
    mimeType: item.mimeType,
    byteLength: item.byteLength,
    artifact: {
      rootId: item.artifact.rootId,
      selfId: item.artifact.selfId,
      status: item.artifact.status,
      relPath: item.artifact.relPath,
    },
  };
}

function isToolCallOutput(value: unknown): value is DomindsAppHostToolResult['output'] {
  if (!isRecord(value)) return false;
  if (typeof value['content'] !== 'string') return false;
  const outcome = value['outcome'];
  if (outcome !== 'success' && outcome !== 'failure' && outcome !== 'partial_failure') {
    return false;
  }
  const contentItems = value['contentItems'];
  return (
    contentItems === undefined ||
    (Array.isArray(contentItems) &&
      isJsonValue(contentItems) &&
      contentItems.every((item) => isFuncResultContentItem(item)))
  );
}

function parseReminderRequest(value: unknown): DomindsAppReminderApplyRequest {
  if (!isRecord(value)) {
    throw new Error('Invalid Application Component tool reminder request: expected object');
  }
  assertEnumerableDataProperties(value, 'Invalid Application Component tool reminder request');
  const kind = value['kind'];
  const ownerRef = value['ownerRef'];
  if (typeof ownerRef !== 'string' || ownerRef.trim() === '') {
    throw new Error('Invalid Application Component tool reminder request: ownerRef required');
  }
  if (kind === 'delete') {
    assertSupportedProperties(
      value,
      ['kind', 'ownerRef', 'meta'],
      'Invalid Application Component tool reminder request',
    );
    const meta = value['meta'];
    if (meta !== undefined && !isJsonValue(meta)) {
      throw new Error(
        'Invalid Application Component tool reminder request: delete.meta must be JSON-serializable',
      );
    }
    return {
      kind: 'delete',
      ownerRef,
      ...(meta === undefined ? {} : { meta }),
    };
  }
  if (kind === 'upsert') {
    assertSupportedProperties(
      value,
      ['kind', 'ownerRef', 'content', 'meta', 'position', 'echoback', 'renderMode'],
      'Invalid Application Component tool reminder request',
    );
    const content = value['content'];
    if (typeof content !== 'string') {
      throw new Error(
        'Invalid Application Component tool reminder request: upsert.content must be string',
      );
    }
    const meta = value['meta'];
    if (meta !== undefined && !isJsonValue(meta)) {
      throw new Error(
        'Invalid Application Component tool reminder request: upsert.meta must be JSON-serializable',
      );
    }
    const positionRaw = value['position'];
    const position =
      positionRaw === undefined
        ? undefined
        : isLosslessFiniteNumber(positionRaw)
          ? positionRaw
          : null;
    if (position === null) {
      throw new Error(
        'Invalid Application Component tool reminder request: upsert.position must be a lossless finite number',
      );
    }
    const echobackRaw = value['echoback'];
    const echoback =
      echobackRaw === undefined ? undefined : typeof echobackRaw === 'boolean' ? echobackRaw : null;
    if (echoback === null) {
      throw new Error(
        'Invalid Application Component tool reminder request: upsert.echoback must be boolean',
      );
    }
    const renderModeRaw = value['renderMode'];
    const renderMode =
      renderModeRaw === undefined
        ? undefined
        : renderModeRaw === 'plain' || renderModeRaw === 'markdown'
          ? renderModeRaw
          : null;
    if (renderMode === null) {
      throw new Error(
        'Invalid Application Component tool reminder request: upsert.renderMode must be plain|markdown',
      );
    }
    return {
      kind: 'upsert',
      ownerRef,
      content,
      ...(meta === undefined ? {} : { meta }),
      ...(position === undefined ? {} : { position }),
      ...(echoback === undefined ? {} : { echoback }),
      ...(renderMode === undefined ? {} : { renderMode }),
    };
  }
  throw new Error(`Invalid Application Component tool reminder request kind: ${String(kind)}`);
}

function parseDialogTargetRef(value: unknown): DomindsAppDialogTargetRef {
  if (!isRecord(value)) throw new Error('Invalid dialog reminder target: expected object');
  assertEnumerableDataProperties(value, 'Invalid dialog reminder target');
  const dialogId = value['dialogId'];
  if (dialogId !== undefined) {
    assertSupportedProperties(value, ['dialogId'], 'Invalid dialog reminder target');
    if (typeof dialogId !== 'string' || dialogId.trim() === '') {
      throw new Error('Invalid dialog reminder target: dialogId must be non-empty string');
    }
    return { dialogId };
  }
  assertSupportedProperties(
    value,
    ['agentId', 'mainDialogId', 'sessionSlug'],
    'Invalid dialog reminder target',
  );
  const agentId = value['agentId'];
  if (typeof agentId !== 'string' || agentId.trim() === '') {
    throw new Error('Invalid dialog reminder target: agentId required when dialogId is absent');
  }
  const mainDialogIdRaw = value['mainDialogId'];
  const mainDialogId =
    mainDialogIdRaw === undefined
      ? undefined
      : typeof mainDialogIdRaw === 'string' && mainDialogIdRaw.trim() !== ''
        ? mainDialogIdRaw
        : null;
  if (mainDialogId === null) {
    throw new Error('Invalid dialog reminder target: mainDialogId must be non-empty string');
  }
  const sessionSlugRaw = value['sessionSlug'];
  const sessionSlug =
    sessionSlugRaw === undefined
      ? undefined
      : typeof sessionSlugRaw === 'string' && sessionSlugRaw.trim() !== ''
        ? sessionSlugRaw
        : null;
  if (sessionSlug === null) {
    throw new Error('Invalid dialog reminder target: sessionSlug must be non-empty string');
  }
  return {
    agentId,
    ...(mainDialogId === undefined ? {} : { mainDialogId }),
    ...(sessionSlug === undefined ? {} : { sessionSlug }),
  };
}

function parseDialogReminderRequestBatch(value: unknown): DomindsAppDialogReminderRequestBatch {
  if (!isRecord(value)) throw new Error('Invalid dialog reminder request batch: expected object');
  assertSupportedProperties(
    value,
    ['target', 'reminderRequests'],
    'Invalid dialog reminder request batch',
  );
  const reminderRequestsRaw = value['reminderRequests'];
  if (!Array.isArray(reminderRequestsRaw)) {
    throw new Error('Invalid dialog reminder request batch: reminderRequests must be an array');
  }
  return {
    target: parseDialogTargetRef(value['target']),
    reminderRequests: reminderRequestsRaw.map((request) => parseReminderRequest(request)),
  };
}

function parseReminderState(value: unknown, label: string): DomindsAppReminderState {
  if (!isRecord(value)) throw new Error(`${label}: expected object`);
  assertSupportedProperties(value, ['content', 'meta', 'echoback', 'renderMode'], label);
  const content = value['content'];
  if (typeof content !== 'string') throw new Error(`${label}.content must be string`);
  const meta = value['meta'];
  if (meta !== undefined && !isJsonValue(meta)) {
    throw new Error(`${label}.meta must be JSON-serializable`);
  }
  const echoback = value['echoback'];
  if (echoback !== undefined && typeof echoback !== 'boolean') {
    throw new Error(`${label}.echoback must be boolean`);
  }
  const renderMode = value['renderMode'];
  if (renderMode !== undefined && renderMode !== 'plain' && renderMode !== 'markdown') {
    throw new Error(`${label}.renderMode must be plain|markdown`);
  }
  return {
    content,
    ...(meta === undefined ? {} : { meta }),
    ...(echoback === undefined ? {} : { echoback }),
    ...(renderMode === undefined ? {} : { renderMode }),
  };
}

function parseReminderApplyResult(value: unknown): DomindsAppReminderApplyResult {
  const label = 'Invalid reminder apply result';
  if (!isRecord(value)) throw new Error(`${label}: expected object`);
  assertEnumerableDataProperties(value, label);
  const treatment = value['treatment'];
  if (treatment === 'noop') {
    assertSupportedProperties(value, ['treatment'], label);
    return { treatment };
  }
  if (treatment === 'add') {
    assertSupportedProperties(value, ['treatment', 'reminder', 'position'], label);
    const position = value['position'];
    if (position !== undefined && !isLosslessFiniteNumber(position)) {
      throw new Error(`${label}.position must be a lossless finite number`);
    }
    return {
      treatment,
      reminder: parseReminderState(value['reminder'], `${label}.reminder`),
      ...(position === undefined ? {} : { position }),
    };
  }
  if (treatment === 'update') {
    assertSupportedProperties(value, ['treatment', 'ownedIndex', 'reminder'], label);
    const ownedIndex = value['ownedIndex'];
    if (typeof ownedIndex !== 'number' || !Number.isInteger(ownedIndex) || ownedIndex < 0) {
      throw new Error(`${label}.ownedIndex must be a non-negative integer`);
    }
    return {
      treatment,
      ownedIndex,
      reminder: parseReminderState(value['reminder'], `${label}.reminder`),
    };
  }
  if (treatment === 'delete') {
    assertSupportedProperties(value, ['treatment', 'ownedIndex'], label);
    const ownedIndex = value['ownedIndex'];
    if (typeof ownedIndex !== 'number' || !Number.isInteger(ownedIndex) || ownedIndex < 0) {
      throw new Error(`${label}.ownedIndex must be a non-negative integer`);
    }
    return { treatment, ownedIndex };
  }
  throw new Error(`${label}.treatment is unsupported: ${String(treatment)}`);
}

function parseReminderUpdateResult(value: unknown): DomindsAppHostReminderUpdateResult {
  const label = 'Invalid reminder update result';
  if (!isRecord(value)) throw new Error(`${label}: expected object`);
  assertEnumerableDataProperties(value, label);
  const treatment = value['treatment'];
  if (treatment === 'drop' || treatment === 'keep') {
    assertSupportedProperties(value, ['treatment'], label);
    return { treatment };
  }
  if (treatment !== 'update') {
    throw new Error(`${label}.treatment is unsupported: ${String(treatment)}`);
  }
  assertSupportedProperties(value, ['treatment', 'updatedContent', 'updatedMeta'], label);
  const updatedContent = value['updatedContent'];
  if (typeof updatedContent !== 'string') {
    throw new Error(`${label}.updatedContent must be string`);
  }
  const updatedMeta = value['updatedMeta'];
  if (updatedMeta !== undefined && !isJsonValue(updatedMeta)) {
    throw new Error(`${label}.updatedMeta must be JSON-serializable`);
  }
  return {
    treatment,
    updatedContent,
    ...(updatedMeta === undefined ? {} : { updatedMeta }),
  };
}

function parseReminderRenderedMessage(value: unknown): DomindsAppReminderRenderedMessage {
  const label = 'Invalid reminder render result';
  if (!isRecord(value)) throw new Error(`${label}: expected object`);
  assertSupportedProperties(value, ['content'], label);
  const content = value['content'];
  if (typeof content !== 'string') throw new Error(`${label}.content must be string`);
  return { content };
}

function parseHostStartResult(value: unknown, appId: string): DomindsAppHostStartResult {
  const label = `Invalid app host start result for '${appId}'`;
  if (!isRecord(value)) throw new Error(`${label}: expected object`);
  assertSupportedProperties(value, ['port', 'baseUrl', 'wsUrl'], label);
  const port = value['port'];
  if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(`${label}.port must be an integer between 1 and 65535`);
  }
  const baseUrl = value['baseUrl'];
  if (typeof baseUrl !== 'string' || baseUrl.trim() === '') {
    throw new Error(`${label}.baseUrl must be a non-empty string`);
  }
  const wsUrl = value['wsUrl'];
  if (wsUrl !== null && (typeof wsUrl !== 'string' || wsUrl.trim() === '')) {
    throw new Error(`${label}.wsUrl must be a non-empty string or null`);
  }
  return { port, baseUrl, wsUrl };
}

function normalizeToolResult(value: unknown): DomindsAppHostToolResult {
  if (!isRecord(value)) {
    throw new Error(
      'Invalid Application Component tool result: expected { output: { content, outcome, contentItems? }, ... }',
    );
  }
  assertSupportedProperties(
    value,
    ['output', 'reminderRequests', 'dialogReminderRequests'],
    'Invalid Application Component tool result',
  );
  const output = value['output'];
  if (isRecord(output)) {
    assertSupportedProperties(
      output,
      ['content', 'outcome', 'contentItems'],
      'Invalid Application Component tool result output',
    );
  }
  if (!isToolCallOutput(output)) {
    throw new Error(
      'Invalid Application Component tool result: output must be { content, outcome, contentItems? }',
    );
  }
  const normalizedOutput: DomindsAppHostToolResult['output'] = {
    content: output.content,
    outcome: output.outcome,
    ...(output.contentItems === undefined
      ? {}
      : { contentItems: output.contentItems.map(normalizeFuncResultContentItem) }),
  };
  const reminderRequestsRaw = value['reminderRequests'];
  if (reminderRequestsRaw !== undefined && !Array.isArray(reminderRequestsRaw)) {
    throw new Error('Invalid Application Component tool result: reminderRequests must be an array');
  }
  const dialogReminderRequestsRaw = value['dialogReminderRequests'];
  if (dialogReminderRequestsRaw !== undefined && !Array.isArray(dialogReminderRequestsRaw)) {
    throw new Error(
      'Invalid Application Component tool result: dialogReminderRequests must be an array',
    );
  }
  return {
    output: normalizedOutput,
    ...(reminderRequestsRaw === undefined
      ? {}
      : {
          reminderRequests: reminderRequestsRaw.map((request) => parseReminderRequest(request)),
        }),
    ...(dialogReminderRequestsRaw === undefined
      ? {}
      : {
          dialogReminderRequests: dialogReminderRequestsRaw.map((batch) =>
            parseDialogReminderRequestBatch(batch),
          ),
        }),
  };
}

function send(msg: AppsHostMessageToKernel): void {
  if (!isJsonValue(msg)) {
    throw new Error(`apps-host refused non-lossless IPC message of type '${msg.type}'`);
  }
  if (typeof process.send !== 'function') {
    throw new Error(
      `apps-host: process.send is not available; must be started with child_process.fork (type=${msg.type})`,
    );
  }
  process.send(msg);
}

type RunningApp = Readonly<{
  appId: string;
  host: DomindsAppHostInstance;
  frontend: DomindsAppHostStartResult | null;
}>;

const runningApps = new Map<string, RunningApp>();
const toolHandlers = new Map<
  string,
  Readonly<{ appId: string; fn: DomindsAppHostInstance['tools'][string] }>
>();
const reminderOwnerHandlers = new Map<
  string,
  Readonly<{ appId: string; ownerRef: string; fn: DomindsAppReminderOwnerHandler }>
>();

function buildReminderOwnerHandlerKey(appId: string, ownerRef: string): string {
  return `${appId}::${ownerRef}`;
}

function pickExportedFactory(
  mod: unknown,
  exportName: string,
  moduleAbs: string,
): CreateDomindsAppFn {
  if (isRecord(mod) && typeof mod[exportName] === 'function') {
    return mod[exportName] as unknown as CreateDomindsAppFn;
  }
  if (
    isRecord(mod) &&
    isRecord(mod['default']) &&
    typeof mod['default'][exportName] === 'function'
  ) {
    return mod['default'][exportName] as unknown as CreateDomindsAppFn;
  }
  throw new Error(`Invalid app host module exports (${moduleAbs}): missing export '${exportName}'`);
}

function validateHostInstance(host: unknown, appId: string): DomindsAppHostInstance {
  if (!isRecord(host)) throw new Error(`Invalid app host instance for '${appId}': expected object`);
  assertSupportedProperties(
    host,
    ['tools', 'reminderOwners', 'start', 'shutdown'],
    `Invalid app host instance for '${appId}'`,
  );
  const tools = host['tools'];
  if (!isRecord(tools))
    throw new Error(`Invalid app host instance for '${appId}': tools must be an object`);
  assertEnumerableDataProperties(tools, `Invalid app host instance for '${appId}': tools`);
  const start = host['start'];
  const shutdown = host['shutdown'];
  if (start !== undefined && typeof start !== 'function') {
    throw new Error(`Invalid app host instance for '${appId}': start must be a function`);
  }
  if (shutdown !== undefined && typeof shutdown !== 'function') {
    throw new Error(`Invalid app host instance for '${appId}': shutdown must be a function`);
  }
  const reminderOwners = host['reminderOwners'];
  if (reminderOwners !== undefined && !isRecord(reminderOwners)) {
    throw new Error(`Invalid app host instance for '${appId}': reminderOwners must be an object`);
  }
  const toolFns: Record<string, unknown> = tools;
  for (const [name, fn] of Object.entries(toolFns)) {
    if (typeof fn !== 'function') {
      throw new Error(
        `Invalid app host instance for '${appId}': tools['${name}'] must be a function`,
      );
    }
  }
  if (reminderOwners !== undefined) {
    assertEnumerableDataProperties(
      reminderOwners,
      `Invalid app host instance for '${appId}': reminderOwners`,
    );
    const reminderOwnerFns = reminderOwners as Record<string, unknown>;
    for (const [ownerRef, handler] of Object.entries(reminderOwnerFns)) {
      if (!isRecord(handler)) {
        throw new Error(
          `Invalid app host instance for '${appId}': reminderOwners['${ownerRef}'] must be an object`,
        );
      }
      assertSupportedProperties(
        handler,
        ['apply', 'updateReminder', 'renderReminder'],
        `Invalid app host instance for '${appId}': reminderOwners['${ownerRef}']`,
      );
      if (typeof handler['apply'] !== 'function') {
        throw new Error(
          `Invalid app host instance for '${appId}': reminderOwners['${ownerRef}'].apply must be a function`,
        );
      }
      if (typeof handler['updateReminder'] !== 'function') {
        throw new Error(
          `Invalid app host instance for '${appId}': reminderOwners['${ownerRef}'].updateReminder must be a function`,
        );
      }
      if (typeof handler['renderReminder'] !== 'function') {
        throw new Error(
          `Invalid app host instance for '${appId}': reminderOwners['${ownerRef}'].renderReminder must be a function`,
        );
      }
    }
  }
  return host as unknown as DomindsAppHostInstance;
}

function validateDeclaredHostHandlers(
  host: DomindsAppHostInstance,
  app: AppsHostKernelInitMessage['apps'][number],
): void {
  const declaredToolNames = new Set(
    (app.installJson.contributes?.toolsets ?? []).flatMap((toolset) =>
      toolset.tools.map((tool) => tool.name),
    ),
  );
  const actualToolNames = new Set(Object.keys(host.tools));
  const missingToolNames = [...declaredToolNames]
    .filter((toolName) => !actualToolNames.has(toolName))
    .sort();
  const undeclaredToolNames = [...actualToolNames]
    .filter((toolName) => !declaredToolNames.has(toolName))
    .sort();
  if (missingToolNames.length > 0 || undeclaredToolNames.length > 0) {
    throw new Error(
      `Invalid app host tool handlers for '${app.appId}': ` +
        `missing=[${missingToolNames.join(', ')}] undeclared=[${undeclaredToolNames.join(', ')}]`,
    );
  }

  const declaredOwnerRefs = new Set(
    (app.installJson.contributes?.reminderOwners ?? []).map((owner) => owner.ref),
  );
  const actualOwnerRefs = new Set(Object.keys(host.reminderOwners ?? {}));
  const missingOwnerRefs = [...declaredOwnerRefs]
    .filter((ownerRef) => !actualOwnerRefs.has(ownerRef))
    .sort();
  const undeclaredOwnerRefs = [...actualOwnerRefs]
    .filter((ownerRef) => !declaredOwnerRefs.has(ownerRef))
    .sort();
  if (missingOwnerRefs.length > 0 || undeclaredOwnerRefs.length > 0) {
    throw new Error(
      `Invalid app host reminder owner handlers for '${app.appId}': ` +
        `missing=[${missingOwnerRefs.join(', ')}] undeclared=[${undeclaredOwnerRefs.join(', ')}]`,
    );
  }
  if (!app.installJson.frontend && host.start) {
    throw new Error(
      `Invalid app host instance for '${app.appId}': start() requires a declared frontend`,
    );
  }
}

async function initOnce(msg: AppsHostKernelInitMessage): Promise<void> {
  for (const app of msg.apps) {
    if (runningApps.has(app.appId)) {
      throw new Error(`apps-host: duplicate appId in init: '${app.appId}'`);
    }
    const moduleAbs = path.resolve(
      app.installJson.package.rootAbs,
      app.installJson.host.moduleRelPath,
    );
    const mod = await dynamicImport(pathToFileURL(moduleAbs).href);
    const factory = pickExportedFactory(mod, app.installJson.host.exportName, moduleAbs);
    const appId = app.appId;
    const rtwsAppDirAbs = resolveDomindsAppRtwsDirAbs(msg.rtwsRootAbs, appId);
    const host = validateHostInstance(
      await factory({
        appId,
        rtwsRootAbs: msg.rtwsRootAbs,
        rtwsAppDirAbs,
        packageRootAbs: app.installJson.package.rootAbs,
        kernel: msg.kernel,
        log: (level, text, data) => {
          send({
            type: 'log',
            level,
            msg: text,
            appId,
            ...(data === undefined ? {} : { data }),
          });
        },
      }),
      appId,
    );
    validateDeclaredHostHandlers(host, app);

    for (const [toolName, fn] of Object.entries(host.tools)) {
      if (toolHandlers.has(toolName)) {
        const existing = toolHandlers.get(toolName);
        throw new Error(
          `apps-host: duplicate tool name '${toolName}' between Stage 0 component packages '${existing?.appId ?? 'unknown'}' and '${appId}'`,
        );
      }
      toolHandlers.set(toolName, { appId, fn });
    }
    if (host.reminderOwners) {
      for (const [ownerRef, fn] of Object.entries(host.reminderOwners)) {
        const handlerKey = buildReminderOwnerHandlerKey(appId, ownerRef);
        if (reminderOwnerHandlers.has(handlerKey)) {
          throw new Error(
            `apps-host: duplicate reminder owner '${ownerRef}' for Stage 0 component package '${appId}'`,
          );
        }
        reminderOwnerHandlers.set(handlerKey, { appId, ownerRef, fn });
      }
    }
    let frontend: DomindsAppHostStartResult | null = null;
    if (app.installJson.frontend) {
      if (!host.start) {
        throw new Error(
          `apps-host: Stage 0 component package '${appId}' declares frontend but host instance has no start()`,
        );
      }
      frontend = parseHostStartResult(
        await host.start({
          runtimePort: app.runtimePort,
          frontend: app.installJson.frontend,
        }),
        appId,
      );
    }

    runningApps.set(appId, { appId, host, frontend });
    send({
      type: 'log',
      level: 'info',
      msg: frontend
        ? `App started (frontend port=${frontend.port} baseUrl=${frontend.baseUrl})`
        : `App loaded`,
      appId,
    });
  }

  send({
    type: 'ready',
    apps: [...runningApps.values()].map((a) => ({
      appId: a.appId,
      frontend: a.frontend
        ? { port: a.frontend.port, baseUrl: a.frontend.baseUrl, wsUrl: a.frontend.wsUrl }
        : null,
    })),
  });
}

async function shutdownAll(): Promise<void> {
  for (const app of runningApps.values()) {
    try {
      if (app.host.shutdown) await app.host.shutdown();
    } catch (err: unknown) {
      send({
        type: 'log',
        level: 'error',
        msg: `App shutdown failed: ${err instanceof Error ? err.message : String(err)}`,
        appId: app.appId,
      });
    }
  }
}

let initialized = false;
process.on('message', (raw: unknown) => {
  (async () => {
    const msg = parseAppsHostMessageFromKernel(raw);
    switch (msg.type) {
      case 'init':
        if (initialized) throw new Error('apps-host: init called more than once');
        initialized = true;
        await initOnce(msg);
        return;
      case 'tool_call': {
        const found = toolHandlers.get(msg.toolName);
        if (!found) {
          send({
            type: 'tool_result',
            callId: msg.callId,
            ok: false,
            errorText: `Unknown tool: ${msg.toolName}`,
          });
          return;
        }
        try {
          const result = normalizeToolResult(await found.fn(msg.args, msg.ctx));
          send({
            type: 'tool_result',
            callId: msg.callId,
            ok: true,
            output: result.output,
            ...(result.reminderRequests === undefined
              ? {}
              : { reminderRequests: result.reminderRequests }),
            ...(result.dialogReminderRequests === undefined
              ? {}
              : { dialogReminderRequests: result.dialogReminderRequests }),
          });
        } catch (err: unknown) {
          send({
            type: 'tool_result',
            callId: msg.callId,
            ok: false,
            errorText: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }
      case 'reminder_apply': {
        const found = reminderOwnerHandlers.get(
          buildReminderOwnerHandlerKey(msg.appId, msg.ownerRef),
        );
        if (!found) {
          send({
            type: 'reminder_apply_result',
            callId: msg.callId,
            ok: false,
            errorText: `Unknown reminder owner: ${msg.appId}/${msg.ownerRef}`,
          });
          return;
        }
        try {
          const result = parseReminderApplyResult(await found.fn.apply(msg.request, msg.ctx));
          send({ type: 'reminder_apply_result', callId: msg.callId, ok: true, result });
        } catch (err: unknown) {
          send({
            type: 'reminder_apply_result',
            callId: msg.callId,
            ok: false,
            errorText: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }
      case 'reminder_update': {
        const found = reminderOwnerHandlers.get(
          buildReminderOwnerHandlerKey(msg.appId, msg.ownerRef),
        );
        if (!found) {
          send({
            type: 'reminder_update_result',
            callId: msg.callId,
            ok: false,
            errorText: `Unknown reminder owner: ${msg.appId}/${msg.ownerRef}`,
          });
          return;
        }
        try {
          const result = parseReminderUpdateResult(await found.fn.updateReminder(msg.ctx));
          send({ type: 'reminder_update_result', callId: msg.callId, ok: true, result });
        } catch (err: unknown) {
          send({
            type: 'reminder_update_result',
            callId: msg.callId,
            ok: false,
            errorText: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }
      case 'reminder_render': {
        const found = reminderOwnerHandlers.get(
          buildReminderOwnerHandlerKey(msg.appId, msg.ownerRef),
        );
        if (!found) {
          send({
            type: 'reminder_render_result',
            callId: msg.callId,
            ok: false,
            errorText: `Unknown reminder owner: ${msg.appId}/${msg.ownerRef}`,
          });
          return;
        }
        try {
          const message = parseReminderRenderedMessage(await found.fn.renderReminder(msg.ctx));
          send({ type: 'reminder_render_result', callId: msg.callId, ok: true, message });
        } catch (err: unknown) {
          send({
            type: 'reminder_render_result',
            callId: msg.callId,
            ok: false,
            errorText: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }
      case 'shutdown':
        await shutdownAll();
        process.exit(0);
        return;
      default: {
        const _exhaustive: never = msg;
        throw new Error(
          `apps-host: unreachable msg type '${(_exhaustive as unknown as { type: string }).type}'`,
        );
      }
    }
  })().catch((err: unknown) => {
    const errorText = err instanceof Error ? err.stack || err.message : String(err);
    try {
      send({
        type: 'log',
        level: 'error',
        msg: `apps-host fatal error: ${errorText}`,
        appId: null,
      });
    } catch (sendError: unknown) {
      log.error(
        'Failed to emit apps-host fatal error over IPC',
        sendError instanceof Error ? sendError : new Error(String(sendError)),
      );
    }
    log.error('apps-host fatal error', err instanceof Error ? err : new Error(String(err)));
    void shutdownAll().finally(() => process.exit(1));
  });
});

process.on('SIGTERM', () => {
  void shutdownAll().finally(() => process.exit(0));
});
