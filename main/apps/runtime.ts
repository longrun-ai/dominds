import { createLogger } from '../log';
import type { I18nText } from '../shared/types/i18n';
import type { Tool } from '../tool';
import {
  getTool,
  getToolset,
  registerTool,
  registerToolset,
  setToolsetMeta,
} from '../tools/registry';

import { startAppsHost, type AppsHostClient, type EnabledAppForHost } from '../apps-host/client';
import { registerAppDialogRunControl } from './dialog-run-controls';
import { loadEnabledAppsSnapshot } from './enabled-apps';
import { loadInstalledAppsFile, setAppRuntimePort, writeInstalledAppsFile } from './installed-file';

const log = createLogger('apps-runtime');

let appsHostClient: AppsHostClient | null = null;
const proxyRegisteredAppIds = new Set<string>();

export function getAppsHostClient(): AppsHostClient {
  if (!appsHostClient) {
    throw new Error('Apps host is not initialized');
  }
  return appsHostClient;
}

export async function shutdownAppsRuntime(): Promise<void> {
  const client = appsHostClient;
  if (!client) return;
  appsHostClient = null;
  await client.shutdown();
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

function registerAppProxyToolsForEnabledApps(params: {
  enabledApps: ReadonlyArray<EnabledAppForHost>;
}): void {
  for (const app of params.enabledApps) {
    if (proxyRegisteredAppIds.has(app.appId)) continue;
    const toolsets = app.installJson.contributes?.toolsets ?? [];
    for (const ts of toolsets) {
      const tools: Tool[] = ts.tools.map((t) => ({
        type: 'func',
        name: t.name,
        description: t.description,
        descriptionI18n: t.descriptionI18n,
        parameters: t.parameters,
        call: async (dlg, caller, args) => {
          const host = getAppsHostClient();
          return await host.callTool(t.name, args, {
            dialogId: dlg.id.selfId,
            callerId: caller.id,
          });
        },
      }));
      registerAppToolset({
        appId: app.appId,
        toolsetId: ts.id,
        tools,
        descriptionI18n: ts.descriptionI18n,
      });
    }
    proxyRegisteredAppIds.add(app.appId);
  }
}

function registerAppDialogRunControlsForEnabledApps(params: {
  enabledApps: ReadonlyArray<EnabledAppForHost>;
}): void {
  for (const app of params.enabledApps) {
    const controls = app.installJson.contributes?.dialogRunControls ?? [];
    for (const control of controls) {
      registerAppDialogRunControl({
        id: control.id,
        appId: app.appId,
        descriptionI18n: control.descriptionI18n,
      });
    }
  }
}

export async function registerEnabledAppsToolProxies(params: {
  rtwsRootAbs: string;
}): Promise<void> {
  const snapshot = await loadEnabledAppsSnapshot({ rtwsRootAbs: params.rtwsRootAbs });
  const enabledApps: EnabledAppForHost[] = snapshot.enabledApps.map((a) => ({
    appId: a.id,
    runtimePort: a.runtimePort,
    installJson: a.installJson,
  }));
  if (enabledApps.length === 0) return;
  registerAppProxyToolsForEnabledApps({ enabledApps });
}

export async function initAppsRuntime(params: {
  rtwsRootAbs: string;
  kernel: Readonly<{ host: string; port: number }>;
}): Promise<void> {
  if (appsHostClient) {
    throw new Error('Apps runtime already initialized');
  }

  const snapshot = await loadEnabledAppsSnapshot({ rtwsRootAbs: params.rtwsRootAbs });
  const enabledApps: EnabledAppForHost[] = snapshot.enabledApps.map((a) => ({
    appId: a.id,
    runtimePort: a.runtimePort,
    installJson: a.installJson,
  }));

  if (enabledApps.length === 0) {
    log.info('No enabled apps');
    return;
  }

  // Register proxy tools first (fail fast on collisions) so team loading/validation can see toolsets.
  registerAppProxyToolsForEnabledApps({ enabledApps });
  // Register dialog run controls before websocket handlers start processing user drives.
  registerAppDialogRunControlsForEnabledApps({ enabledApps });

  log.info(`Starting apps-host (${enabledApps.length} enabled apps)`);
  const started = await startAppsHost({
    rtwsRootAbs: params.rtwsRootAbs,
    kernel: params.kernel,
    apps: enabledApps,
  });
  appsHostClient = started.client;

  // Persist actual bound ports for enabled apps (especially when runtimePort=0 for ephemeral ports).
  const loaded = await loadInstalledAppsFile({ rtwsRootAbs: params.rtwsRootAbs });
  if (loaded.kind === 'error') {
    throw new Error(
      `Failed to update installed apps runtime ports: ${loaded.errorText} (${loaded.filePathAbs})`,
    );
  }
  let nextFile = loaded.file;
  for (const a of started.ready.apps) {
    if (!a.frontend) continue;
    nextFile = setAppRuntimePort({ existing: nextFile, appId: a.appId, port: a.frontend.port });
  }
  await writeInstalledAppsFile({ rtwsRootAbs: params.rtwsRootAbs, file: nextFile });
}
