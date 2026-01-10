import { CLIENT_ID, CODEX_REFRESH_TOKEN_URL_OVERRIDE_ENV_VAR } from '../auth/schema.js';

export type RefreshTokenFailedReason = 'expired' | 'exhausted' | 'revoked' | 'other';

const REFRESH_TOKEN_EXPIRED_MESSAGE =
  'Your access token could not be refreshed because your refresh token has expired. Please log out and sign in again.';
const REFRESH_TOKEN_REUSED_MESSAGE =
  'Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.';
const REFRESH_TOKEN_INVALIDATED_MESSAGE =
  'Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again.';
const REFRESH_TOKEN_UNKNOWN_MESSAGE =
  'Your access token could not be refreshed. Please log out and sign in again.';
const DEFAULT_REFRESH_TOKEN_URL = 'https://auth.openai.com/oauth/token';

export interface RefreshResponse {
  id_token?: string;
  access_token?: string;
  refresh_token?: string;
}

export class RefreshTokenError extends Error {
  readonly kind: 'permanent' | 'transient';
  readonly reason?: RefreshTokenFailedReason;

  constructor(kind: 'permanent' | 'transient', message: string, reason?: RefreshTokenFailedReason) {
    super(message);
    this.kind = kind;
    this.reason = reason;
  }
}

export async function tryRefreshToken(refreshToken: string): Promise<RefreshResponse> {
  const endpoint = refreshTokenEndpoint();
  const body = JSON.stringify({
    client_id: CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    scope: 'openid profile email',
  });

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body,
  });

  if (response.ok) {
    return (await response.json()) as RefreshResponse;
  }

  const text = await response.text();
  if (response.status === 401) {
    const failed = classifyRefreshTokenFailure(text);
    throw new RefreshTokenError('permanent', failed.message, failed.reason);
  }

  const message = tryParseErrorMessage(text);
  throw new RefreshTokenError(
    'transient',
    `Failed to refresh token: ${response.status}: ${message}`,
  );
}

export function refreshTokenEndpoint(): string {
  return process.env[CODEX_REFRESH_TOKEN_URL_OVERRIDE_ENV_VAR] || DEFAULT_REFRESH_TOKEN_URL;
}

function classifyRefreshTokenFailure(body: string): {
  reason: RefreshTokenFailedReason;
  message: string;
} {
  const code = extractRefreshTokenErrorCode(body)?.toLowerCase();

  let reason: RefreshTokenFailedReason = 'other';
  if (code === 'refresh_token_expired') {
    reason = 'expired';
  } else if (code === 'refresh_token_reused') {
    reason = 'exhausted';
  } else if (code === 'refresh_token_invalidated') {
    reason = 'revoked';
  }

  let message = REFRESH_TOKEN_UNKNOWN_MESSAGE;
  if (reason === 'expired') {
    message = REFRESH_TOKEN_EXPIRED_MESSAGE;
  } else if (reason === 'exhausted') {
    message = REFRESH_TOKEN_REUSED_MESSAGE;
  } else if (reason === 'revoked') {
    message = REFRESH_TOKEN_INVALIDATED_MESSAGE;
  }

  return { reason, message };
}

function extractRefreshTokenErrorCode(body: string): string | undefined {
  if (!body.trim()) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }

  if (!parsed || typeof parsed !== 'object') {
    return undefined;
  }

  const record = parsed as Record<string, unknown>;
  const errorValue = record.error;
  if (errorValue && typeof errorValue === 'object' && !Array.isArray(errorValue)) {
    const code = (errorValue as Record<string, unknown>).code;
    if (typeof code === 'string') {
      return code;
    }
  }

  if (typeof errorValue === 'string') {
    return errorValue;
  }

  const code = record.code;
  if (typeof code === 'string') {
    return code;
  }

  return undefined;
}

function tryParseErrorMessage(body: string): string {
  if (!body.trim()) {
    return '';
  }
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const error = parsed.error;
    if (typeof error === 'string') {
      return error;
    }
    if (error && typeof error === 'object') {
      const message = (error as Record<string, unknown>).message;
      if (typeof message === 'string') {
        return message;
      }
    }
  } catch {
    return body;
  }
  return body;
}
