import fs from 'node:fs/promises';
import path from 'node:path';

import YAML from 'yaml';

export type AppsResolutionStrategyOrderItem = 'local' | 'npx';

export type AppsResolutionStrategy = Readonly<{
  order?: ReadonlyArray<AppsResolutionStrategyOrderItem>;
  localRoots?: ReadonlyArray<string>;
}>;

export const DEFAULT_APPS_RESOLUTION_STRATEGY: AppsResolutionStrategy = {
  order: ['local'],
  localRoots: ['dominds-apps'],
};

export type NormalizedAppsResolutionStrategy = Readonly<{
  order: ReadonlyArray<AppsResolutionStrategyOrderItem>;
  localRoots: ReadonlyArray<string>;
}>;

export type AppsConfigurationSchemaVersion = 1;

export type AppsConfigurationFile = Readonly<{
  schemaVersion: AppsConfigurationSchemaVersion;
  resolutionStrategy?: AppsResolutionStrategy;
  disabledApps?: ReadonlyArray<string>;
}>;

export const APPS_CONFIGURATION_REL_PATH = path.join('.apps', 'configuration.yaml');

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

export function parseResolutionStrategy(
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

export function normalizeAppsResolutionStrategy(
  raw: AppsResolutionStrategy | undefined,
): NormalizedAppsResolutionStrategy {
  const order =
    raw?.order ??
    DEFAULT_APPS_RESOLUTION_STRATEGY.order ??
    (['local'] satisfies ReadonlyArray<'local'>);
  const localRoots = raw?.localRoots ??
    DEFAULT_APPS_RESOLUTION_STRATEGY.localRoots ?? ['dominds-apps'];

  if (order.length === 0) {
    throw new Error(
      `Invalid ${APPS_CONFIGURATION_REL_PATH}: resolutionStrategy.order must not be empty`,
    );
  }
  if (localRoots.length === 0) {
    throw new Error(
      `Invalid ${APPS_CONFIGURATION_REL_PATH}: resolutionStrategy.localRoots must not be empty`,
    );
  }
  if (new Set(order).size !== order.length) {
    throw new Error(
      `Invalid ${APPS_CONFIGURATION_REL_PATH}: resolutionStrategy.order has duplicates`,
    );
  }
  if (new Set(localRoots).size !== localRoots.length) {
    throw new Error(
      `Invalid ${APPS_CONFIGURATION_REL_PATH}: resolutionStrategy.localRoots has duplicates`,
    );
  }

  return { order, localRoots };
}

function canonicalizeConfigurationFile(file: AppsConfigurationFile): AppsConfigurationFile {
  const disabledApps = file.disabledApps
    ? [
        ...new Set(file.disabledApps.map((appId) => appId.trim()).filter((appId) => appId !== '')),
      ].sort()
    : [];
  return {
    schemaVersion: 1,
    resolutionStrategy: file.resolutionStrategy,
    disabledApps: disabledApps.length > 0 ? disabledApps : undefined,
  };
}

function parseConfigurationFile(
  parsed: unknown,
  filePathAbs: string,
): { ok: true; file: AppsConfigurationFile } | { ok: false; errorText: string } {
  if (!isRecord(parsed)) {
    return { ok: false, errorText: `Invalid configuration.yaml: expected object (${filePathAbs})` };
  }

  const keys = Object.keys(parsed);
  for (const k of keys) {
    if (k !== 'schemaVersion' && k !== 'resolutionStrategy' && k !== 'disabledApps') {
      return {
        ok: false,
        errorText: `Invalid configuration.yaml: unknown key '${k}' (${filePathAbs})`,
      };
    }
  }

  const schemaVersion = parsed['schemaVersion'];
  if (schemaVersion !== 1) {
    return {
      ok: false,
      errorText: `Unsupported configuration.yaml schemaVersion: ${String(schemaVersion)} (${filePathAbs})`,
    };
  }

  const strategyRaw = parsed['resolutionStrategy'];
  const resolutionStrategy = (() => {
    if (strategyRaw === undefined) return undefined;
    const strategy = parseResolutionStrategy(strategyRaw, 'resolutionStrategy');
    if (!strategy.ok) return strategy;
    return { ok: true as const, value: strategy.strategy };
  })();
  if (resolutionStrategy && !resolutionStrategy.ok) {
    return { ok: false, errorText: `${resolutionStrategy.errorText} (${filePathAbs})` };
  }

  const disabledRaw = parsed['disabledApps'];
  const disabledApps = (() => {
    if (disabledRaw === undefined) return undefined;
    if (!Array.isArray(disabledRaw)) {
      return {
        ok: false as const,
        errorText: `Invalid disabledApps: expected array (${filePathAbs})`,
      };
    }
    const out: string[] = [];
    for (let i = 0; i < disabledRaw.length; i += 1) {
      const item = asString(disabledRaw[i]);
      if (!item || item.trim() === '') {
        return {
          ok: false as const,
          errorText: `Invalid disabledApps[${i}]: expected non-empty string (${filePathAbs})`,
        };
      }
      out.push(item.trim());
    }
    return { ok: true as const, value: out };
  })();
  if (disabledApps && !disabledApps.ok) return disabledApps;

  return {
    ok: true,
    file: canonicalizeConfigurationFile({
      schemaVersion: 1,
      resolutionStrategy: resolutionStrategy ? resolutionStrategy.value : undefined,
      disabledApps: disabledApps ? disabledApps.value : undefined,
    }),
  };
}

export async function loadAppsConfigurationFile(params: { rtwsRootAbs: string }): Promise<
  | Readonly<{
      kind: 'ok';
      file: AppsConfigurationFile;
      filePathAbs: string;
      exists: boolean;
    }>
  | Readonly<{ kind: 'error'; errorText: string; filePathAbs: string }>
> {
  const filePathAbs = path.resolve(params.rtwsRootAbs, APPS_CONFIGURATION_REL_PATH);
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
      return {
        kind: 'ok',
        filePathAbs,
        exists: false,
        file: { schemaVersion: 1 },
      };
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

  const cfg = parseConfigurationFile(parsed, filePathAbs);
  if (!cfg.ok) {
    return { kind: 'error', filePathAbs, errorText: cfg.errorText };
  }
  return {
    kind: 'ok',
    filePathAbs,
    exists: true,
    file: cfg.file,
  };
}

export async function writeAppsConfigurationFile(params: {
  rtwsRootAbs: string;
  file: AppsConfigurationFile;
}): Promise<void> {
  const dirAbs = path.resolve(params.rtwsRootAbs, '.apps');
  await fs.mkdir(dirAbs, { recursive: true });
  const filePathAbs = path.resolve(params.rtwsRootAbs, APPS_CONFIGURATION_REL_PATH);
  const yamlText = YAML.stringify(canonicalizeConfigurationFile(params.file));
  await fs.writeFile(filePathAbs, yamlText, 'utf-8');
}

export async function writeAppsConfigurationFileIfChanged(params: {
  rtwsRootAbs: string;
  file: AppsConfigurationFile;
}): Promise<void> {
  const dirAbs = path.resolve(params.rtwsRootAbs, '.apps');
  await fs.mkdir(dirAbs, { recursive: true });
  const filePathAbs = path.resolve(params.rtwsRootAbs, APPS_CONFIGURATION_REL_PATH);
  const yamlText = YAML.stringify(canonicalizeConfigurationFile(params.file));
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

export function isAppDisabledInConfiguration(file: AppsConfigurationFile, appId: string): boolean {
  return (file.disabledApps ?? []).includes(appId);
}

export function setAppDisabledInConfiguration(params: {
  existing: AppsConfigurationFile;
  appId: string;
  disabled: boolean;
}): AppsConfigurationFile {
  const appId = params.appId.trim();
  if (appId === '') return params.existing;

  const disabledSet = new Set(params.existing.disabledApps ?? []);
  if (params.disabled) disabledSet.add(appId);
  else disabledSet.delete(appId);

  const next = canonicalizeConfigurationFile({
    schemaVersion: 1,
    resolutionStrategy: params.existing.resolutionStrategy,
    disabledApps: [...disabledSet],
  });
  const prev = canonicalizeConfigurationFile(params.existing);
  if (YAML.stringify(prev) === YAML.stringify(next)) return params.existing;
  return next;
}
