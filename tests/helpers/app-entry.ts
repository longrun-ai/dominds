import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { DomindsAppInstallJsonV1 } from '@longrun-ai/kernel/app-json';
import { runDomindsAppJsonViaLocalPackage } from '../../main/apps/run-app-json';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export type AppFactoryContext = Readonly<{
  appId: string;
  rtwsRootAbs: string;
  rtwsAppDirAbs: string;
  packageRootAbs: string;
  kernel: Readonly<{ host: string; port: number }>;
  log: (
    level: 'info' | 'warn' | 'error',
    msg: string,
    data?: Readonly<Record<string, unknown>>,
  ) => void;
}>;

export async function loadLocalAppEntry(params: { packageRootAbs: string }): Promise<
  Readonly<{
    installJson: DomindsAppInstallJsonV1;
    appFactory: (ctx: AppFactoryContext) => unknown;
  }>
> {
  const installJson = await runDomindsAppJsonViaLocalPackage({
    packageRootAbs: params.packageRootAbs,
  });
  const moduleAbs = path.resolve(params.packageRootAbs, installJson.host.moduleRelPath);
  const mod: unknown = await import(pathToFileURL(moduleAbs).href);
  if (!isRecord(mod)) {
    throw new Error(`Invalid app module exports (${moduleAbs}): expected object namespace`);
  }
  const exported = mod[installJson.host.exportName];
  if (typeof exported === 'function') {
    return { installJson, appFactory: exported as (ctx: AppFactoryContext) => unknown };
  }
  const maybeDefault = mod.default;
  if (isRecord(maybeDefault)) {
    const nested = maybeDefault[installJson.host.exportName];
    if (typeof nested === 'function') {
      return { installJson, appFactory: nested as (ctx: AppFactoryContext) => unknown };
    }
  }
  throw new Error(
    `Invalid app module exports (${moduleAbs}): missing export '${installJson.host.exportName}'`,
  );
}
