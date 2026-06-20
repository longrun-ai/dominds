import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseIdToken } from '../oauth/tokenParsing.js';
import { AuthCredentialsStoreMode, AuthDotJson, TokenDataFile } from './schema.js';

const AUTH_FILE_NAME = 'auth.json';
const AUTH_REFRESH_LOCK_NAME = 'auth-refresh.lock';
const AUTH_REFRESH_LOCK_STALE_MS = 2 * 60 * 1000;
const AUTH_REFRESH_LOCK_HEARTBEAT_MS = 30 * 1000;
const AUTH_REFRESH_LOCK_WAIT_MS = 100;
const AUTH_REFRESH_REAPER_LOCK_SUFFIX = '.reaper';
const EPHEMERAL_AUTH_STORE = new Map<string, AuthDotJson>();

interface AuthRefreshFileLock {
  lockPath: string;
  lockId: string;
}

interface AuthRefreshLockOwner {
  lockId: string;
  pid: number;
  hostname: string;
}

export function resolveCodexHome(explicit?: string): string {
  if (explicit) {
    return path.resolve(explicit);
  }

  const env = process.env.CODEX_HOME?.trim();
  if (env) {
    if (!fs.existsSync(env)) {
      throw new Error(`CODEX_HOME does not exist: ${env}`);
    }
    return fs.realpathSync(env);
  }

  return path.join(os.homedir(), '.codex');
}

export function authFilePath(codexHome: string): string {
  return path.join(codexHome, AUTH_FILE_NAME);
}

export function readAuthFile(
  codexHome: string,
  storeMode: AuthCredentialsStoreMode = 'file',
): AuthDotJson | null {
  if (storeMode === 'ephemeral') {
    return EPHEMERAL_AUTH_STORE.get(storeKey(codexHome)) ?? null;
  }
  if (storeMode === 'keyring') {
    throw new Error(
      'keyring auth storage is not readable by @longrun-ai/codex-auth; use file or auto storage.',
    );
  }

  const filePath = authFilePath(codexHome);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const contents = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(contents) as AuthDotJson;
  return parsed;
}

export function writeAuthFile(
  codexHome: string,
  auth: AuthDotJson,
  storeMode: AuthCredentialsStoreMode = 'file',
): void {
  if (storeMode === 'ephemeral') {
    EPHEMERAL_AUTH_STORE.set(storeKey(codexHome), cloneAuth(auth));
    return;
  }
  if (storeMode === 'keyring') {
    throw new Error(
      'keyring auth storage is not writable by @longrun-ai/codex-auth; use file or auto storage.',
    );
  }

  fs.mkdirSync(codexHome, { recursive: true });
  const filePath = authFilePath(codexHome);
  const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const json = JSON.stringify(auth, null, 2) + '\n';

  try {
    fs.writeFileSync(tmpPath, json, { mode: 0o600 });
    fs.renameSync(tmpPath, filePath);
  } catch (error: unknown) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch (cleanupError: unknown) {
      console.warn(
        `Failed to remove incomplete codex auth temp file at ${tmpPath}: ${errorMessage(cleanupError)}`,
      );
    }
    throw error;
  }
}

export function deleteAuthFile(
  codexHome: string,
  storeMode: AuthCredentialsStoreMode = 'file',
): boolean {
  if (storeMode === 'ephemeral') {
    return EPHEMERAL_AUTH_STORE.delete(storeKey(codexHome));
  }
  if (storeMode === 'keyring') {
    throw new Error(
      'keyring auth storage is not deletable by @longrun-ai/codex-auth; use file or auto storage.',
    );
  }

  const filePath = authFilePath(codexHome);
  if (!fs.existsSync(filePath)) {
    return false;
  }
  fs.unlinkSync(filePath);
  return true;
}

export async function withAuthRefreshFileLock<T>(
  codexHome: string,
  work: () => Promise<T>,
): Promise<T> {
  const lockPath = authRefreshLockPath(codexHome);
  const lock = await acquireAuthRefreshFileLock(lockPath);
  const heartbeat = startAuthRefreshFileLockHeartbeat(lock);
  try {
    return await work();
  } finally {
    clearInterval(heartbeat);
    releaseAuthRefreshFileLock(lock);
  }
}

export function persistTokens(
  codexHome: string,
  apiKey: string | undefined,
  idToken: string,
  accessToken: string,
  refreshToken: string,
  storeMode: AuthCredentialsStoreMode = 'file',
): AuthDotJson {
  const idTokenInfo = parseIdToken(idToken);
  const tokens: TokenDataFile = {
    id_token: idTokenInfo.raw_jwt,
    access_token: accessToken,
    refresh_token: refreshToken,
    account_id: idTokenInfo.chatgpt_account_id,
  };
  const auth: AuthDotJson = {
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: apiKey,
    tokens,
    last_refresh: new Date().toISOString(),
  };
  writeAuthFile(codexHome, auth, storeMode);
  return auth;
}

export function updateStoredTokens(
  codexHome: string,
  update: {
    idToken?: string | null;
    accessToken?: string | null;
    refreshToken?: string | null;
  },
  storeMode: AuthCredentialsStoreMode = 'file',
): AuthDotJson {
  const existing = readAuthFile(codexHome, storeMode);
  if (!existing) {
    throw new Error('Token data is not available.');
  }

  const tokens = existing.tokens
    ? { ...existing.tokens }
    : {
        id_token: '',
        access_token: '',
        refresh_token: '',
      };

  if (update.idToken !== undefined && update.idToken !== null) {
    tokens.id_token = update.idToken;
    const idInfo = parseIdToken(update.idToken);
    if (idInfo.chatgpt_account_id !== undefined) {
      tokens.account_id = idInfo.chatgpt_account_id;
    }
  }
  if (update.accessToken !== undefined && update.accessToken !== null) {
    tokens.access_token = update.accessToken;
  }
  if (update.refreshToken !== undefined && update.refreshToken !== null) {
    tokens.refresh_token = update.refreshToken;
  }

  const next: AuthDotJson = {
    ...existing,
    tokens,
    last_refresh: new Date().toISOString(),
  };
  writeAuthFile(codexHome, next, storeMode);
  return next;
}

export function logoutAllStores(
  codexHome: string,
  storeMode: AuthCredentialsStoreMode = 'file',
): boolean {
  const removedEphemeral = deleteAuthFile(codexHome, 'ephemeral');
  if (storeMode === 'ephemeral') {
    return removedEphemeral;
  }
  const removedConfigured = deleteAuthFile(codexHome, storeMode);
  return removedEphemeral || removedConfigured;
}

function authRefreshLockPath(codexHome: string): string {
  return path.join(codexHome, AUTH_REFRESH_LOCK_NAME);
}

async function acquireAuthRefreshFileLock(lockPath: string): Promise<AuthRefreshFileLock> {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  for (;;) {
    if (authRefreshReaperLockExists(lockPath)) {
      cleanupStaleAuthRefreshReaperLock(authRefreshReaperLockPath(lockPath));
      await sleep(AUTH_REFRESH_LOCK_WAIT_MS);
      continue;
    }

    try {
      fs.mkdirSync(lockPath, { mode: 0o700 });
      const lock = { lockPath, lockId: randomUUID() };
      try {
        writeAuthRefreshLockOwner(lock);
      } catch (error: unknown) {
        removeAuthRefreshFileLockPath(lock.lockPath);
        throw error;
      }
      return lock;
    } catch (error: unknown) {
      if (!isNodeErrorCode(error, 'EEXIST')) {
        throw error;
      }
      cleanupStaleAuthRefreshLock(lockPath);
      await sleep(AUTH_REFRESH_LOCK_WAIT_MS);
    }
  }
}

function writeAuthRefreshLockOwner(lock: AuthRefreshFileLock): void {
  const ownerPath = authRefreshLockOwnerPath(lock.lockPath);
  const owner = {
    lockId: lock.lockId,
    pid: process.pid,
    hostname: os.hostname(),
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(ownerPath, JSON.stringify(owner, null, 2) + '\n', {
    encoding: 'utf8',
    mode: 0o600,
  });
}

function startAuthRefreshFileLockHeartbeat(
  lock: AuthRefreshFileLock,
): ReturnType<typeof setInterval> {
  return setInterval(() => {
    try {
      touchAuthRefreshLockOwner(lock);
    } catch (error: unknown) {
      console.warn(
        `Failed to update codex auth refresh lock heartbeat at ${lock.lockPath}: ${errorMessage(error)}`,
      );
    }
  }, AUTH_REFRESH_LOCK_HEARTBEAT_MS);
}

function touchAuthRefreshLockOwner(lock: AuthRefreshFileLock): void {
  if (!authRefreshLockIsOwnedBy(lock)) {
    return;
  }
  const now = new Date();
  fs.utimesSync(authRefreshLockOwnerPath(lock.lockPath), now, now);
}

function cleanupStaleAuthRefreshLock(lockPath: string): void {
  withAuthRefreshReaperLock(lockPath, () => {
    let lockInfo: AuthRefreshLockInfo;
    try {
      lockInfo = readAuthRefreshLockInfo(lockPath);
    } catch (error: unknown) {
      if (isMissingPathError(error)) {
        return;
      }
      throw error;
    }

    const ageMs = Date.now() - lockInfo.updatedAtMs;
    if (ageMs < AUTH_REFRESH_LOCK_STALE_MS) {
      return;
    }
    if (authRefreshLockOwnerMayStillBeActive(lockInfo.owner)) {
      return;
    }

    console.warn(
      `Removing stale codex auth refresh lock at ${lockPath}; ageMs=${Math.floor(ageMs)}, staleMs=${AUTH_REFRESH_LOCK_STALE_MS}.`,
    );
    try {
      fs.rmSync(lockPath, { recursive: true, force: true });
    } catch (error: unknown) {
      if (!isNodeErrorCode(error, 'ENOENT')) {
        throw error;
      }
    }
  });
}

interface AuthRefreshLockInfo {
  updatedAtMs: number;
  owner?: AuthRefreshLockOwner;
}

function readAuthRefreshLockInfo(lockPath: string): AuthRefreshLockInfo {
  try {
    const ownerPath = authRefreshLockOwnerPath(lockPath);
    return {
      updatedAtMs: fs.statSync(ownerPath).mtimeMs,
      owner: readAuthRefreshLockOwner(lockPath),
    };
  } catch (error: unknown) {
    if (!isMissingPathError(error)) {
      throw error;
    }
  }
  return { updatedAtMs: fs.statSync(lockPath).mtimeMs };
}

function authRefreshLockOwnerMayStillBeActive(owner: AuthRefreshLockOwner | undefined): boolean {
  return owner?.hostname === os.hostname() && processIsRunning(owner.pid);
}

function processIsRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return isNodeErrorCode(error, 'EPERM');
  }
}

function withAuthRefreshReaperLock(lockPath: string, work: () => void): void {
  const reaperLockPath = authRefreshReaperLockPath(lockPath);
  try {
    fs.mkdirSync(reaperLockPath, { mode: 0o700 });
  } catch (error: unknown) {
    if (isNodeErrorCode(error, 'EEXIST')) {
      cleanupStaleAuthRefreshReaperLock(reaperLockPath);
      return;
    }
    throw error;
  }

  try {
    work();
  } finally {
    try {
      fs.rmSync(reaperLockPath, { recursive: true, force: true });
    } catch (error: unknown) {
      if (!isNodeErrorCode(error, 'ENOENT')) {
        console.warn(
          `Failed to remove codex auth refresh reaper lock at ${reaperLockPath}: ${errorMessage(error)}`,
        );
      }
    }
  }
}

function authRefreshReaperLockExists(lockPath: string): boolean {
  try {
    fs.statSync(authRefreshReaperLockPath(lockPath));
    return true;
  } catch (error: unknown) {
    if (isMissingPathError(error)) {
      return false;
    }
    throw error;
  }
}

function authRefreshReaperLockPath(lockPath: string): string {
  return `${lockPath}${AUTH_REFRESH_REAPER_LOCK_SUFFIX}`;
}

function cleanupStaleAuthRefreshReaperLock(reaperLockPath: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(reaperLockPath);
  } catch (error: unknown) {
    if (isNodeErrorCode(error, 'ENOENT')) {
      return;
    }
    throw error;
  }

  const ageMs = Date.now() - stat.mtimeMs;
  if (ageMs < AUTH_REFRESH_LOCK_STALE_MS) {
    return;
  }

  console.warn(
    `Removing stale codex auth refresh reaper lock at ${reaperLockPath}; ageMs=${Math.floor(ageMs)}, staleMs=${AUTH_REFRESH_LOCK_STALE_MS}.`,
  );
  try {
    fs.rmSync(reaperLockPath, { recursive: true, force: true });
  } catch (error: unknown) {
    if (!isNodeErrorCode(error, 'ENOENT')) {
      throw error;
    }
  }
}

function releaseAuthRefreshFileLock(lock: AuthRefreshFileLock): void {
  if (!authRefreshLockIsOwnedBy(lock)) {
    return;
  }
  removeAuthRefreshFileLockPath(lock.lockPath);
}

function removeAuthRefreshFileLockPath(lockPath: string): void {
  try {
    fs.rmSync(lockPath, { recursive: true, force: true });
  } catch (error: unknown) {
    if (!isNodeErrorCode(error, 'ENOENT')) {
      console.warn(
        `Failed to remove codex auth refresh lock at ${lockPath}: ${errorMessage(error)}`,
      );
    }
  }
}

function authRefreshLockIsOwnedBy(lock: AuthRefreshFileLock): boolean {
  let owner: { lockId: string } | undefined;
  try {
    owner = readAuthRefreshLockOwner(lock.lockPath);
  } catch (error: unknown) {
    console.warn(
      `Failed to read codex auth refresh lock owner at ${lock.lockPath}: ${errorMessage(error)}`,
    );
    return false;
  }
  return owner?.lockId === lock.lockId;
}

function readAuthRefreshLockOwner(lockPath: string): AuthRefreshLockOwner | undefined {
  const ownerPath = authRefreshLockOwnerPath(lockPath);
  let contents: string;
  try {
    contents = fs.readFileSync(ownerPath, 'utf8');
  } catch (error: unknown) {
    if (isMissingPathError(error)) {
      return undefined;
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents) as unknown;
  } catch (error: unknown) {
    console.warn(
      `Ignoring malformed codex auth refresh lock owner at ${ownerPath}: ${errorMessage(error)}`,
    );
    return undefined;
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  if (
    typeof record.lockId !== 'string' ||
    typeof record.pid !== 'number' ||
    typeof record.hostname !== 'string'
  ) {
    return undefined;
  }
  return {
    lockId: record.lockId,
    pid: record.pid,
    hostname: record.hostname,
  };
}

function authRefreshLockOwnerPath(lockPath: string): string {
  return path.join(lockPath, 'owner.json');
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function isMissingPathError(error: unknown): boolean {
  return isNodeErrorCode(error, 'ENOENT') || isNodeErrorCode(error, 'ENOTDIR');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function storeKey(codexHome: string): string {
  return path.resolve(codexHome);
}

function cloneAuth(auth: AuthDotJson): AuthDotJson {
  return JSON.parse(JSON.stringify(auth)) as AuthDotJson;
}
