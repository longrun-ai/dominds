export const DEFAULT_ISSUER = 'https://auth.openai.com';
export const DEFAULT_CHATGPT_BASE_URL = 'https://chatgpt.com/backend-api/';
export const DEFAULT_LOGIN_PORT = 1455;
export const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const CODEX_APP_SERVER_LOGIN_CLIENT_ID_ENV_VAR = 'CODEX_APP_SERVER_LOGIN_CLIENT_ID';
export const DEFAULT_ORIGINATOR = 'codex_cli_rs';
export const CODEX_REFRESH_TOKEN_URL_OVERRIDE_ENV_VAR = 'CODEX_REFRESH_TOKEN_URL_OVERRIDE';
export const CODEX_AUTHAPI_BASE_URL_ENV_VAR = 'CODEX_AUTHAPI_BASE_URL';
export const CODEX_INTERNAL_ORIGINATOR_OVERRIDE_ENV_VAR = 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE';
export const TOKEN_REFRESH_INTERVAL_DAYS = 8;
export const CHATGPT_ACCESS_TOKEN_REFRESH_WINDOW_MINUTES = 5;
export const CODEX_API_KEY_ENV_VAR = 'CODEX_API_KEY';
export const CODEX_ACCESS_TOKEN_ENV_VAR = 'CODEX_ACCESS_TOKEN';

export type AuthCredentialsStoreMode = 'file' | 'keyring' | 'auto' | 'ephemeral';
export type AuthKeyringBackendKind = 'direct' | 'secrets';

export type CodexStoredAuthMode =
  | 'apikey'
  | 'chatgpt'
  | 'chatgptAuthTokens'
  | 'headers'
  | 'agentIdentity'
  | 'personalAccessToken'
  | 'bedrockApiKey';

export type AccountPlanType =
  | 'free'
  | 'go'
  | 'plus'
  | 'pro'
  | 'prolite'
  | 'team'
  | 'self_serve_business_usage_based'
  | 'business'
  | 'enterprise_cbp_usage_based'
  | 'enterprise'
  | 'edu'
  | 'unknown'
  | (string & {});

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
  agent_identity?: AgentIdentityStorage;
  personal_access_token?: string;
  bedrock_api_key?: BedrockApiKeyAuth;
}

export interface AgentIdentityAuthRecord {
  agent_runtime_id: string;
  agent_private_key: string;
  account_id: string;
  chatgpt_user_id: string;
  email?: string;
  plan_type: AccountPlanType;
  chatgpt_account_is_fedramp: boolean;
  task_id?: string;
}

export type AgentIdentityStorage = string | AgentIdentityAuthRecord;

export interface BedrockApiKeyAuth {
  api_key: string;
  region: string;
}

export interface IdTokenInfo {
  email?: string;
  chatgpt_plan_type?: AccountPlanType;
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

export interface PersonalAccessTokenMetadata {
  email?: string;
  chatgpt_user_id: string;
  chatgpt_account_id: string;
  chatgpt_plan_type: AccountPlanType;
  chatgpt_account_is_fedramp: boolean;
}

export type AuthMode =
  | 'api_key'
  | 'chatgpt'
  | 'chatgpt_auth_tokens'
  | 'headers'
  | 'agent_identity'
  | 'personal_access_token'
  | 'bedrock_api_key';

export type AuthState =
  | {
      mode: 'api_key';
      apiKey: string;
      lastRefresh?: Date;
      raw: AuthDotJson;
    }
  | {
      mode: 'chatgpt';
      tokens: TokenData;
      lastRefresh?: Date;
      raw: AuthDotJson;
    }
  | {
      mode: 'chatgpt_auth_tokens';
      tokens: TokenData;
      lastRefresh?: Date;
      raw: AuthDotJson;
    }
  | {
      mode: 'headers';
      headers: Record<string, string>;
    }
  | {
      mode: 'agent_identity';
      agentIdentity: AgentIdentityStorage;
      agentIdentityRecord: AgentIdentityAuthRecord;
      raw: AuthDotJson;
    }
  | {
      mode: 'personal_access_token';
      personalAccessToken: string;
      metadata?: PersonalAccessTokenMetadata;
      raw: AuthDotJson;
    }
  | {
      mode: 'bedrock_api_key';
      bedrockApiKey: BedrockApiKeyAuth;
      raw: AuthDotJson;
    };

export function resolveAuthDotJsonMode(auth: AuthDotJson): CodexStoredAuthMode {
  const explicitMode: unknown = auth.auth_mode;
  if (explicitMode !== undefined && explicitMode !== null) {
    if (!isCodexStoredAuthMode(explicitMode)) {
      throw new Error(`Unsupported auth.json auth_mode: ${String(explicitMode)}`);
    }
    return explicitMode;
  }
  if (auth.personal_access_token) {
    return 'personalAccessToken';
  }
  if (auth.bedrock_api_key) {
    return 'bedrockApiKey';
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
    value === 'headers' ||
    value === 'agentIdentity' ||
    value === 'personalAccessToken' ||
    value === 'bedrockApiKey'
  );
}

export function storedAuthModeToStateMode(mode: CodexStoredAuthMode): AuthMode {
  switch (mode) {
    case 'apikey':
      return 'api_key';
    case 'chatgpt':
      return 'chatgpt';
    case 'chatgptAuthTokens':
      return 'chatgpt_auth_tokens';
    case 'headers':
      return 'headers';
    case 'agentIdentity':
      return 'agent_identity';
    case 'personalAccessToken':
      return 'personal_access_token';
    case 'bedrockApiKey':
      return 'bedrock_api_key';
    default: {
      const _exhaustive: never = mode;
      throw new Error(`Unhandled auth mode: ${String(_exhaustive)}`);
    }
  }
}

export function authModeHasChatGptAccount(mode: AuthMode): boolean {
  switch (mode) {
    case 'chatgpt':
    case 'chatgpt_auth_tokens':
    case 'personal_access_token':
      return true;
    case 'api_key':
    case 'headers':
    case 'agent_identity':
    case 'bedrock_api_key':
      return false;
    default: {
      const _exhaustive: never = mode;
      throw new Error(`Unhandled auth mode: ${String(_exhaustive)}`);
    }
  }
}

export function authModeUsesCodexBackend(mode: AuthMode): boolean {
  switch (mode) {
    case 'chatgpt':
    case 'chatgpt_auth_tokens':
    case 'headers':
    case 'agent_identity':
    case 'personal_access_token':
      return true;
    case 'api_key':
    case 'bedrock_api_key':
      return false;
    default: {
      const _exhaustive: never = mode;
      throw new Error(`Unhandled auth mode: ${String(_exhaustive)}`);
    }
  }
}

export function oauthClientId(): string {
  const override = process.env[CODEX_APP_SERVER_LOGIN_CLIENT_ID_ENV_VAR]?.trim();
  return override && override.length > 0 ? override : CLIENT_ID;
}

export function normalizeAccountPlanType(value: string | undefined): AccountPlanType | undefined {
  if (value === undefined) {
    return undefined;
  }
  switch (value.toLowerCase()) {
    case 'free':
      return 'free';
    case 'go':
      return 'go';
    case 'plus':
      return 'plus';
    case 'pro':
      return 'pro';
    case 'prolite':
      return 'prolite';
    case 'team':
      return 'team';
    case 'self_serve_business_usage_based':
      return 'self_serve_business_usage_based';
    case 'business':
      return 'business';
    case 'enterprise_cbp_usage_based':
      return 'enterprise_cbp_usage_based';
    case 'enterprise':
    case 'hc':
      return 'enterprise';
    case 'education':
    case 'edu':
      return 'edu';
    default:
      // codex-rs preserves unrecognized plan strings so newer server-side plans remain visible
      // to older clients instead of being collapsed into an indistinguishable sentinel.
      return value;
  }
}
