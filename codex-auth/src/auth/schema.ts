export const DEFAULT_ISSUER = 'https://auth.openai.com';
export const DEFAULT_CHATGPT_BASE_URL = 'https://chatgpt.com/backend-api/';
export const DEFAULT_LOGIN_PORT = 1455;
export const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const DEFAULT_ORIGINATOR = 'codex_cli_rs';
export const CODEX_REFRESH_TOKEN_URL_OVERRIDE_ENV_VAR = 'CODEX_REFRESH_TOKEN_URL_OVERRIDE';
export const CODEX_INTERNAL_ORIGINATOR_OVERRIDE_ENV_VAR = 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE';
export const TOKEN_REFRESH_INTERVAL_DAYS = 8;

export type AuthCredentialsStoreMode = 'file';

export type CodexStoredAuthMode = 'apikey' | 'chatgpt' | 'chatgptAuthTokens' | 'agentIdentity';

export interface TokenDataFile {
  id_token: string;
  access_token: string;
  refresh_token: string;
  account_id?: string;
}

export interface AuthDotJson {
  auth_mode?: CodexStoredAuthMode;
  OPENAI_API_KEY?: string;
  tokens?: TokenDataFile;
  last_refresh?: string;
  agent_identity?: AgentIdentityAuthRecord;
}

export interface AgentIdentityAuthRecord {
  agent_runtime_id: string;
  agent_private_key: string;
  account_id: string;
  chatgpt_user_id: string;
  email: string;
  plan_type: unknown;
  chatgpt_account_is_fedramp: boolean;
}

export interface IdTokenInfo {
  email?: string;
  chatgpt_plan_type?: string;
  chatgpt_user_id?: string;
  chatgpt_account_id?: string;
  chatgpt_account_is_fedramp: boolean;
  raw_jwt: string;
}

export interface TokenData {
  idToken: IdTokenInfo;
  accessToken: string;
  refreshToken: string;
  accountId?: string;
}

export type AuthMode = 'api_key' | 'chatgpt';

export interface AuthState {
  mode: AuthMode;
  apiKey?: string;
  tokens?: TokenData;
  lastRefresh?: Date;
  raw: AuthDotJson;
}

export function resolveAuthDotJsonMode(auth: AuthDotJson): CodexStoredAuthMode {
  const explicitMode: unknown = auth.auth_mode;
  if (explicitMode !== undefined && explicitMode !== null) {
    if (!isCodexStoredAuthMode(explicitMode)) {
      throw new Error(`Unsupported auth.json auth_mode: ${String(explicitMode)}`);
    }
    return explicitMode;
  }
  if (auth.OPENAI_API_KEY) {
    return 'apikey';
  }
  if (auth.agent_identity) {
    return 'agentIdentity';
  }
  return 'chatgpt';
}

export function isCodexStoredAuthMode(value: unknown): value is CodexStoredAuthMode {
  return (
    value === 'apikey' ||
    value === 'chatgpt' ||
    value === 'chatgptAuthTokens' ||
    value === 'agentIdentity'
  );
}
