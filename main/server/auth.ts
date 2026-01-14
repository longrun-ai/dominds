/**
 * Module: server/auth
 *
 * Production-safe shared-secret authentication for Dominds.
 *
 * - Dev mode: always disabled.
 * - Prod mode:
 *   - DOMINDS_AUTH_KEY unset: enabled with generated key
 *   - DOMINDS_AUTH_KEY empty string: disabled
 *   - DOMINDS_AUTH_KEY non-empty: enabled with provided key verbatim
 *
 * HTTP: Authorization: Bearer <auth-key>
 * WebSocket: prefers Authorization header, otherwise accepts a token in
 * Sec-WebSocket-Protocol as "dominds-auth.<auth-key>" (plain text).
 */

import * as crypto from 'crypto';
import type { IncomingMessage } from 'http';

export type AuthConfig =
  | { kind: 'disabled' }
  | { kind: 'enabled'; key: string; source: 'env' | 'generated' };

export type AuthCheckResult =
  | { kind: 'ok' }
  | { kind: 'unauthorized'; reason: 'missing' | 'invalid' };

export function computeAuthConfig(params: {
  mode: 'development' | 'production';
  env: NodeJS.ProcessEnv;
}): AuthConfig {
  if (params.mode === 'development') return { kind: 'disabled' };

  const raw = params.env.DOMINDS_AUTH_KEY;
  if (raw === undefined) {
    const key = generateAuthKey();
    // Generated key is base64url, which is safe for WebSocket subprotocol tokens.
    return { kind: 'enabled', key, source: 'generated' };
  }
  if (raw === '') return { kind: 'disabled' };
  if (!isWebSocketSubprotocolTokenSafe(raw)) {
    throw new Error(
      'DOMINDS_AUTH_KEY must be a plain-text token-safe string (RFC 7230 tchar set) so it can be used in WebSocket subprotocols.',
    );
  }
  return { kind: 'enabled', key: raw, source: 'env' };
}

export function isAuthEnabled(auth: AuthConfig): auth is Extract<AuthConfig, { kind: 'enabled' }> {
  return auth.kind === 'enabled';
}

export function getHttpAuthCheck(req: IncomingMessage, auth: AuthConfig): AuthCheckResult {
  if (auth.kind === 'disabled') return { kind: 'ok' };

  const header = getSingleHeaderValue(req.headers.authorization);
  if (!header) return { kind: 'unauthorized', reason: 'missing' };

  const parsed = parseBearerAuthHeader(header);
  if (!parsed) return { kind: 'unauthorized', reason: 'invalid' };

  return constantTimeEqual(parsed.token, auth.key)
    ? { kind: 'ok' }
    : { kind: 'unauthorized', reason: 'invalid' };
}

export function getWebSocketAuthCheck(req: IncomingMessage, auth: AuthConfig): AuthCheckResult {
  if (auth.kind === 'disabled') return { kind: 'ok' };

  // Prefer true Authorization header when available (Node clients can set this).
  const header = getSingleHeaderValue(req.headers.authorization);
  if (header) {
    const parsed = parseBearerAuthHeader(header);
    if (parsed && constantTimeEqual(parsed.token, auth.key)) return { kind: 'ok' };
    return { kind: 'unauthorized', reason: 'invalid' };
  }

  // Browser clients cannot set Authorization; accept an encoded token via subprotocols.
  const protocols = getSingleHeaderValue(req.headers['sec-websocket-protocol']);
  if (!protocols) return { kind: 'unauthorized', reason: 'missing' };

  const token = extractAuthKeyFromWebSocketProtocols(protocols);
  if (!token) return { kind: 'unauthorized', reason: 'invalid' };

  return constantTimeEqual(token, auth.key)
    ? { kind: 'ok' }
    : { kind: 'unauthorized', reason: 'invalid' };
}

export function formatAutoAuthUrl(params: { host: string; port: number; authKey: string }): string {
  const visibleHost = normalizeHostForUrl(params.host);
  return `http://${visibleHost}:${params.port}/?auth=${encodeURIComponent(params.authKey)}`;
}

function normalizeHostForUrl(host: string): string {
  // Binding to 0.0.0.0/:: is common, but not a browsable "host".
  if (host === '0.0.0.0' || host === '::') return 'localhost';
  return host;
}

function generateAuthKey(): string {
  // 256-bit random, base64url output is URL-safe.
  return crypto.randomBytes(32).toString('base64url');
}

function getSingleHeaderValue(value: string | string[] | undefined): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value[0];
  return undefined;
}

function parseBearerAuthHeader(header: string): { token: string } | undefined {
  // Exact scheme match. Do not trim or normalize token; token is opaque.
  const prefix = 'Bearer ';
  if (!header.startsWith(prefix)) return undefined;
  const token = header.slice(prefix.length);
  if (token === '') return undefined;
  return { token };
}

function extractAuthKeyFromWebSocketProtocols(headerValue: string): string | undefined {
  // Header is a comma-separated list.
  const protocols = headerValue
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');

  for (const p of protocols) {
    const decoded = decodeAuthKeyProtocol(p);
    if (decoded) return decoded;
  }
  return undefined;
}

function decodeAuthKeyProtocol(protocol: string): string | undefined {
  const prefix = 'dominds-auth.';
  if (!protocol.startsWith(prefix)) return undefined;
  const key = protocol.slice(prefix.length);
  if (key === '') return undefined;
  if (!isWebSocketSubprotocolTokenSafe(key)) return undefined;
  return key;
}

function isWebSocketSubprotocolTokenSafe(value: string): boolean {
  // WebSocket subprotocols are HTTP tokens. Require RFC 7230 "tchar" only.
  // tchar = "!" / "#" / "$" / "%" / "&" / "'" / "*" / "+" / "-" / "." /
  //         "^" / "_" / "`" / "|" / "~" / DIGIT / ALPHA
  return /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(value);
}

function constantTimeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');

  const maxLen = Math.max(aBuf.length, bBuf.length);
  const aPadded =
    maxLen === aBuf.length ? aBuf : Buffer.concat([aBuf, Buffer.alloc(maxLen - aBuf.length)]);
  const bPadded =
    maxLen === bBuf.length ? bBuf : Buffer.concat([bBuf, Buffer.alloc(maxLen - bBuf.length)]);

  const equal = crypto.timingSafeEqual(aPadded, bPadded);
  return equal && aBuf.length === bBuf.length;
}
