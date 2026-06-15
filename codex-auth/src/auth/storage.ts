import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseIdToken } from '../oauth/tokenParsing.js';
import { AuthCredentialsStoreMode, AuthDotJson, TokenDataFile } from './schema.js';

const AUTH_FILE_NAME = 'auth.json';
const EPHEMERAL_AUTH_STORE = new Map<string, AuthDotJson>();

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
  const tmpPath = `${filePath}.tmp`;
  const json = JSON.stringify(auth, null, 2) + '\n';

  fs.writeFileSync(tmpPath, json, { mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
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

  const tokens = existing.tokens ?? {
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

function storeKey(codexHome: string): string {
  return path.resolve(codexHome);
}

function cloneAuth(auth: AuthDotJson): AuthDotJson {
  return JSON.parse(JSON.stringify(auth)) as AuthDotJson;
}
