import fs from 'fs/promises';
import path from 'path';
import YAML from 'yaml';

import { parseDomindsAppInstallJson } from './app-json';

import type { DomindsAppInstallJsonV1 } from './app-json';

export type AppsResolutionSchemaVersion = 1;

export type AppsResolutionStrategyOrderItem = 'local' | 'npx';

/**
 * How the kernel should resolve an app when it isn't present in `apps[]` overlay.
 *
 * Note: `apps[]` remains the *overlay* and also the place to store `enabled` and `assignedPort`.
 */
export type AppsResolutionStrategy = Readonly<{
  order?: ReadonlyArray<AppsResolutionStrategyOrderItem>;
  /**
   * Roots (absolute or rtws-relative) where local apps can be found as `<root>/<appId>/`.
   *
   * Default: ['dominds-apps'] (rtws-relative).
   */
  localRoots?: ReadonlyArray<string>;
}>;

export const DEFAULT_APPS_RESOLUTION_STRATEGY: AppsResolutionStrategy = {
  order: ['local'],
  localRoots: ['dominds-apps'],
};

export type AppsResolutionSource =
  | Readonly<{
      kind: 'npx';
      spec: string;
    }>
  | Readonly<{
      kind: 'local';
      pathAbs: string;
    }>;

export type AppsResolutionEntry = Readonly<{
  id: string;
  /**
   * The effective enabled state.
   *
   * - This may be set to false by dependency propagation.
   * - This is distinct from `userEnabled` (user intent).
   */
  enabled: boolean;
  /**
   * The user intent for enablement.
   *
   * - CLI enable/disable updates this field.
   * - Dependency propagation must not change this field.
   */
  userEnabled: boolean;
  source: AppsResolutionSource;
  assignedPort: number | null;
  installJson: DomindsAppInstallJsonV1;
}>;

export type AppsResolutionFile = Readonly<{
  schemaVersion: AppsResolutionSchemaVersion;
  resolutionStrategy?: AppsResolutionStrategy;
  apps: ReadonlyArray<AppsResolutionEntry>;
}>;

export const APPS_RESOLUTION_REL_PATH = path.join('.apps', 'resolution.yaml');

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function asBool(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}

function asNullableNumber(v: unknown): number | null {
  if (v === null) return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return null;
}

function parseResolutionStrategy(
  v: unknown,
  at: string,
): { ok: true; strategy: AppsResolutionStrategy } | { ok: false; errorText: string } {
  if (!isRecord(v)) return { ok: false, errorText: `Invalid ${at}: expected object` };

  const keys = Object.keys(v);
  for (const k of keys) {
    if (k !== 'order' && k !== 'localRoots') {
      return { ok: false, errorText: `Invalid ${at}: unknown key '${k}'` };
    }
  }

  const orderRaw = v['order'];
  const order = (() => {
    if (orderRaw === undefined) return undefined;
    if (!Array.isArray(orderRaw)) {
      return { ok: false as const, errorText: `Invalid ${at}.order: expected array` };
    }
    const out: AppsResolutionStrategyOrderItem[] = [];
    for (let i = 0; i < orderRaw.length; i += 1) {
      const item = orderRaw[i];
      if (item !== 'local' && item !== 'npx') {
        return {
          ok: false as const,
          errorText: `Invalid ${at}.order[${i}]: expected 'local'|'npx'`,
        };
      }
      out.push(item);
    }
    if (out.length === 0) {
      return { ok: false as const, errorText: `Invalid ${at}.order: must not be empty` };
    }
    return { ok: true as const, value: out };
  })();
  if (order && !order.ok) return order;

  const localRootsRaw = v['localRoots'];
  const localRoots = (() => {
    if (localRootsRaw === undefined) return undefined;
    if (!Array.isArray(localRootsRaw)) {
      return { ok: false as const, errorText: `Invalid ${at}.localRoots: expected array` };
    }
    const out: string[] = [];
    for (let i = 0; i < localRootsRaw.length; i += 1) {
      const item = localRootsRaw[i];
      if (typeof item !== 'string' || item.trim() === '') {
        return {
          ok: false as const,
          errorText: `Invalid ${at}.localRoots[${i}]: expected non-empty string`,
        };
      }
      out.push(item.trim());
    }
    if (out.length === 0) {
      return { ok: false as const, errorText: `Invalid ${at}.localRoots: must not be empty` };
    }
    return { ok: true as const, value: out };
  })();
  if (localRoots && !localRoots.ok) return localRoots;

  return {
    ok: true,
    strategy: {
      order: order ? order.value : undefined,
      localRoots: localRoots ? localRoots.value : undefined,
    },
  };
}

function parseSource(
  v: unknown,
  at: string,
): { ok: true; source: AppsResolutionSource } | { ok: false; errorText: string } {
  if (!isRecord(v)) return { ok: false, errorText: `Invalid ${at}: expected object` };
  const kind = asString(v['kind']);
  if (kind !== 'npx' && kind !== 'local') {
    return { ok: false, errorText: `Invalid ${at}.kind: expected 'npx'|'local'` };
  }
  if (kind === 'npx') {
    const spec = asString(v['spec']);
    if (!spec || spec.trim() === '')
      return { ok: false, errorText: `Invalid ${at}.spec: required` };
    return { ok: true, source: { kind, spec } };
  }
  const pathAbs = asString(v['pathAbs']);
  if (!pathAbs || pathAbs.trim() === '')
    return { ok: false, errorText: `Invalid ${at}.pathAbs: required` };
  return { ok: true, source: { kind, pathAbs } };
}

function parseEntry(
  v: unknown,
  at: string,
): { ok: true; entry: AppsResolutionEntry } | { ok: false; errorText: string } {
  if (!isRecord(v)) return { ok: false, errorText: `Invalid ${at}: expected object` };
  const id = asString(v['id']);
  if (!id || id.trim() === '') return { ok: false, errorText: `Invalid ${at}.id: required` };
  const enabled = asBool(v['enabled']);
  if (enabled === null) return { ok: false, errorText: `Invalid ${at}.enabled: boolean required` };

  const userEnabledRaw = v['userEnabled'];
  const userEnabled = userEnabledRaw === undefined ? enabled : asBool(userEnabledRaw);
  if (userEnabled === null) {
    return { ok: false, errorText: `Invalid ${at}.userEnabled: expected boolean` };
  }

  const assignedPortRaw = v['assignedPort'] ?? null;
  const assignedPort = asNullableNumber(assignedPortRaw);
  if (assignedPort === null) {
    if (assignedPortRaw !== null) {
      return { ok: false, errorText: `Invalid ${at}.assignedPort: expected number|null` };
    }
  } else {
    if (!Number.isInteger(assignedPort) || assignedPort <= 0) {
      return { ok: false, errorText: `Invalid ${at}.assignedPort: expected positive integer|null` };
    }
  }

  const sourceParsed = parseSource(v['source'], `${at}.source`);
  if (!sourceParsed.ok) return sourceParsed;

  const installJsonRaw = v['installJson'];
  const installJsonParsed = parseDomindsAppInstallJson(installJsonRaw);
  if (!installJsonParsed.ok) {
    return { ok: false, errorText: `Invalid ${at}.installJson: ${installJsonParsed.errorText}` };
  }

  return {
    ok: true,
    entry: {
      id,
      enabled,
      userEnabled,
      source: sourceParsed.source,
      assignedPort,
      installJson: installJsonParsed.json,
    },
  };
}

export async function loadAppsResolutionFile(params: {
  rtwsRootAbs: string;
}): Promise<
  | Readonly<{ kind: 'ok'; file: AppsResolutionFile; filePathAbs: string }>
  | Readonly<{ kind: 'error'; errorText: string; filePathAbs: string }>
> {
  const filePathAbs = path.resolve(params.rtwsRootAbs, APPS_RESOLUTION_REL_PATH);
  let raw: string;
  try {
    raw = await fs.readFile(filePathAbs, 'utf-8');
  } catch (err: unknown) {
    const isEnoent =
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code?: unknown }).code === 'ENOENT';
    if (isEnoent) {
      return { kind: 'ok', filePathAbs, file: { schemaVersion: 1, apps: [] } };
    }
    return {
      kind: 'error',
      filePathAbs,
      errorText: err instanceof Error ? err.message : String(err),
    };
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(raw);
  } catch (err: unknown) {
    return {
      kind: 'error',
      filePathAbs,
      errorText: `Failed to parse YAML: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!isRecord(parsed)) {
    return { kind: 'error', filePathAbs, errorText: 'Invalid resolution.yaml: expected object' };
  }
  const schemaVersion = parsed['schemaVersion'];
  if (schemaVersion !== 1) {
    return {
      kind: 'error',
      filePathAbs,
      errorText: `Unsupported schemaVersion: ${String(schemaVersion)}`,
    };
  }
  const appsRaw = parsed['apps'];
  if (!Array.isArray(appsRaw)) {
    return {
      kind: 'error',
      filePathAbs,
      errorText: 'Invalid resolution.yaml: apps must be an array',
    };
  }
  const apps: AppsResolutionEntry[] = [];
  for (let i = 0; i < appsRaw.length; i += 1) {
    const e = parseEntry(appsRaw[i], `apps[${i}]`);
    if (!e.ok) return { kind: 'error', filePathAbs, errorText: e.errorText };
    apps.push(e.entry);
  }

  const strategyRaw = parsed['resolutionStrategy'];
  const resolutionStrategy = (() => {
    if (strategyRaw === undefined) return undefined;
    const parsedStrategy = parseResolutionStrategy(strategyRaw, 'resolutionStrategy');
    if (!parsedStrategy.ok) return parsedStrategy;
    return { ok: true as const, value: parsedStrategy.strategy };
  })();
  if (resolutionStrategy && !resolutionStrategy.ok) {
    return { kind: 'error', filePathAbs, errorText: resolutionStrategy.errorText };
  }

  const file: AppsResolutionFile = resolutionStrategy
    ? {
        schemaVersion: 1,
        resolutionStrategy: resolutionStrategy.value,
        apps,
      }
    : { schemaVersion: 1, apps };

  return { kind: 'ok', filePathAbs, file };
}

export async function writeAppsResolutionFile(params: {
  rtwsRootAbs: string;
  file: AppsResolutionFile;
}): Promise<void> {
  const dirAbs = path.resolve(params.rtwsRootAbs, '.apps');
  await fs.mkdir(dirAbs, { recursive: true });
  const filePathAbs = path.resolve(params.rtwsRootAbs, APPS_RESOLUTION_REL_PATH);
  const yamlText = YAML.stringify(params.file);
  await fs.writeFile(filePathAbs, yamlText, 'utf-8');
}

export async function writeAppsResolutionFileIfChanged(params: {
  rtwsRootAbs: string;
  file: AppsResolutionFile;
}): Promise<void> {
  const dirAbs = path.resolve(params.rtwsRootAbs, '.apps');
  await fs.mkdir(dirAbs, { recursive: true });
  const filePathAbs = path.resolve(params.rtwsRootAbs, APPS_RESOLUTION_REL_PATH);
  const yamlText = YAML.stringify(params.file);
  try {
    const prev = await fs.readFile(filePathAbs, 'utf-8');
    if (prev === yamlText) return;
  } catch (err: unknown) {
    const isEnoent =
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code?: unknown }).code === 'ENOENT';
    if (!isEnoent) throw err;
  }
  await fs.writeFile(filePathAbs, yamlText, 'utf-8');
}

export function findResolvedApp(
  file: AppsResolutionFile,
  appId: string,
): AppsResolutionEntry | null {
  const found = file.apps.find((a) => a.id === appId);
  return found ?? null;
}

export function upsertResolvedApp(params: {
  existing: AppsResolutionFile;
  next: AppsResolutionEntry;
}): AppsResolutionFile {
  const apps = [...params.existing.apps];
  const idx = apps.findIndex((a) => a.id === params.next.id);
  if (idx >= 0) apps[idx] = params.next;
  else apps.push(params.next);
  const resolutionStrategy = params.existing.resolutionStrategy;
  return resolutionStrategy !== undefined
    ? { schemaVersion: 1, resolutionStrategy, apps }
    : { schemaVersion: 1, apps };
}

export function removeResolvedApp(params: {
  existing: AppsResolutionFile;
  appId: string;
}): AppsResolutionFile {
  if (!params.existing.apps.some((a) => a.id === params.appId)) return params.existing;
  const apps = params.existing.apps.filter((a) => a.id !== params.appId);
  const resolutionStrategy = params.existing.resolutionStrategy;
  return resolutionStrategy !== undefined
    ? { schemaVersion: 1, resolutionStrategy, apps }
    : { schemaVersion: 1, apps };
}

export function setResolvedAppUserEnabled(params: {
  existing: AppsResolutionFile;
  appId: string;
  userEnabled: boolean;
}): AppsResolutionFile {
  const existingApp = findResolvedApp(params.existing, params.appId);
  if (!existingApp) return params.existing;
  if (existingApp.userEnabled === params.userEnabled && existingApp.enabled === params.userEnabled)
    return params.existing;
  const apps = params.existing.apps.map((a) =>
    a.id === params.appId
      ? { ...a, userEnabled: params.userEnabled, enabled: params.userEnabled }
      : a,
  );
  const resolutionStrategy = params.existing.resolutionStrategy;
  return resolutionStrategy !== undefined
    ? { schemaVersion: 1, resolutionStrategy, apps }
    : { schemaVersion: 1, apps };
}

export function setResolvedAppAssignedPort(params: {
  existing: AppsResolutionFile;
  appId: string;
  assignedPort: number | null;
}): AppsResolutionFile {
  if (params.assignedPort !== null) {
    if (!Number.isInteger(params.assignedPort) || params.assignedPort <= 0) {
      throw new Error(
        `Invalid assignedPort: expected positive integer|null (got ${params.assignedPort})`,
      );
    }
  }
  const existingApp = findResolvedApp(params.existing, params.appId);
  if (!existingApp) return params.existing;
  if (existingApp.assignedPort === params.assignedPort) return params.existing;
  const apps = params.existing.apps.map((a) =>
    a.id === params.appId ? { ...a, assignedPort: params.assignedPort } : a,
  );
  const resolutionStrategy = params.existing.resolutionStrategy;
  return resolutionStrategy !== undefined
    ? { schemaVersion: 1, resolutionStrategy, apps }
    : { schemaVersion: 1, apps };
}
