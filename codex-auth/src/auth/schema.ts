export const DEFAULT_ISSUER = 'https://auth.openai.com';
export const DEFAULT_CHATGPT_BASE_URL = 'https://chatgpt.com/backend-api/';
export const DEFAULT_LOGIN_PORT = 1455;
export const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const DEFAULT_ORIGINATOR = 'codex_cli_rs';
export const CODEX_REFRESH_TOKEN_URL_OVERRIDE_ENV_VAR = 'CODEX_REFRESH_TOKEN_URL_OVERRIDE';
export const CODEX_INTERNAL_ORIGINATOR_OVERRIDE_ENV_VAR = 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE';
export const TOKEN_REFRESH_INTERVAL_DAYS = 8;

export type AuthCredentialsStoreMode = 'file';

export interface TokenDataFile {
  id_token: string;
  access_token: string;
  refresh_token: string;
  account_id?: string;
}

export interface AuthDotJson {
  OPENAI_API_KEY?: string;
  tokens?: TokenDataFile;
  last_refresh?: string;
}

export interface IdTokenInfo {
  email?: string;
  chatgpt_plan_type?: string;
  chatgpt_account_id?: string;
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
