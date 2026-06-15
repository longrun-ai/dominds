import { request } from 'undici';

import { RefreshTokenError, tryRefreshToken } from '../oauth/refresh.js';
import { parseIdToken, parseJwtExpiration } from '../oauth/tokenParsing.js';
import { getBooleanClaim, getStringClaim, parseJwtPayload } from '../utils/jwt.js';
import {
  AgentIdentityAuthRecord,
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
  writeAuthFile,
} from './storage.js';

export interface AuthManagerOptions {
  codexHome?: string;
  storeMode?: AuthCredentialsStoreMode;
  enableCodexApiKeyEnv?: boolean;
  externalAuth?: ExternalAuth;
  forcedChatgptWorkspaceIds?: string[];
}

export type ExternalAuthRefreshReason = 'unauthorized';

export interface ExternalAuthRefreshContext {
  reason: ExternalAuthRefreshReason;
  previousAccountId?: string;
}

export interface ExternalAuthTokens {
  accessToken: string;
  idToken?: string;
  refreshToken?: string;
  chatgptMetadata?: {
    accountId: string;
    planType?: string;
  };
}

export interface ExternalAuth {
  authMode(): 'api_key' | 'chatgpt_auth_tokens';
  resolve?(): Promise<ExternalAuthTokens | null>;
  refresh(context: ExternalAuthRefreshContext): Promise<ExternalAuthTokens>;
}

export type ReloadOutcome = 'reloaded_changed' | 'reloaded_no_change' | 'skipped';
type AuthLoadSource = 'ephemeral' | 'persistent';

const REFRESH_TOKEN_ACCOUNT_MISMATCH_MESSAGE =
  'Your access token could not be refreshed because you have since logged out or signed in to another account. Please sign in again.';

export class AuthManager {
  private readonly codexHome: string;
  private readonly storeMode: AuthCredentialsStoreMode;
  private readonly enableCodexApiKeyEnv: boolean;
  private readonly forcedChatgptWorkspaceIds?: string[];
  private externalAuth?: ExternalAuth;
  private cached: AuthState | null;

  constructor(options: AuthManagerOptions = {}) {
    this.codexHome = resolveCodexHome(options.codexHome);
    this.storeMode = options.storeMode ?? 'file';
    this.enableCodexApiKeyEnv = options.enableCodexApiKeyEnv ?? false;
    this.externalAuth = options.externalAuth;
    this.forcedChatgptWorkspaceIds = options.forcedChatgptWorkspaceIds;
    this.cached = this.loadAuthFromStorage();
  }

  authCached(): AuthState | null {
    return this.cached;
  }

  async auth(): Promise<AuthState | null> {
    const externalApiKeyAuth = await this.resolveExternalApiKeyAuth();
    if (externalApiKeyAuth) {
      return externalApiKeyAuth;
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

  reload(): boolean {
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
      case 'bedrock_api_key':
        return false;
      default: {
        const _exhaustive: never = auth;
        throw new Error(`Unhandled auth state: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  setExternalAuth(externalAuth: ExternalAuth): void {
    this.externalAuth = externalAuth;
  }

  clearExternalAuth(): void {
    this.externalAuth = undefined;
  }

  externalAuthMode(): 'api_key' | 'chatgpt_auth_tokens' | undefined {
    return this.externalAuth?.authMode();
  }

  hasExternalAuth(): boolean {
    return this.externalAuth !== undefined;
  }

  async refreshExternalAuthForUnauthorized(previousAccountId?: string): Promise<void> {
    if (!this.externalAuth) {
      throw new RefreshTokenError('transient', 'external auth is not configured.');
    }
    if (this.externalAuth.authMode() === 'api_key') {
      const resolved = await this.externalAuth.refresh({
        reason: 'unauthorized',
        previousAccountId,
      });
      this.cached = {
        mode: 'api_key',
        apiKey: resolved.accessToken,
        raw: { auth_mode: 'apikey', OPENAI_API_KEY: resolved.accessToken },
      };
      return;
    }
    await this.refreshExternalChatGptAuth('unauthorized');
  }

  createUnauthorizedRecovery(): UnauthorizedRecovery {
    return new UnauthorizedRecovery(this);
  }

  async refreshToken(): Promise<void> {
    if (!this.cached || this.cached.mode === 'api_key') {
      return;
    }
    const unsupportedRefreshError = refreshUnsupportedAuthError(this.cached.mode);
    if (unsupportedRefreshError) {
      throw unsupportedRefreshError;
    }

    const expectedAccountId = this.getAccountId();
    const reloadOutcome = this.reloadIfAccountIdMatchesWithOutcome(expectedAccountId);
    if (reloadOutcome === 'reloaded_changed') {
      return;
    }
    if (reloadOutcome === 'skipped') {
      throw new RefreshTokenError('permanent', REFRESH_TOKEN_ACCOUNT_MISMATCH_MESSAGE, 'other');
    }

    await this.refreshTokenFromAuthority();
  }

  async refreshTokenFromAuthority(): Promise<void> {
    if (!this.cached) {
      return;
    }
    const unsupportedRefreshError = refreshUnsupportedAuthError(this.cached.mode);
    if (unsupportedRefreshError) {
      throw unsupportedRefreshError;
    }

    if (this.cached.mode === 'chatgpt_auth_tokens') {
      await this.refreshExternalChatGptAuth('unauthorized');
      return;
    }

    if (this.cached.mode !== 'chatgpt') {
      return;
    }

    const refreshToken = this.cached.tokens.refreshToken;
    if (!refreshToken) {
      throw new RefreshTokenError('transient', 'Token data is not available.');
    }

    await this.refreshTokens(refreshToken);
    this.reload();
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
      await this.refreshToken();
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
        return {
          mode: 'api_key',
          apiKey: envApiKey,
          raw: { auth_mode: 'apikey', OPENAI_API_KEY: envApiKey },
        };
      }
    }

    const ephemeralAuth = readAuthFile(this.codexHome, 'ephemeral');
    if (ephemeralAuth) {
      return this.authStateFromAuthDotJson(ephemeralAuth, 'ephemeral');
    }

    const envAccessToken = readNonEmptyEnvVar(CODEX_ACCESS_TOKEN_ENV_VAR);
    if (envAccessToken) {
      return authStateFromCodexAccessToken(envAccessToken);
    }

    const auth =
      this.storeMode === 'ephemeral' ? null : readAuthFile(this.codexHome, this.storeMode);
    if (!auth) {
      return null;
    }

    return this.authStateFromAuthDotJson(auth, 'persistent');
  }

  private authStateFromAuthDotJson(auth: AuthDotJson, source: AuthLoadSource): AuthState {
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
      const agentIdentity = readAgentIdentityToken(auth.agent_identity);
      if (!agentIdentity) {
        throw new Error('agent identity auth is missing an agent identity token.');
      }
      return {
        mode: 'agent_identity',
        agentIdentity,
        agentIdentityRecord: parseAgentIdentityJwt(agentIdentity),
        raw: auth,
      };
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
        if (!this.externalAuth || this.externalAuth.authMode() !== 'chatgpt_auth_tokens') {
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
      return {
        mode: authMode === 'chatgptAuthTokens' ? 'chatgpt_auth_tokens' : 'chatgpt',
        tokens,
        lastRefresh: parseLastRefresh(auth.last_refresh),
        raw: auth,
      };
    }

    if (authMode === 'chatgpt' || authMode === 'chatgptAuthTokens') {
      throw new Error(`auth.json declares ${authMode} auth but tokens are missing.`);
    }

    const _exhaustive: never = authMode;
    throw new Error(`Unhandled auth mode: ${String(_exhaustive)}`);
  }

  private promoteChatGptAuthTokensToFileAuth(
    auth: AuthDotJson,
    source: AuthLoadSource,
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

  private async resolveExternalApiKeyAuth(): Promise<AuthState | null> {
    if (!this.externalAuth || this.externalAuth.authMode() !== 'api_key') {
      return null;
    }
    const resolved = this.externalAuth.resolve ? await this.externalAuth.resolve() : null;
    if (!resolved) {
      return null;
    }
    return {
      mode: 'api_key',
      apiKey: resolved.accessToken,
      raw: {
        auth_mode: 'apikey',
        OPENAI_API_KEY: resolved.accessToken,
      },
    };
  }

  private async refreshExternalChatGptAuth(reason: ExternalAuthRefreshReason): Promise<void> {
    if (!this.externalAuth || this.externalAuth.authMode() !== 'chatgpt_auth_tokens') {
      throw new RefreshTokenError('transient', 'external auth is not configured.');
    }
    const refreshed = await this.externalAuth.refresh({
      reason,
      previousAccountId: this.getAccountId(),
    });
    const metadata = refreshed.chatgptMetadata;
    if (!metadata) {
      throw new RefreshTokenError(
        'transient',
        'external auth refresh did not return ChatGPT metadata.',
      );
    }
    enforceWorkspaceRestriction(this.forcedChatgptWorkspaceIds, metadata.accountId);
    const idTokenInfo = parseIdToken(refreshed.idToken ?? refreshed.accessToken);
    idTokenInfo.chatgpt_account_id = metadata.accountId;
    idTokenInfo.chatgpt_plan_type =
      normalizeAccountPlanType(metadata.planType) ?? idTokenInfo.chatgpt_plan_type ?? 'unknown';
    const refreshToken = refreshed.refreshToken ?? '';
    const tokens: TokenData = {
      idToken: idTokenInfo,
      accessToken: refreshed.accessToken,
      refreshToken,
      accountId: metadata.accountId,
    };
    const lastRefresh = new Date();
    const raw: AuthDotJson = {
      auth_mode: 'chatgptAuthTokens',
      tokens: {
        id_token: idTokenInfo.raw_jwt,
        access_token: refreshed.accessToken,
        refresh_token: refreshToken,
        account_id: metadata.accountId,
      },
      last_refresh: lastRefresh.toISOString(),
    };
    if (isNonEmptyString(refreshToken)) {
      writeAuthFile(this.codexHome, { ...raw, auth_mode: 'chatgpt' }, 'file');
      deleteAuthFile(this.codexHome, 'ephemeral');
      this.cached = {
        mode: 'chatgpt',
        tokens,
        lastRefresh,
        raw: { ...raw, auth_mode: 'chatgpt' },
      };
      return;
    }
    writeAuthFile(this.codexHome, raw, 'ephemeral');
    this.cached = {
      mode: 'chatgpt_auth_tokens',
      tokens,
      lastRefresh,
      raw,
    };
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
      cached?.mode === 'chatgpt_auth_tokens' || manager.externalAuthMode() === 'api_key'
        ? 'external'
        : 'managed';
    this.step = this.mode === 'external' ? 'external_refresh' : 'reload';
  }

  hasNext(): boolean {
    if (this.manager.externalAuthMode() === 'api_key') {
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
    case 'agent_identity':
      return b.mode === 'agent_identity' && a.agentIdentity === b.agentIdentity;
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
    default: {
      const _exhaustive: never = mode;
      throw new Error(`Unhandled auth mode: ${String(_exhaustive)}`);
    }
  }
}

function readAgentIdentityToken(agentIdentity: string | undefined): string | undefined {
  return typeof agentIdentity === 'string' && agentIdentity.trim().length > 0
    ? agentIdentity
    : undefined;
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
    !email ||
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
    email,
    plan_type: planType,
    chatgpt_account_is_fedramp: accountIsFedramp,
  };
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
    typeof record.email === 'string' &&
    typeof record.chatgpt_user_id === 'string' &&
    typeof record.chatgpt_account_id === 'string' &&
    typeof record.chatgpt_plan_type === 'string' &&
    typeof record.chatgpt_account_is_fedramp === 'boolean'
  );
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
