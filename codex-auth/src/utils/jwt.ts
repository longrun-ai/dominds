import { base64UrlDecode } from './base64.js';

export type JwtClaims = Record<string, unknown>;

export function parseJwtPayload(token: string): JwtClaims {
  const parts = token.split('.');
  if (parts.length < 3 || parts.some((part) => part.length === 0)) {
    throw new Error('invalid JWT format');
  }

  const payload = base64UrlDecode(parts[1]);
  const text = payload.toString('utf8');
  const json = JSON.parse(text) as JwtClaims;
  if (json && typeof json === 'object') {
    return json;
  }
  throw new Error('invalid JWT payload');
}

export function jwtAuthClaims(token: string): Record<string, unknown> {
  try {
    const payload = parseJwtPayload(token);
    const auth = payload['https://api.openai.com/auth'];
    if (auth && typeof auth === 'object' && !Array.isArray(auth)) {
      return auth as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

export function getStringClaim(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  return undefined;
}

export function getBooleanClaim(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') {
    return value;
  }
  return undefined;
}
