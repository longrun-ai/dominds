import { createHash } from 'crypto';
import fs from 'fs/promises';
import path from 'path';

import { Dialog, DialogID, RootDialog, SubDialog } from '../dialog';
import { globalDialogRegistry } from '../dialog-global-registry';
import { ensureDialogLoaded, getOrRestoreRootDialog } from '../dialog-instance-registry';
import { createLogger } from '../log';
import type { I18nText } from '../shared/types/i18n';
import type { Tool } from '../tool';
import {
  applyAppReminderRequests,
  ensureAppReminderOwnersRegistered,
  unregisterAppReminderOwnersForApps,
} from '../tools/app-reminders';
import {
  getTool,
  getToolset,
  registerTool,
  registerToolset,
  setToolsetMeta,
  unregisterTool,
  unregisterToolset,
} from '../tools/registry';
import type { DomindsAppDialogReminderRequestBatch, DomindsAppDialogTargetRef } from './app-json';

import { startAppsHost, type AppsHostClient, type EnabledAppForHost } from '../apps-host/client';
import { registerAppDialogRunControl, unregisterAppDialogRunControl } from './dialog-run-controls';
import { loadEnabledAppsSnapshot } from './enabled-apps';
import { reconcileAppsResolutionIssuesToProblems } from './problems';

const log = createLogger('apps-runtime');

let appsHostClient: AppsHostClient | null = null;
let hostedAppsSignature: string | null = null;
let appsRuntimeConfig: Readonly<{
  rtwsRootAbs: string;
  kernel: Readonly<{ host: string; port: number }>;
}> | null = null;
let refreshQueue: Promise<void> = Promise.resolve();

type RegisteredAppArtifacts = Readonly<{
  signature: string;
  toolNames: ReadonlyArray<string>;
  toolsetIds: ReadonlyArray<string>;
  dialogRunControlIds: ReadonlyArray<string>;
}>;

const registeredAppArtifactsById = new Map<string, RegisteredAppArtifacts>();

function resolveRootDialogFor(dlg: Dialog): RootDialog {
  if (dlg instanceof RootDialog) {
    return dlg;
  }
  if (dlg instanceof SubDialog) {
    return dlg.rootDialog;
  }
  throw new Error(`Unsupported dialog type for app runtime: ${dlg.constructor.name}`);
}

async function ensureRootDialogLoaded(rootId: string): Promise<RootDialog | undefined> {
  const existing = globalDialogRegistry.get(rootId);
  if (existing) {
    await existing.loadSubdialogRegistry();
    await existing.loadPendingSubdialogsFromPersistence();
    return existing;
  }
  return await getOrRestoreRootDialog(rootId, 'running');
}

async function ensureDialogLoadedBySelfId(
  rootDialog: RootDialog,
  dialogSelfId: string,
): Promise<Dialog | undefined> {
  if (dialogSelfId === rootDialog.id.rootId) {
    return rootDialog;
  }
  const existing = rootDialog.lookupDialog(dialogSelfId);
  if (existing) {
    return existing;
  }
  return await ensureDialogLoaded(
    rootDialog,
    new DialogID(dialogSelfId, rootDialog.id.rootId),
    'running',
  );
}

function describeTarget(target: DomindsAppDialogTargetRef): string {
  if ('dialogId' in target) {
    return `dialogId=${target.dialogId}`;
  }
  const parts = [`agentId=${target.agentId}`];
  if (target.rootDialogId) {
    parts.push(`rootDialogId=${target.rootDialogId}`);
  }
  if (target.sessionSlug) {
    parts.push(`sessionSlug=${target.sessionSlug}`);
  }
  return parts.join(' ');
}

async function resolveTargetDialog(
  sourceDlg: Dialog,
  target: DomindsAppDialogTargetRef,
): Promise<Dialog> {
  const sourceRoot = resolveRootDialogFor(sourceDlg);
  if ('dialogId' in target) {
    const matches: Dialog[] = [];
    const seenDialogKeys = new Set<string>();
    const pushMatch = (dialog: Dialog | undefined): void => {
      if (!dialog) return;
      const key = dialog.id.valueOf();
      if (seenDialogKeys.has(key)) return;
      seenDialogKeys.add(key);
      matches.push(dialog);
    };

    pushMatch(await ensureDialogLoadedBySelfId(sourceRoot, target.dialogId));
    for (const loadedRoot of globalDialogRegistry.getAll()) {
      pushMatch(await ensureDialogLoadedBySelfId(loadedRoot, target.dialogId));
    }
    if (target.dialogId !== sourceRoot.id.rootId) {
      pushMatch(await ensureRootDialogLoaded(target.dialogId));
    }

    if (matches.length === 1) {
      return matches[0];
    }
    if (matches.length === 0) {
      throw new Error(`dialog reminder target not found (${describeTarget(target)})`);
    }
    throw new Error(`dialog reminder target is ambiguous (${describeTarget(target)})`);
  }

  const targetRootId = target.rootDialogId ?? sourceRoot.id.rootId;
  const targetRoot =
    targetRootId === sourceRoot.id.rootId ? sourceRoot : await ensureRootDialogLoaded(targetRootId);
  if (!targetRoot) {
    throw new Error(`dialog reminder target root not found (${describeTarget(target)})`);
  }

  await targetRoot.loadSubdialogRegistry();
  await targetRoot.loadPendingSubdialogsFromPersistence();

  if (target.sessionSlug) {
    const subdialog = targetRoot.lookupSubdialog(target.agentId, target.sessionSlug);
    if (!subdialog) {
      throw new Error(`dialog reminder target not found (${describeTarget(target)})`);
    }
    return subdialog;
  }

  const matches = targetRoot.getAllDialogs().filter((dialog) => dialog.agentId === target.agentId);
  if (matches.length === 1) {
    return matches[0];
  }
  if (matches.length === 0) {
    throw new Error(`dialog reminder target not found (${describeTarget(target)})`);
  }
  throw new Error(`dialog reminder target is ambiguous (${describeTarget(target)})`);
}

async function applyDialogReminderRequestBatches(
  sourceDlg: Dialog,
  appId: string,
  dialogReminderRequests: ReadonlyArray<DomindsAppDialogReminderRequestBatch>,
): Promise<void> {
  for (const batch of dialogReminderRequests) {
    if (batch.reminderRequests.length === 0) {
      continue;
    }
    const targetDlg = await resolveTargetDialog(sourceDlg, batch.target);
    await applyAppReminderRequests(targetDlg, {
      appId,
      reminderRequests: batch.reminderRequests,
      resolveHostClient: getAppsHostClient,
    });
  }
}

export function getAppsHostClient(): AppsHostClient {
  if (!appsHostClient) {
    throw new Error('Apps host is not initialized');
  }
  return appsHostClient;
}

async function stopAppsHost(): Promise<void> {
  const client = appsHostClient;
  if (!client) return;
  appsHostClient = null;
  hostedAppsSignature = null;
  await client.shutdown();
}

export async function shutdownAppsRuntime(): Promise<void> {
  await stopAppsHost();
}

function ensureNoDuplicateTool(toolName: string, appId: string): void {
  const existing = getTool(toolName);
  if (existing) {
    throw new Error(`App '${appId}' attempted to register duplicate tool '${toolName}'`);
  }
}

function ensureNoDuplicateToolset(toolsetId: string, appId: string): void {
  const existing = getToolset(toolsetId);
  if (existing) {
    throw new Error(`App '${appId}' attempted to register duplicate toolset '${toolsetId}'`);
  }
}

function registerAppToolset(params: {
  appId: string;
  toolsetId: string;
  tools: Tool[];
  descriptionI18n?: I18nText;
}): void {
  ensureNoDuplicateToolset(params.toolsetId, params.appId);
  for (const t of params.tools) ensureNoDuplicateTool(t.name, params.appId);
  for (const t of params.tools) registerTool(t);
  registerToolset(params.toolsetId, params.tools);
  setToolsetMeta(params.toolsetId, { source: 'app', descriptionI18n: params.descriptionI18n });
}

function computeAppSignature(app: EnabledAppForHost): string {
  return JSON.stringify({
    appId: app.appId,
    runtimePort: app.runtimePort,
    installJson: app.installJson,
    hostSourceVersion: app.hostSourceVersion,
  });
}

function computeHostedAppsSignature(enabledApps: ReadonlyArray<EnabledAppForHost>): string {
  return JSON.stringify(
    enabledApps.map((app) => ({
      appId: app.appId,
      runtimePort: app.runtimePort,
      installJson: app.installJson,
      hostSourceVersion: app.hostSourceVersion,
    })),
  );
}

async function computeHostSourceVersion(params: {
  source: Readonly<{ kind: 'local'; pathAbs: string } | { kind: 'npx'; spec: string }>;
  installJson: EnabledAppForHost['installJson'];
}): Promise<string | null> {
  if (params.source.kind !== 'local') {
    return null;
  }
  const host = params.installJson.host;
  if (host.kind !== 'node_module') {
    return null;
  }
  const moduleAbs = path.resolve(params.source.pathAbs, host.moduleRelPath);
  try {
    const content = await fs.readFile(moduleAbs);
    const digest = createHash('sha256').update(content).digest('hex');
    return `sha256:${digest}`;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return `unreadable:${moduleAbs}:${message}`;
  }
}

function unregisterRegisteredAppArtifacts(appId: string): void {
  const registered = registeredAppArtifactsById.get(appId);
  if (!registered) {
    unregisterAppReminderOwnersForApps({ appIds: [appId] });
    return;
  }
  for (const toolName of registered.toolNames) {
    unregisterTool(toolName);
  }
  for (const toolsetId of registered.toolsetIds) {
    unregisterToolset(toolsetId);
  }
  for (const controlId of registered.dialogRunControlIds) {
    unregisterAppDialogRunControl(controlId);
  }
  unregisterAppReminderOwnersForApps({ appIds: [appId] });
  registeredAppArtifactsById.delete(appId);
}

async function ensureAppsHostReadyForToolCalls(): Promise<AppsHostClient> {
  const config = appsRuntimeConfig;
  if (!config && !appsHostClient) {
    throw new Error(
      'Apps host is unavailable in the current runtime; start an interactive Dominds runtime first',
    );
  }
  if (config) {
    await registerEnabledAppsToolProxies({ rtwsRootAbs: config.rtwsRootAbs });
  }
  return getAppsHostClient();
}

function registerAppArtifacts(app: EnabledAppForHost): void {
  const toolNames: string[] = [];
  const toolsetIds: string[] = [];
  const dialogRunControlIds: string[] = [];
  const toolsets = app.installJson.contributes?.toolsets ?? [];

  for (const ts of toolsets) {
    const tools: Tool[] = ts.tools.map((t) => ({
      type: 'func',
      name: t.name,
      description: t.description,
      descriptionI18n: t.descriptionI18n,
      parameters: t.parameters,
      call: async (dlg, caller, args) => {
        const host = await ensureAppsHostReadyForToolCalls();
        const result = await host.callTool(t.name, args, {
          dialogId: dlg.id.selfId,
          rootDialogId: dlg.id.rootId,
          agentId: dlg.agentId,
          sessionSlug: dlg instanceof SubDialog ? dlg.sessionSlug : undefined,
          callerId: caller.id,
        });
        if (Array.isArray(result.reminderRequests) && result.reminderRequests.length > 0) {
          await applyAppReminderRequests(dlg, {
            appId: app.appId,
            reminderRequests: result.reminderRequests,
            resolveHostClient: getAppsHostClient,
          });
        }
        if (
          Array.isArray(result.dialogReminderRequests) &&
          result.dialogReminderRequests.length > 0
        ) {
          await applyDialogReminderRequestBatches(dlg, app.appId, result.dialogReminderRequests);
        }
        return result.output;
      },
    }));
    registerAppToolset({
      appId: app.appId,
      toolsetId: ts.id,
      tools,
      descriptionI18n: ts.descriptionI18n,
    });
    toolsetIds.push(ts.id);
    toolNames.push(...tools.map((tool) => tool.name));
  }

  const controls = app.installJson.contributes?.dialogRunControls ?? [];
  for (const control of controls) {
    registerAppDialogRunControl({
      id: control.id,
      appId: app.appId,
      descriptionI18n: control.descriptionI18n,
    });
    dialogRunControlIds.push(control.id);
  }

  ensureAppReminderOwnersRegistered({
    enabledApps: [app],
    resolveHostClient: getAppsHostClient,
  });

  registeredAppArtifactsById.set(app.appId, {
    signature: computeAppSignature(app),
    toolNames,
    toolsetIds,
    dialogRunControlIds,
  });
}

function syncRegisteredAppArtifacts(params: {
  enabledApps: ReadonlyArray<EnabledAppForHost>;
}): void {
  const nextAppIds = new Set(params.enabledApps.map((app) => app.appId));
  for (const appId of registeredAppArtifactsById.keys()) {
    if (!nextAppIds.has(appId)) {
      unregisterRegisteredAppArtifacts(appId);
    }
  }
  for (const app of params.enabledApps) {
    const nextSignature = computeAppSignature(app);
    const existing = registeredAppArtifactsById.get(app.appId);
    if (existing?.signature === nextSignature) {
      continue;
    }
    if (existing) {
      unregisterRegisteredAppArtifacts(app.appId);
    }
    registerAppArtifacts(app);
  }
}

async function syncAppsHostToEnabledApps(params: {
  enabledApps: ReadonlyArray<EnabledAppForHost>;
}): Promise<void> {
  const config = appsRuntimeConfig;
  if (!config) {
    return;
  }

  const nextSignature = computeHostedAppsSignature(params.enabledApps);
  if (params.enabledApps.length === 0) {
    await stopAppsHost();
    return;
  }
  if (appsHostClient && hostedAppsSignature === nextSignature) {
    return;
  }

  await stopAppsHost();
  log.info(`Starting apps-host (${params.enabledApps.length} enabled apps)`);
  const { client } = await startAppsHost({
    rtwsRootAbs: config.rtwsRootAbs,
    kernel: config.kernel,
    apps: params.enabledApps,
  });
  appsHostClient = client;
  hostedAppsSignature = nextSignature;
}

async function refreshEnabledAppsRuntimeNow(params: {
  rtwsRootAbs: string;
  ensureHost: boolean;
}): Promise<void> {
  const snapshot = await loadEnabledAppsSnapshot({ rtwsRootAbs: params.rtwsRootAbs });
  reconcileAppsResolutionIssuesToProblems({ issues: snapshot.issues });
  const enabledApps: EnabledAppForHost[] = await Promise.all(
    snapshot.enabledApps.map(async (app) => ({
      appId: app.id,
      runtimePort: app.runtimePort,
      installJson: app.installJson,
      hostSourceVersion: await computeHostSourceVersion({
        source: app.source,
        installJson: app.installJson,
      }),
    })),
  );

  syncRegisteredAppArtifacts({ enabledApps });
  if (params.ensureHost) {
    await syncAppsHostToEnabledApps({ enabledApps });
  }
}

export async function registerEnabledAppsToolProxies(params: {
  rtwsRootAbs: string;
}): Promise<void> {
  const run = refreshQueue.then(() =>
    refreshEnabledAppsRuntimeNow({
      rtwsRootAbs: params.rtwsRootAbs,
      ensureHost: appsRuntimeConfig !== null,
    }),
  );
  refreshQueue = run.catch(() => undefined);
  await run;
}

export async function initAppsRuntime(params: {
  rtwsRootAbs: string;
  kernel: Readonly<{ host: string; port: number }>;
}): Promise<void> {
  appsRuntimeConfig = {
    rtwsRootAbs: params.rtwsRootAbs,
    kernel: params.kernel,
  };
  const run = refreshQueue.then(() =>
    refreshEnabledAppsRuntimeNow({
      rtwsRootAbs: params.rtwsRootAbs,
      ensureHost: true,
    }),
  );
  refreshQueue = run.catch(() => undefined);
  await run;
}
