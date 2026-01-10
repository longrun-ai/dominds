import { AuthCredentialsStoreMode, CLIENT_ID, DEFAULT_ISSUER } from '../auth/schema.js';
import { persistTokens, resolveCodexHome } from '../auth/storage.js';
import { sleep } from '../utils/time.js';
import { ensureWorkspaceAllowed } from './browserLogin.js';
import { exchangeCodeForTokens, obtainApiKey } from './tokenExchange.js';

export interface DeviceCode {
  verificationUrl: string;
  userCode: string;
  deviceAuthId: string;
  interval: number;
}

export interface DeviceCodeOptions {
  codexHome?: string;
  issuer?: string;
  clientId?: string;
  forcedChatgptWorkspaceId?: string;
  storeMode?: AuthCredentialsStoreMode;
}

export interface DeviceCodeLoginOptions extends DeviceCodeOptions {
  onDeviceCode?: (code: DeviceCode) => void;
}

export async function requestDeviceCode(options: DeviceCodeOptions = {}): Promise<DeviceCode> {
  const issuer = (options.issuer ?? DEFAULT_ISSUER).replace(/\/$/, '');
  const clientId = options.clientId ?? CLIENT_ID;
  const apiBase = `${issuer}/api/accounts`;

  const response = await fetch(`${apiBase}/deviceauth/usercode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId }),
  });

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(
        'device code login is not enabled for this Codex server. Use the browser login or verify the server URL.',
      );
    }
    throw new Error(`device code request failed with status ${response.status}`);
  }

  const json = (await response.json()) as {
    device_auth_id: string;
    user_code?: string;
    usercode?: string;
    interval?: string | number;
  };

  const intervalValue = parseInterval(json.interval);
  const userCode = json.user_code ?? json.usercode;

  if (!userCode || !json.device_auth_id) {
    throw new Error('device code response missing required fields');
  }

  return {
    verificationUrl: `${issuer}/codex/device`,
    userCode,
    deviceAuthId: json.device_auth_id,
    interval: intervalValue,
  };
}

export async function completeDeviceCodeLogin(
  options: DeviceCodeOptions,
  deviceCode: DeviceCode,
): Promise<void> {
  const codexHome = resolveCodexHome(options.codexHome);
  const issuer = (options.issuer ?? DEFAULT_ISSUER).replace(/\/$/, '');
  const clientId = options.clientId ?? CLIENT_ID;
  const storeMode = options.storeMode ?? 'file';
  const apiBase = `${issuer}/api/accounts`;

  const codeResp = await pollForToken(
    apiBase,
    deviceCode.deviceAuthId,
    deviceCode.userCode,
    deviceCode.interval,
  );

  const redirectUri = `${issuer}/deviceauth/callback`;
  const tokens = await exchangeCodeForTokens(
    issuer,
    clientId,
    redirectUri,
    codeResp.codeVerifier,
    codeResp.authorizationCode,
  );

  ensureWorkspaceAllowed(options.forcedChatgptWorkspaceId, tokens.idToken);

  let apiKey: string | undefined;
  try {
    apiKey = await obtainApiKey(issuer, clientId, tokens.idToken);
  } catch {
    apiKey = undefined;
  }

  persistTokens(
    codexHome,
    apiKey,
    tokens.idToken,
    tokens.accessToken,
    tokens.refreshToken,
    storeMode,
  );
}

export async function runDeviceCodeLogin(
  options: DeviceCodeLoginOptions = {},
): Promise<DeviceCode> {
  const deviceCode = await requestDeviceCode(options);
  options.onDeviceCode?.(deviceCode);
  await completeDeviceCodeLogin(options, deviceCode);
  return deviceCode;
}

async function pollForToken(
  apiBase: string,
  deviceAuthId: string,
  userCode: string,
  interval: number,
): Promise<{
  authorizationCode: string;
  codeVerifier: string;
  codeChallenge: string;
}> {
  const maxWaitMs = 15 * 60 * 1000;
  const start = Date.now();

  while (true) {
    const response = await fetch(`${apiBase}/deviceauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        device_auth_id: deviceAuthId,
        user_code: userCode,
      }),
    });

    if (response.ok) {
      const json = (await response.json()) as {
        authorization_code: string;
        code_verifier: string;
        code_challenge: string;
      };

      return {
        authorizationCode: json.authorization_code,
        codeVerifier: json.code_verifier,
        codeChallenge: json.code_challenge,
      };
    }

    if (response.status === 403 || response.status === 404) {
      if (Date.now() - start >= maxWaitMs) {
        throw new Error('device auth timed out after 15 minutes');
      }
      const remaining = maxWaitMs - (Date.now() - start);
      const sleepFor = Math.min(interval * 1000, remaining);
      await sleep(sleepFor);
      continue;
    }

    throw new Error(`device auth failed with status ${response.status}`);
  }
}

function parseInterval(value: string | number | undefined): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value.trim(), 10);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  return 5;
}
