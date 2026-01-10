import { RefreshTokenError, tryRefreshToken } from '../oauth/refresh.js';
import { parseIdToken } from '../oauth/tokenParsing.js';
import {
  AuthCredentialsStoreMode,
  AuthState,
  TOKEN_REFRESH_INTERVAL_DAYS,
  TokenData,
} from './schema.js';
import { readAuthFile, resolveCodexHome, updateStoredTokens } from './storage.js';

export interface AuthManagerOptions {
  codexHome?: string;
  storeMode?: AuthCredentialsStoreMode;
}

export class AuthManager {
  private readonly codexHome: string;
  private readonly storeMode: AuthCredentialsStoreMode;
  private cached: AuthState | null;

  constructor(options: AuthManagerOptions = {}) {
    this.codexHome = resolveCodexHome(options.codexHome);
    this.storeMode = options.storeMode ?? 'file';
    this.cached = this.loadAuthFromStorage();
  }

  authCached(): AuthState | null {
    return this.cached;
  }

  async auth(): Promise<AuthState | null> {
    if (!this.cached) {
      return null;
    }

    try {
      await this.refreshIfStale();
    } catch {
      return this.cached;
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

    if (this.cached.mode === 'api_key') {
      if (!this.cached.apiKey) {
        throw new Error('API key is not available.');
      }
      return this.cached.apiKey;
    }

    const token = this.cached.tokens?.accessToken;
    if (!token) {
      throw new Error('Token data is not available.');
    }
    return token;
  }

  getTokenData(): TokenData {
    if (!this.cached || this.cached.mode !== 'chatgpt' || !this.cached.tokens) {
      throw new Error('Token data is not available.');
    }
    return this.cached.tokens;
  }

  getAccountId(): string | undefined {
    return this.cached?.tokens?.accountId;
  }

  createUnauthorizedRecovery(): UnauthorizedRecovery {
    return new UnauthorizedRecovery(this);
  }

  async refreshToken(): Promise<void> {
    if (!this.cached || this.cached.mode !== 'chatgpt') {
      return;
    }

    const refreshToken = this.cached.tokens?.refreshToken;
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

    const lastRefresh = this.cached.lastRefresh;
    if (!lastRefresh) {
      return false;
    }

    const cutoff = Date.now() - TOKEN_REFRESH_INTERVAL_DAYS * 24 * 60 * 60 * 1000;
    if (lastRefresh.getTime() >= cutoff) {
      return false;
    }

    const refreshToken = this.cached.tokens?.refreshToken;
    if (!refreshToken) {
      return false;
    }

    await this.refreshTokens(refreshToken);
    this.reload();
    return true;
  }

  reloadIfAccountIdMatches(expectedAccountId?: string): boolean {
    if (!expectedAccountId) {
      return false;
    }

    const next = this.loadAuthFromStorage();
    const newAccountId = next?.tokens?.accountId;
    if (newAccountId !== expectedAccountId) {
      return false;
    }

    this.cached = next;
    return true;
  }

  private loadAuthFromStorage(): AuthState | null {
    const auth = readAuthFile(this.codexHome, this.storeMode);
    if (!auth) {
      return null;
    }

    if (auth.OPENAI_API_KEY) {
      return {
        mode: 'api_key',
        apiKey: auth.OPENAI_API_KEY,
        lastRefresh: parseLastRefresh(auth.last_refresh),
        raw: auth,
      };
    }

    if (auth.tokens) {
      const idTokenInfo = parseIdToken(auth.tokens.id_token);
      const tokens: TokenData = {
        idToken: idTokenInfo,
        accessToken: auth.tokens.access_token,
        refreshToken: auth.tokens.refresh_token,
        accountId: auth.tokens.account_id ?? idTokenInfo.chatgpt_account_id,
      };
      return {
        mode: 'chatgpt',
        tokens,
        lastRefresh: parseLastRefresh(auth.last_refresh),
        raw: auth,
      };
    }

    return null;
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
}

export class UnauthorizedRecovery {
  private step: 'reload' | 'refresh' | 'done' = 'reload';
  private readonly expectedAccountId?: string;

  constructor(private readonly manager: AuthManager) {
    this.expectedAccountId = manager.getAccountId();
  }

  hasNext(): boolean {
    const auth = this.manager.authCached();
    if (!auth || auth.mode !== 'chatgpt') {
      return false;
    }
    return this.step !== 'done';
  }

  async next(): Promise<void> {
    if (!this.hasNext()) {
      throw new RefreshTokenError('permanent', 'No more recovery steps available.');
    }

    if (this.step === 'reload') {
      const reloaded = this.manager.reloadIfAccountIdMatches(this.expectedAccountId);
      if (reloaded) {
        this.step = 'refresh';
      } else {
        await this.manager.refreshToken();
        this.step = 'done';
      }
      return;
    }

    if (this.step === 'refresh') {
      await this.manager.refreshToken();
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
  if (a.mode === 'api_key') {
    return a.apiKey === b.apiKey;
  }
  return a.tokens?.accessToken === b.tokens?.accessToken;
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
