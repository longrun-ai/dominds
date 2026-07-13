import { request } from 'undici';

import { RefreshTokenError, tryRefreshToken } from '../oauth/refresh.js';
import { parseIdToken, parseJwtExpiration } from '../oauth/tokenParsing.js';
import { getBooleanClaim, getStringClaim, parseJwtPayload } from '../utils/jwt.js';
import {
  AgentIdentityAuthRecord,
  AgentIdentityStorage,
  AuthCredentialsStoreMode,
  AuthDotJson,
  AuthState,
  CHATGPT_ACCESS_TOKEN_REFRESH_WINDOW_MINUTES,
  CODEX_ACCESS_TOKEN_ENV_VAR,
  CODEX_API_KEY_ENV_VAR,
  CODEX_AUTHAPI_BASE_URL_ENV_VAR,
  PersonalAccessTokenMetadata,
  TOKEN_REFRESH_INTERVAL_DAYS,
  TokenData,
  normalizeAccountPlanType,
  resolveAuthDotJsonMode,
} from './schema.js';
import {
  deleteAuthFile,
  readAuthFile,
  resolveCodexHome,
  updateStoredTokens,
  withAuthRefreshFileLock,
  writeAuthFile,
} from './storage.js';

export interface AuthManagerOptions {
  codexHome?: string;
  storeMode?: AuthCredentialsStoreMode;
  enableCodexApiKeyEnv?: boolean;
  externalAuth?: ExternalAuth;
  forcedChatgptWorkspaceIds?: string[];
  validateStoredAuth?: (auth: AuthDotJson, source: StoredAuthSource) => void;
  validateAuthState?: (auth: AuthState) => void;
}

export type ExternalAuthRefreshReason = 'unauthorized';

export interface ExternalAuthRefreshContext {
  reason: ExternalAuthRefreshReason;
  previousAccountId?: string;
}

export interface ExternalAuth {
  resolve(): Promise<AuthState>;
  refresh(context: ExternalAuthRefreshContext): Promise<AuthState>;
}

export type ReloadOutcome = 'reloaded_changed' | 'reloaded_no_change' | 'skipped';
export type StoredAuthSource = 'ephemeral' | 'persistent';

const REFRESH_TOKEN_ACCOUNT_MISMATCH_MESSAGE =
  'Your access token could not be refreshed because you have since logged out or signed in to another account. Please sign in again.';
const IN_PROCESS_REFRESHES = new Map<string, Promise<void>>();

export class AuthManager {
  private readonly codexHome: string;
  private readonly storeMode: AuthCredentialsStoreMode;
  private readonly enableCodexApiKeyEnv: boolean;
  private readonly forcedChatgptWorkspaceIds?: string[];
  private readonly validateStoredAuth?: (auth: AuthDotJson, source: StoredAuthSource) => void;
  private readonly validateAuthState?: (auth: AuthState) => void;
  private externalAuth?: ExternalAuth;
  private cached: AuthState | null;

  constructor(options: AuthManagerOptions = {}) {
    this.codexHome = resolveCodexHome(options.codexHome);
    this.storeMode = options.storeMode ?? 'file';
    this.enableCodexApiKeyEnv = options.enableCodexApiKeyEnv ?? false;
    this.externalAuth = options.externalAuth;
    this.forcedChatgptWorkspaceIds = options.forcedChatgptWorkspaceIds;
    this.validateStoredAuth = options.validateStoredAuth;
    this.validateAuthState = options.validateAuthState;
    this.cached = this.externalAuth ? null : this.loadAuthFromStorage();
  }

  authCached(): AuthState | null {
    return this.cached;
  }

  async auth(): Promise<AuthState | null> {
    if (this.externalAuth) {
      const resolved = await this.externalAuth.resolve();
      this.commitExternalAuth(resolved);
      return this.cached;
    }

    if (!this.cached) {
      return null;
    }

    await this.hydratePersonalAccessTokenIfNeeded();
    try {
      await this.refreshIfStale();
    } catch (error: unknown) {
      console.error(`Failed to refresh token: ${errorMessage(error)}`);
      throw error;
    }

    return this.cached;
  }

  async reload(): Promise<boolean> {
    if (this.externalAuth) {
      const resolved = await this.externalAuth.resolve();
      const changed = !authStatesEqual(this.cached, resolved);
      this.commitExternalAuth(resolved);
      return changed;
    }
    const next = this.loadAuthFromStorage();
    const changed = !authStatesEqual(this.cached, next);
    this.cached = next;
    return changed;
  }

  getToken(): string {
    if (!this.cached) {
      throw new Error('Token data is not available.');
    }

    switch (this.cached.mode) {
      case 'api_key':
        return this.cached.apiKey;
      case 'chatgpt':
      case 'chatgpt_auth_tokens':
        return this.cached.tokens.accessToken;
      case 'headers':
        throw new Error('header auth does not expose a bearer token.');
      case 'personal_access_token':
        return this.cached.personalAccessToken;
      case 'agent_identity':
        throw new Error('agent identity auth does not expose a bearer token.');
      case 'bedrock_api_key':
        throw new Error('Bedrock API key auth does not expose a Codex bearer token.');
      default: {
        const _exhaustive: never = this.cached;
        throw new Error(`Unhandled auth state: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  getTokenData(): TokenData {
    if (
      !this.cached ||
      (this.cached.mode !== 'chatgpt' && this.cached.mode !== 'chatgpt_auth_tokens')
    ) {
      throw new Error('Token data is not available.');
    }
    return this.cached.tokens;
  }

  getAccountId(): string | undefined {
    const auth = this.cached;
    if (!auth) {
      return undefined;
    }
    switch (auth.mode) {
      case 'chatgpt':
      case 'chatgpt_auth_tokens':
        return auth.tokens.accountId;
      case 'agent_identity':
        return auth.agentIdentityRecord.account_id;
      case 'personal_access_token':
        return auth.metadata?.chatgpt_account_id;
      case 'api_key':
      case 'headers':
      case 'bedrock_api_key':
        return undefined;
      default: {
        const _exhaustive: never = auth;
        throw new Error(`Unhandled auth state: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  getAccountEmail(): string | undefined {
    const auth = this.cached;
    if (!auth) {
      return undefined;
    }
    switch (auth.mode) {
      case 'chatgpt':
      case 'chatgpt_auth_tokens':
        return auth.tokens.idToken.email;
      case 'agent_identity':
        return auth.agentIdentityRecord.email;
      case 'personal_access_token':
        return auth.metadata?.email;
      case 'api_key':
      case 'headers':
      case 'bedrock_api_key':
        return undefined;
      default: {
        const _exhaustive: never = auth;
        throw new Error(`Unhandled auth state: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  getChatGptUserId(): string | undefined {
    const auth = this.cached;
    if (!auth) {
      return undefined;
    }
    switch (auth.mode) {
      case 'chatgpt':
      case 'chatgpt_auth_tokens':
        return auth.tokens.idToken.chatgpt_user_id;
      case 'agent_identity':
        return auth.agentIdentityRecord.chatgpt_user_id;
      case 'personal_access_token':
        return auth.metadata?.chatgpt_user_id;
      case 'api_key':
      case 'headers':
      case 'bedrock_api_key':
        return undefined;
      default: {
        const _exhaustive: never = auth;
        throw new Error(`Unhandled auth state: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  accountPlanType(): string | undefined {
    const auth = this.cached;
    if (!auth) {
      return undefined;
    }
    switch (auth.mode) {
      case 'chatgpt':
      case 'chatgpt_auth_tokens':
        return auth.tokens.idToken.chatgpt_plan_type;
      case 'agent_identity':
        return auth.agentIdentityRecord.plan_type;
      case 'personal_access_token':
        return auth.metadata?.chatgpt_plan_type;
      case 'api_key':
      case 'headers':
      case 'bedrock_api_key':
        return undefined;
      default: {
        const _exhaustive: never = auth;
        throw new Error(`Unhandled auth state: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  isFedrampAccount(): boolean {
    const auth = this.cached;
    if (!auth) {
      return false;
    }
    switch (auth.mode) {
      case 'chatgpt':
      case 'chatgpt_auth_tokens':
        return auth.tokens.idToken.chatgpt_account_is_fedramp;
      case 'agent_identity':
        return auth.agentIdentityRecord.chatgpt_account_is_fedramp;
      case 'personal_access_token':
        return auth.metadata?.chatgpt_account_is_fedramp ?? false;
      case 'api_key':
      case 'headers':
      case 'bedrock_api_key':
        return false;
      default: {
        const _exhaustive: never = auth;
        throw new Error(`Unhandled auth state: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  async setExternalAuth(externalAuth: ExternalAuth): Promise<void> {
    const resolved = await externalAuth.resolve();
    this.commitExternalAuth(resolved);
    this.externalAuth = externalAuth;
  }

  clearExternalAuth(): void {
    this.externalAuth = undefined;
    this.cached = null;
  }

  externalAuthMode(): AuthState['mode'] | undefined {
    return this.externalAuth ? this.cached?.mode : undefined;
  }

  hasExternalAuth(): boolean {
    return this.externalAuth !== undefined;
  }

  async refreshExternalAuthForUnauthorized(previousAccountId?: string): Promise<void> {
    if (!this.externalAuth) {
      throw new RefreshTokenError('transient', 'external auth is not configured.');
    }
    const refreshed = await this.externalAuth.refresh({
      reason: 'unauthorized',
      previousAccountId,
    });
    this.validateExternalAuth(refreshed);
    this.commitExternalAuth(refreshed);
  }

  createUnauthorizedRecovery(): UnauthorizedRecovery {
    return new UnauthorizedRecovery(this);
  }

  async refreshToken(): Promise<void> {
    if (this.externalAuth) {
      await this.refreshExternalAuthForUnauthorized(this.getAccountId());
      return;
    }
    if (!this.cached || this.cached.mode === 'api_key') {
      return;
    }
    const unsupportedRefreshError = refreshUnsupportedAuthError(this.cached.mode);
    if (unsupportedRefreshError) {
      throw unsupportedRefreshError;
    }

    await this.refreshManagedChatGptToken(this.getAccountId());
  }

  async refreshTokenFromAuthority(): Promise<void> {
    if (this.cached?.mode === 'chatgpt') {
      await this.refreshManagedChatGptToken(this.getAccountId());
      return;
    }

    await this.withInProcessRefresh(async () => {
      await this.withManagedAuthRefreshLock(async () => {
        await this.refreshTokenFromAuthorityUnlocked();
      });
    });
  }

  private async refreshTokenFromAuthorityUnlocked(): Promise<void> {
    if (this.externalAuth) {
      await this.refreshExternalAuthForUnauthorized(this.getAccountId());
      return;
    }
    if (!this.cached) {
      return;
    }
    const unsupportedRefreshError = refreshUnsupportedAuthError(this.cached.mode);
    if (unsupportedRefreshError) {
      throw unsupportedRefreshError;
    }

    if (this.cached.mode !== 'chatgpt') {
      return;
    }

    const refreshToken = this.cached.tokens.refreshToken;
    if (!refreshToken) {
      throw new RefreshTokenError('transient', 'Token data is not available.');
    }

    await this.refreshTokens(refreshToken);
    await this.reload();
  }

  async refreshIfStale(): Promise<boolean> {
    if (!this.cached || this.cached.mode !== 'chatgpt') {
      return false;
    }

    const accessTokenExpiration = parseJwtExpirationSafely(this.cached.tokens.accessToken);
    if (accessTokenExpiration) {
      const cutoff = Date.now() + CHATGPT_ACCESS_TOKEN_REFRESH_WINDOW_MINUTES * 60 * 1000;
      if (accessTokenExpiration.getTime() > cutoff) {
        return false;
      }
      try {
        await this.refreshToken();
      } catch (error: unknown) {
        if (accessTokenExpiration.getTime() > Date.now() && isTransientRefreshError(error)) {
          console.warn(
            `Failed to refresh token; using unexpired access token: ${errorMessage(error)}`,
          );
          return false;
        }
        throw error;
      }
      return true;
    }

    const lastRefresh = this.cached.lastRefresh;
    if (!lastRefresh) {
      return false;
    }

    const cutoff = Date.now() - TOKEN_REFRESH_INTERVAL_DAYS * 24 * 60 * 60 * 1000;
    if (lastRefresh.getTime() >= cutoff) {
      return false;
    }

    await this.refreshToken();
    return true;
  }

  reloadIfAccountIdMatches(expectedAccountId?: string): boolean {
    return this.reloadIfAccountIdMatchesWithOutcome(expectedAccountId) !== 'skipped';
  }

  reloadIfAccountIdMatchesWithOutcome(expectedAccountId?: string): ReloadOutcome {
    if (!expectedAccountId) {
      return 'skipped';
    }

    const next = this.loadAuthFromStorage();
    const newAccountId = accountIdForAuth(next);
    if (newAccountId !== expectedAccountId) {
      return 'skipped';
    }

    const changed = !authStatesEqual(this.cached, next);
    this.cached = next;
    return changed ? 'reloaded_changed' : 'reloaded_no_change';
  }

  private loadAuthFromStorage(): AuthState | null {
    if (this.enableCodexApiKeyEnv) {
      const envApiKey = readNonEmptyEnvVar(CODEX_API_KEY_ENV_VAR);
      if (envApiKey) {
        return this.validatedAuthState({
          mode: 'api_key',
          apiKey: envApiKey,
          raw: { auth_mode: 'apikey', OPENAI_API_KEY: envApiKey },
        });
      }
    }

    const ephemeralAuth = readAuthFile(this.codexHome, 'ephemeral');
    if (ephemeralAuth) {
      return this.validatedAuthState(this.authStateFromAuthDotJson(ephemeralAuth, 'ephemeral'));
    }

    const envAccessToken = readNonEmptyEnvVar(CODEX_ACCESS_TOKEN_ENV_VAR);
    if (envAccessToken) {
      return this.validatedAuthState(authStateFromCodexAccessToken(envAccessToken));
    }

    const auth =
      this.storeMode === 'ephemeral' ? null : readAuthFile(this.codexHome, this.storeMode);
    if (!auth) {
      return null;
    }

    return this.validatedAuthState(this.authStateFromAuthDotJson(auth, 'persistent'));
  }

  private validatedAuthState(auth: AuthState): AuthState {
    this.validateAuthState?.(auth);
    return auth;
  }

  private authStateFromAuthDotJson(auth: AuthDotJson, source: StoredAuthSource): AuthState {
    this.validateStoredAuth?.(auth, source);
    const authMode = resolveAuthDotJsonMode(auth);

    if (authMode === 'apikey') {
      if (!auth.OPENAI_API_KEY) {
        throw new Error('auth.json declares API key auth but OPENAI_API_KEY is missing.');
      }
      return {
        mode: 'api_key',
        apiKey: auth.OPENAI_API_KEY,
        lastRefresh: parseLastRefresh(auth.last_refresh),
        raw: auth,
      };
    }

    if (authMode === 'agentIdentity') {
      const { storage, record } = parseAgentIdentityStorage(auth.agent_identity);
      return {
        mode: 'agent_identity',
        agentIdentity: storage,
        agentIdentityRecord: record,
        raw: auth,
      };
    }

    if (authMode === 'headers') {
      throw new Error('externally provided header auth cannot be loaded from auth.json.');
    }

    if (authMode === 'personalAccessToken') {
      if (!auth.personal_access_token) {
        throw new Error('personal access token auth is missing a personal access token.');
      }
      return {
        mode: 'personal_access_token',
        personalAccessToken: auth.personal_access_token,
        raw: auth,
      };
    }

    if (authMode === 'bedrockApiKey') {
      if (!auth.bedrock_api_key) {
        throw new Error('Bedrock API key auth is missing a Bedrock API key.');
      }
      return {
        mode: 'bedrock_api_key',
        bedrockApiKey: auth.bedrock_api_key,
        raw: auth,
      };
    }

    if (auth.tokens) {
      if (authMode === 'chatgptAuthTokens') {
        const promoted = this.promoteChatGptAuthTokensToFileAuth(auth, source);
        if (promoted) {
          return promoted;
        }
        if (!this.externalAuth) {
          throw new Error(
            'auth.json uses chatgptAuthTokens without a refresh_token and no external ChatGPT auth provider is configured. This token cannot be refreshed automatically; re-run Codex login to create managed ChatGPT OAuth file auth.',
          );
        }
      }
      const idTokenInfo = parseIdToken(auth.tokens.id_token);
      const tokens: TokenData = {
        idToken: idTokenInfo,
        accessToken: auth.tokens.access_token,
        refreshToken: auth.tokens.refresh_token,
        accountId: auth.tokens.account_id ?? idTokenInfo.chatgpt_account_id,
      };
      const lastRefresh = parseLastRefresh(auth.last_refresh);
      if (authMode === 'chatgptAuthTokens') {
        return {
          mode: 'chatgpt_auth_tokens',
          tokens,
          lastRefresh,
          raw: auth,
        };
      }
      return { mode: 'chatgpt', tokens, lastRefresh, raw: auth };
    }

    if (authMode === 'chatgpt' || authMode === 'chatgptAuthTokens') {
      throw new Error(`auth.json declares ${authMode} auth but tokens are missing.`);
    }

    const _exhaustive: never = authMode;
    throw new Error(`Unhandled auth mode: ${String(_exhaustive)}`);
  }

  private promoteChatGptAuthTokensToFileAuth(
    auth: AuthDotJson,
    source: StoredAuthSource,
  ): AuthState | null {
    const tokens = auth.tokens;
    if (
      !tokens ||
      !isNonEmptyString(tokens.id_token) ||
      !isNonEmptyString(tokens.access_token) ||
      !isNonEmptyString(tokens.refresh_token)
    ) {
      return null;
    }

    const promoted: AuthDotJson = {
      ...auth,
      auth_mode: 'chatgpt',
      tokens: { ...tokens },
      last_refresh: auth.last_refresh ?? new Date().toISOString(),
    };
    const state = this.authStateFromManagedChatGptAuth(promoted);
    writeAuthFile(this.codexHome, promoted, 'file');
    if (source === 'ephemeral') {
      deleteAuthFile(this.codexHome, 'ephemeral');
    }

    return state;
  }

  private authStateFromManagedChatGptAuth(auth: AuthDotJson): AuthState {
    const tokens = auth.tokens;
    if (!tokens) {
      throw new Error('auth.json declares ChatGPT auth but tokens are missing.');
    }
    const idTokenInfo = parseIdToken(tokens.id_token);
    return {
      mode: 'chatgpt',
      tokens: {
        idToken: idTokenInfo,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        accountId: tokens.account_id ?? idTokenInfo.chatgpt_account_id,
      },
      lastRefresh: parseLastRefresh(auth.last_refresh),
      raw: auth,
    };
  }

  private async refreshTokens(refreshToken: string): Promise<void> {
    const refreshed = await tryRefreshToken(refreshToken);
    updateStoredTokens(
      this.codexHome,
      {
        idToken: refreshed.id_token ?? null,
        accessToken: refreshed.access_token ?? null,
        refreshToken: refreshed.refresh_token ?? null,
      },
      this.storeMode,
    );
  }

  private async refreshManagedChatGptToken(expectedAccountId?: string): Promise<void> {
    await this.withInProcessRefresh(async () => {
      await this.withManagedAuthRefreshLock(async () => {
        const reloadOutcome = this.reloadIfAccountIdMatchesWithOutcome(expectedAccountId);
        if (reloadOutcome === 'reloaded_changed') {
          return;
        }
        if (reloadOutcome === 'skipped') {
          throw new RefreshTokenError('permanent', REFRESH_TOKEN_ACCOUNT_MISMATCH_MESSAGE, 'other');
        }

        await this.refreshTokenFromAuthorityUnlocked();
      });
    });
  }

  private async withInProcessRefresh(work: () => Promise<void>): Promise<void> {
    const existing = IN_PROCESS_REFRESHES.get(this.codexHome);
    if (existing) {
      await existing;
      const expectedAccountId = this.getAccountId();
      const reloadOutcome = this.reloadIfAccountIdMatchesWithOutcome(expectedAccountId);
      if (reloadOutcome === 'skipped') {
        throw new RefreshTokenError('permanent', REFRESH_TOKEN_ACCOUNT_MISMATCH_MESSAGE, 'other');
      }
      return;
    }

    const refresh = work();
    IN_PROCESS_REFRESHES.set(this.codexHome, refresh);
    try {
      await refresh;
    } finally {
      if (IN_PROCESS_REFRESHES.get(this.codexHome) === refresh) {
        IN_PROCESS_REFRESHES.delete(this.codexHome);
      }
    }
  }

  private async withManagedAuthRefreshLock(work: () => Promise<void>): Promise<void> {
    if (
      this.externalAuth ||
      !this.cached ||
      this.cached.mode !== 'chatgpt' ||
      this.storeMode === 'ephemeral'
    ) {
      await work();
      return;
    }
    await withAuthRefreshFileLock(this.codexHome, work);
  }

  private async hydratePersonalAccessTokenIfNeeded(): Promise<void> {
    if (!this.cached || this.cached.mode !== 'personal_access_token' || this.cached.metadata) {
      return;
    }

    const metadata = await hydratePersonalAccessToken(this.cached.personalAccessToken);
    enforceWorkspaceRestriction(this.forcedChatgptWorkspaceIds, metadata.chatgpt_account_id);
    this.cached = {
      ...this.cached,
      metadata,
    };
  }

  private validateExternalAuth(auth: AuthState): void {
    const accountId = accountIdForAuth(auth);
    if (accountId) {
      enforceWorkspaceRestriction(this.forcedChatgptWorkspaceIds, accountId);
    }
  }

  private commitExternalAuth(auth: AuthState): void {
    this.validateAuthState?.(auth);
    this.validateExternalAuth(auth);
    if (auth.mode === 'chatgpt_auth_tokens') {
      writeAuthFile(this.codexHome, auth.raw, 'ephemeral');
    }
    this.cached = auth;
  }
}

export class UnauthorizedRecovery {
  private step: 'reload' | 'refresh' | 'external_refresh' | 'done';
  private readonly expectedAccountId?: string;
  private readonly mode: 'managed' | 'external';

  constructor(private readonly manager: AuthManager) {
    this.expectedAccountId = manager.getAccountId();
    const cached = manager.authCached();
    this.mode =
      manager.hasExternalAuth() || cached?.mode === 'chatgpt_auth_tokens' ? 'external' : 'managed';
    this.step = this.mode === 'external' ? 'external_refresh' : 'reload';
  }

  hasNext(): boolean {
    if (this.manager.hasExternalAuth()) {
      return this.step !== 'done';
    }
    const auth = this.manager.authCached();
    if (!auth || (auth.mode !== 'chatgpt' && auth.mode !== 'chatgpt_auth_tokens')) {
      return false;
    }
    if (auth.mode === 'chatgpt_auth_tokens' && !this.manager.hasExternalAuth()) {
      return false;
    }
    return this.step !== 'done';
  }

  async next(): Promise<void> {
    if (!this.hasNext()) {
      throw new RefreshTokenError('permanent', 'No more recovery steps available.');
    }

    if (this.step === 'external_refresh') {
      await this.manager.refreshExternalAuthForUnauthorized(this.expectedAccountId);
      this.step = 'done';
      return;
    }

    if (this.step === 'reload') {
      const reloaded = this.manager.reloadIfAccountIdMatchesWithOutcome(this.expectedAccountId);
      if (reloaded === 'skipped') {
        this.step = 'done';
        throw new RefreshTokenError('permanent', REFRESH_TOKEN_ACCOUNT_MISMATCH_MESSAGE, 'other');
      }
      this.step = 'refresh';
      return;
    }

    if (this.step === 'refresh') {
      await this.manager.refreshTokenFromAuthority();
      this.step = 'done';
    }
  }
}

function authStatesEqual(a: AuthState | null, b: AuthState | null): boolean {
  if (!a && !b) {
    return true;
  }
  if (!a || !b) {
    return false;
  }
  if (a.mode !== b.mode) {
    return false;
  }

  switch (a.mode) {
    case 'api_key':
      return b.mode === 'api_key' && a.apiKey === b.apiKey;
    case 'chatgpt':
    case 'chatgpt_auth_tokens':
      return (
        (b.mode === 'chatgpt' || b.mode === 'chatgpt_auth_tokens') && authDotJsonEqual(a.raw, b.raw)
      );
    case 'headers':
      return b.mode === 'headers' && JSON.stringify(a.headers) === JSON.stringify(b.headers);
    case 'agent_identity':
      return (
        b.mode === 'agent_identity' &&
        JSON.stringify(a.agentIdentity) === JSON.stringify(b.agentIdentity)
      );
    case 'personal_access_token':
      return b.mode === 'personal_access_token' && a.personalAccessToken === b.personalAccessToken;
    case 'bedrock_api_key':
      return (
        b.mode === 'bedrock_api_key' &&
        a.bedrockApiKey.api_key === b.bedrockApiKey.api_key &&
        a.bedrockApiKey.region === b.bedrockApiKey.region
      );
    default: {
      const _exhaustive: never = a;
      throw new Error(`Unhandled auth state: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

function authDotJsonEqual(a: AuthDotJson, b: AuthDotJson): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function parseLastRefresh(value: string | undefined): Date | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return undefined;
  }
  return parsed;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isTransientRefreshError(error: unknown): boolean {
  return error instanceof RefreshTokenError && error.kind === 'transient';
}

function accountIdForAuth(auth: AuthState | null): string | undefined {
  if (!auth) {
    return undefined;
  }
  switch (auth.mode) {
    case 'chatgpt':
    case 'chatgpt_auth_tokens':
      return auth.tokens.accountId;
    case 'agent_identity':
      return auth.agentIdentityRecord.account_id;
    case 'personal_access_token':
      return auth.metadata?.chatgpt_account_id;
    case 'api_key':
    case 'headers':
    case 'bedrock_api_key':
      return undefined;
    default: {
      const _exhaustive: never = auth;
      throw new Error(`Unhandled auth state: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

function refreshUnsupportedAuthError(mode: AuthState['mode']): RefreshTokenError | undefined {
  switch (mode) {
    case 'personal_access_token':
      return new RefreshTokenError(
        'permanent',
        'personalAccessToken auth cannot be refreshed automatically and cannot be converted to managed ChatGPT OAuth file auth. Re-run Codex login to create refreshable file auth.',
        'other',
      );
    case 'agent_identity':
      return new RefreshTokenError(
        'permanent',
        'agentIdentity auth does not expose refreshable ChatGPT bearer credentials in this package. Re-run Codex login to create managed ChatGPT OAuth file auth.',
        'other',
      );
    case 'bedrock_api_key':
      return new RefreshTokenError(
        'permanent',
        'bedrockApiKey auth is not ChatGPT OAuth file auth. Re-run Codex login to create managed ChatGPT OAuth file auth.',
        'other',
      );
    case 'api_key':
    case 'chatgpt':
    case 'chatgpt_auth_tokens':
      return undefined;
    case 'headers':
      return new RefreshTokenError(
        'permanent',
        'header auth can only be refreshed by its external auth provider.',
        'other',
      );
    default: {
      const _exhaustive: never = mode;
      throw new Error(`Unhandled auth mode: ${String(_exhaustive)}`);
    }
  }
}

function parseJwtExpirationSafely(jwt: string): Date | undefined {
  try {
    return parseJwtExpiration(jwt);
  } catch {
    return undefined;
  }
}

function authStateFromCodexAccessToken(accessToken: string): AuthState {
  if (accessToken.startsWith('at-')) {
    return {
      mode: 'personal_access_token',
      personalAccessToken: accessToken,
      raw: {
        personal_access_token: accessToken,
      },
    };
  }
  return {
    mode: 'agent_identity',
    agentIdentity: accessToken,
    agentIdentityRecord: parseAgentIdentityJwt(accessToken),
    raw: {
      auth_mode: 'agentIdentity',
      agent_identity: accessToken,
    },
  };
}

function readNonEmptyEnvVar(key: string): string | undefined {
  const value = process.env[key]?.trim();
  return value && value.length > 0 ? value : undefined;
}

function isNonEmptyString(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function parseAgentIdentityJwt(jwt: string): AgentIdentityAuthRecord {
  const payload = parseJwtPayload(jwt);
  const agentRuntimeId = getStringClaim(payload.agent_runtime_id);
  const agentPrivateKey = getStringClaim(payload.agent_private_key);
  const accountId = getStringClaim(payload.account_id);
  const chatgptUserId = getStringClaim(payload.chatgpt_user_id);
  const email = getStringClaim(payload.email);
  const planType = normalizeAccountPlanType(getStringClaim(payload.plan_type));
  const accountIsFedramp = getBooleanClaim(payload.chatgpt_account_is_fedramp);
  if (
    !agentRuntimeId ||
    !agentPrivateKey ||
    !accountId ||
    !chatgptUserId ||
    planType === undefined ||
    accountIsFedramp === undefined
  ) {
    throw new Error('agent identity JWT is missing required claims.');
  }

  return {
    agent_runtime_id: agentRuntimeId,
    agent_private_key: agentPrivateKey,
    account_id: accountId,
    chatgpt_user_id: chatgptUserId,
    ...(email ? { email } : {}),
    plan_type: planType,
    chatgpt_account_is_fedramp: accountIsFedramp,
  };
}

function parseAgentIdentityStorage(value: AgentIdentityStorage | undefined): {
  storage: AgentIdentityStorage;
  record: AgentIdentityAuthRecord;
} {
  if (typeof value === 'string') {
    if (value.trim().length === 0) {
      throw new Error('agent identity auth is missing agent identity auth material.');
    }
    return { storage: value, record: parseAgentIdentityJwt(value) };
  }
  if (!value) {
    throw new Error('agent identity auth is missing agent identity auth material.');
  }
  return { storage: value, record: parseAgentIdentityRecord(value) };
}

function parseAgentIdentityRecord(value: AgentIdentityAuthRecord): AgentIdentityAuthRecord {
  // auth.json is an external persistence boundary, so every record field is validated at runtime.
  const record = value as unknown as Record<string, unknown>;
  const agentRuntimeId = getNonEmptyRecordString(record, 'agent_runtime_id');
  const agentPrivateKey = getNonEmptyRecordString(record, 'agent_private_key');
  const accountId = getNonEmptyRecordString(record, 'account_id');
  const chatgptUserId = getNonEmptyRecordString(record, 'chatgpt_user_id');
  const rawPlanType = getNonEmptyRecordString(record, 'plan_type');
  const planType = normalizeAccountPlanType(rawPlanType);
  const accountIsFedramp = record.chatgpt_account_is_fedramp;
  if (planType === undefined || typeof accountIsFedramp !== 'boolean') {
    throw new Error('agent identity record is missing required fields.');
  }
  const email = getOptionalRecordString(record, 'email');
  const taskId = getOptionalRecordString(record, 'task_id');
  return {
    agent_runtime_id: agentRuntimeId,
    agent_private_key: agentPrivateKey,
    account_id: accountId,
    chatgpt_user_id: chatgptUserId,
    ...(email ? { email } : {}),
    plan_type: planType,
    chatgpt_account_is_fedramp: accountIsFedramp,
    ...(taskId ? { task_id: taskId } : {}),
  };
}

function getNonEmptyRecordString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`agent identity record field ${key} must be a non-empty string.`);
  }
  return value;
}

function getOptionalRecordString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error(`agent identity record field ${key} must be a string when present.`);
  }
  return value;
}

function personalAccessTokenAuthApiBaseUrl(): string {
  const envValue = process.env[CODEX_AUTHAPI_BASE_URL_ENV_VAR]?.trim();
  return (
    envValue && envValue.length > 0 ? envValue : 'https://auth.openai.com/api/accounts'
  ).replace(/\/+$/, '');
}

async function hydratePersonalAccessToken(
  accessToken: string,
): Promise<PersonalAccessTokenMetadata> {
  const endpoint = `${personalAccessTokenAuthApiBaseUrl()}/v1/user-auth-credential/whoami`;
  const response = await request(endpoint, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });
  if (response.statusCode < 200 || response.statusCode > 299) {
    throw new Error(
      `personal access token metadata request failed with status ${response.statusCode}`,
    );
  }
  const json = (await response.body.json()) as unknown;
  if (!isPersonalAccessTokenMetadata(json)) {
    throw new Error('personal access token metadata response has an unexpected shape.');
  }
  return {
    ...json,
    chatgpt_plan_type: normalizeAccountPlanType(json.chatgpt_plan_type) ?? 'unknown',
  };
}

function isPersonalAccessTokenMetadata(value: unknown): value is PersonalAccessTokenMetadata {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    (record.email === undefined || typeof record.email === 'string') &&
    typeof record.chatgpt_user_id === 'string' &&
    typeof record.chatgpt_account_id === 'string' &&
    typeof record.chatgpt_plan_type === 'string' &&
    typeof record.chatgpt_account_is_fedramp === 'boolean'
  );
}

export function createExternalApiKeyAuth(apiKey: string): AuthState {
  if (!isNonEmptyString(apiKey)) {
    throw new Error('external API key auth requires a non-empty API key.');
  }
  return {
    mode: 'api_key',
    apiKey,
    raw: { auth_mode: 'apikey', OPENAI_API_KEY: apiKey },
  };
}

export function createExternalChatGptAuth(
  accessToken: string,
  accountId: string,
  planType?: string,
): AuthState {
  if (!isNonEmptyString(accessToken) || !isNonEmptyString(accountId)) {
    throw new Error('external ChatGPT auth requires an access token and account id.');
  }
  const idTokenInfo = parseIdToken(accessToken);
  idTokenInfo.chatgpt_account_id = accountId;
  idTokenInfo.chatgpt_plan_type =
    normalizeAccountPlanType(planType) ?? idTokenInfo.chatgpt_plan_type ?? 'unknown';
  const lastRefresh = new Date();
  const raw: AuthDotJson = {
    auth_mode: 'chatgptAuthTokens',
    tokens: {
      id_token: accessToken,
      access_token: accessToken,
      refresh_token: '',
      account_id: accountId,
    },
    last_refresh: lastRefresh.toISOString(),
  };
  return {
    mode: 'chatgpt_auth_tokens',
    tokens: {
      idToken: idTokenInfo,
      accessToken,
      refreshToken: '',
      accountId,
    },
    lastRefresh,
    raw,
  };
}

export function createExternalHeaderAuth(headers: Record<string, string>): AuthState {
  const entries = Object.entries(headers);
  if (entries.length === 0) {
    throw new Error('external header auth requires at least one header.');
  }
  const normalized: Record<string, string> = {};
  for (const [name, value] of entries) {
    if (name.trim().length === 0 || value.trim().length === 0) {
      throw new Error('external header auth names and values must be non-empty strings.');
    }
    normalized[name] = value;
  }
  return { mode: 'headers', headers: normalized };
}

function enforceWorkspaceRestriction(
  expectedWorkspaceIds: string[] | undefined,
  accountId: string,
): void {
  if (!expectedWorkspaceIds || expectedWorkspaceIds.length === 0) {
    return;
  }
  if (!expectedWorkspaceIds.includes(accountId)) {
    throw new Error(
      `Login is restricted to workspace(s) ${expectedWorkspaceIds.join(
        ', ',
      )}, but current credentials belong to ${accountId}.`,
    );
  }
}
