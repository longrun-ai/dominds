import path from 'node:path';

const DOMINDS_APP_ID_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

export function normalizeDomindsAppId(value: string): string {
  return value.trim();
}

export function isValidDomindsAppId(value: string): boolean {
  const normalized = normalizeDomindsAppId(value);
  return normalized !== '' && DOMINDS_APP_ID_RE.test(normalized);
}

export function domindsAppIdToPathParts(appId: string): ReadonlyArray<string> {
  const normalized = normalizeDomindsAppId(appId);
  if (!isValidDomindsAppId(normalized)) {
    throw new Error(`Invalid Dominds app id: '${appId}'`);
  }
  return normalized.split('/');
}

export function resolveDomindsAppRtwsDirAbs(rtwsRootAbs: string, appId: string): string {
  return path.resolve(rtwsRootAbs, '.apps', ...domindsAppIdToPathParts(appId));
}

export function resolveDomindsAppLocalPackageRootAbs(rootAbs: string, appId: string): string {
  return path.resolve(rootAbs, ...domindsAppIdToPathParts(appId));
}

export function formatDomindsAppRtwsDirRel(appId: string): string {
  return path.posix.join('.apps', ...domindsAppIdToPathParts(appId));
}
