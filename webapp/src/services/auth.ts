/**
 * Module: services/auth
 *
 * WebUI auth key handling per docs/auth.md.
 *
 * - URL `?auth=...` takes precedence and must not read/write localStorage.
 * - Otherwise, use localStorage key when present; prompt and persist on manual entry.
 *
 * WebSocket auth is transmitted via Sec-WebSocket-Protocol as:
 *   "dominds-auth.<auth-key>" (plain text)
 */

const AUTH_STORAGE_KEY = 'dominds.authKey';

export type AuthKeySource = 'url' | 'localStorage' | 'manual';

export function readAuthKeyFromUrl(): string | undefined {
  const params = new URLSearchParams(window.location.search);
  const v = params.get('auth');
  return v === null || v === '' ? undefined : v;
}

export function removeAuthKeyFromUrl(): void {
  const url = new URL(window.location.href);
  url.searchParams.delete('auth');
  window.history.replaceState({}, '', url.toString());
}

export function readAuthKeyFromLocalStorage(): string | undefined {
  try {
    const v = window.localStorage.getItem(AUTH_STORAGE_KEY);
    return v === null || v === '' ? undefined : v;
  } catch {
    return undefined;
  }
}

export function writeAuthKeyToLocalStorage(key: string): void {
  try {
    window.localStorage.setItem(AUTH_STORAGE_KEY, key);
  } catch {
    // Ignore: some environments disable storage access.
  }
}

export function clearAuthKeyFromLocalStorage(): void {
  try {
    window.localStorage.removeItem(AUTH_STORAGE_KEY);
  } catch {
    // Ignore.
  }
}

export function makeWebSocketAuthProtocols(authKey: string): string[] {
  return ['dominds', `dominds-auth.${authKey}`];
}
