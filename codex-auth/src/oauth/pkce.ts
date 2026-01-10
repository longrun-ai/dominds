import crypto from 'node:crypto';

import { base64UrlEncode } from '../utils/base64.js';

export interface PkceCodes {
  codeVerifier: string;
  codeChallenge: string;
}

export function generatePkce(): PkceCodes {
  const verifier = base64UrlEncode(crypto.randomBytes(32));
  const challenge = base64UrlEncode(crypto.createHash('sha256').update(verifier).digest());
  return {
    codeVerifier: verifier,
    codeChallenge: challenge,
  };
}

export function generateState(): string {
  return base64UrlEncode(crypto.randomBytes(32));
}
