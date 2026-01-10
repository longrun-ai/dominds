import { IdTokenInfo } from '../auth/schema.js';
import { getStringClaim, parseJwtPayload } from '../utils/jwt.js';

export function parseIdToken(idToken: string): IdTokenInfo {
  const payload = parseJwtPayload(idToken);
  const auth =
    payload['https://api.openai.com/auth'] &&
    typeof payload['https://api.openai.com/auth'] === 'object' &&
    !Array.isArray(payload['https://api.openai.com/auth'])
      ? (payload['https://api.openai.com/auth'] as Record<string, unknown>)
      : {};

  const email = getStringClaim(payload.email);
  const chatgptPlan = getStringClaim(auth.chatgpt_plan_type);
  const chatgptAccountId = getStringClaim(auth.chatgpt_account_id);

  return {
    email,
    chatgpt_plan_type: chatgptPlan,
    chatgpt_account_id: chatgptAccountId,
    raw_jwt: idToken,
  };
}

export function extractAccountId(idToken: string): string | undefined {
  return parseIdToken(idToken).chatgpt_account_id;
}
