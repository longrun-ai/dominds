import http from 'node:http';
import net from 'node:net';
import { URL } from 'node:url';

import {
  AuthCredentialsStoreMode,
  CLIENT_ID,
  CODEX_INTERNAL_ORIGINATOR_OVERRIDE_ENV_VAR,
  DEFAULT_ISSUER,
  DEFAULT_LOGIN_PORT,
  DEFAULT_ORIGINATOR,
} from '../auth/schema.js';
import { persistTokens, resolveCodexHome } from '../auth/storage.js';
import { getBooleanClaim, getStringClaim, jwtAuthClaims } from '../utils/jwt.js';
import { openBrowser } from '../utils/openBrowser.js';
import { generatePkce, generateState } from './pkce.js';
import { exchangeCodeForTokens, obtainApiKey } from './tokenExchange.js';
import { parseIdToken } from './tokenParsing.js';

export interface BrowserLoginOptions {
  codexHome?: string;
  clientId?: string;
  issuer?: string;
  port?: number;
  openBrowser?: boolean;
  forceState?: string;
  forcedChatgptWorkspaceId?: string;
  storeMode?: AuthCredentialsStoreMode;
  originator?: string;
}

export interface LoginServer {
  authUrl: string;
  actualPort: number;
  waitForCompletion(): Promise<void>;
  cancel(): Promise<void>;
}

export async function runLoginServer(options: BrowserLoginOptions = {}): Promise<LoginServer> {
  const codexHome = resolveCodexHome(options.codexHome);
  const clientId = options.clientId ?? CLIENT_ID;
  const issuer = (options.issuer ?? DEFAULT_ISSUER).replace(/\/$/, '');
  const port = options.port ?? DEFAULT_LOGIN_PORT;
  const openInBrowser = options.openBrowser ?? true;
  const storeMode = options.storeMode ?? 'file';
  const originator =
    options.originator ??
    process.env[CODEX_INTERNAL_ORIGINATOR_OVERRIDE_ENV_VAR] ??
    DEFAULT_ORIGINATOR;

  const pkce = generatePkce();
  const state = options.forceState ?? generateState();

  const { server, actualPort } = await bindServer(port);
  const redirectUri = `http://localhost:${actualPort}/auth/callback`;
  const authUrl = buildAuthorizeUrl(
    issuer,
    clientId,
    redirectUri,
    pkce,
    state,
    options.forcedChatgptWorkspaceId,
    originator,
  );

  if (openInBrowser) {
    openBrowser(authUrl);
  }

  const completion = createCompletion();

  server.on('request', async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (url.pathname === '/auth/callback') {
      try {
        const queryState = url.searchParams.get('state');
        if (queryState !== state) {
          respondPlain(res, 400, 'State mismatch');
          return;
        }
        const code = url.searchParams.get('code');
        if (!code) {
          respondPlain(res, 400, 'Missing authorization code');
          return;
        }

        const tokens = await exchangeCodeForTokens(
          issuer,
          clientId,
          redirectUri,
          pkce.codeVerifier,
          code,
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

        const successUrl = composeSuccessUrl(
          actualPort,
          issuer,
          tokens.idToken,
          tokens.accessToken,
        );
        res.statusCode = 302;
        res.setHeader('Location', successUrl);
        res.setHeader('Connection', 'close');
        res.end();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        respondPlain(res, 500, `Token exchange failed: ${message}`);
      }
      return;
    }

    if (url.pathname === '/success') {
      respondHtml(res, 200, successHtml());
      completion.resolve();
      server.close();
      return;
    }

    if (url.pathname === '/cancel') {
      respondPlain(res, 200, 'Login cancelled');
      completion.reject(new Error('Login cancelled'));
      server.close();
      return;
    }

    respondPlain(res, 404, 'Not Found');
  });

  return {
    authUrl,
    actualPort,
    waitForCompletion: () => completion.promise,
    cancel: async () => {
      await sendCancelRequest(actualPort);
    },
  };
}

function createCompletion(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (err: Error) => void;
} {
  let resolve: () => void;
  let reject: (err: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve: resolve!, reject: reject! };
}

async function bindServer(port: number): Promise<{ server: http.Server; actualPort: number }> {
  const maxAttempts = 10;
  const retryDelayMs = 200;
  let cancelAttempted = false;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const server = http.createServer();
    const result = await new Promise<{
      server: http.Server;
      actualPort: number;
    }>((resolve, reject) => {
      server.once('error', (err) => {
        reject(err);
      });
      server.listen(port, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') {
          reject(new Error('Unable to determine the server port'));
          return;
        }
        resolve({ server, actualPort: address.port });
      });
    }).catch(async (err) => {
      if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        if (!cancelAttempted) {
          cancelAttempted = true;
          await sendCancelRequest(port);
        }
        await sleep(retryDelayMs);
        return null;
      }
      throw err;
    });

    if (result) {
      return result;
    }
  }

  throw new Error(`Port 127.0.0.1:${port} is already in use`);
}

function respondPlain(res: http.ServerResponse, status: number, body: string) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Connection', 'close');
  res.end(body);
}

function respondHtml(res: http.ServerResponse, status: number, body: string) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Connection', 'close');
  res.end(body);
}

function successHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Codex login complete</title>
    <style>
      body { font-family: system-ui, -apple-system, sans-serif; margin: 40px; }
      h1 { font-size: 20px; }
      p { color: #555; }
    </style>
  </head>
  <body>
    <h1>Signed in</h1>
    <p>You can return to the terminal.</p>
  </body>
</html>`;
}

export function buildAuthorizeUrl(
  issuer: string,
  clientId: string,
  redirectUri: string,
  pkce: { codeVerifier: string; codeChallenge: string },
  state: string,
  forcedChatgptWorkspaceId?: string,
  originator?: string,
): string {
  const query: Record<string, string> = {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: 'openid profile email offline_access',
    code_challenge: pkce.codeChallenge,
    code_challenge_method: 'S256',
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    state,
    originator: originator ?? DEFAULT_ORIGINATOR,
  };

  if (forcedChatgptWorkspaceId) {
    query.allowed_workspace_id = forcedChatgptWorkspaceId;
  }

  const qs = new URLSearchParams(query);
  return `${issuer}/oauth/authorize?${qs.toString()}`;
}

async function sendCancelRequest(port: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const client = net.connect({ host: '127.0.0.1', port }, () => {
      client.write(`GET /cancel HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
    });
    client.setTimeout(2000, () => {
      client.destroy();
      resolve();
    });
    client.on('error', () => resolve());
    client.on('close', () => resolve());
  });
}

export function ensureWorkspaceAllowed(expected: string | undefined, idToken: string): void {
  if (!expected) {
    return;
  }

  const info = parseIdToken(idToken);
  const actual = info.chatgpt_account_id;
  if (!actual) {
    throw new Error(
      'Login is restricted to a specific workspace, but the token did not include an chatgpt_account_id claim.',
    );
  }
  if (actual !== expected) {
    throw new Error(`Login is restricted to workspace id ${expected}.`);
  }
}

function composeSuccessUrl(
  port: number,
  issuer: string,
  idToken: string,
  accessToken: string,
): string {
  const tokenClaims = jwtAuthClaims(idToken);
  const accessClaims = jwtAuthClaims(accessToken);

  const orgId = getStringClaim(tokenClaims.organization_id) ?? '';
  const projectId = getStringClaim(tokenClaims.project_id) ?? '';
  const completed = getBooleanClaim(tokenClaims.completed_platform_onboarding) ?? false;
  const isOwner = getBooleanClaim(tokenClaims.is_org_owner) ?? false;
  const needsSetup = !completed && isOwner;
  const planType = getStringClaim(accessClaims.chatgpt_plan_type) ?? '';

  const platformUrl =
    issuer === DEFAULT_ISSUER ? 'https://platform.openai.com' : 'https://platform.api.openai.org';

  const params = new URLSearchParams({
    id_token: idToken,
    needs_setup: String(needsSetup),
    org_id: orgId,
    project_id: projectId,
    plan_type: planType,
    platform_url: platformUrl,
  });

  return `http://localhost:${port}/success?${params.toString()}`;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
