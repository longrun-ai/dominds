import { IdTokenInfo } from '../auth/schema.js';
import { getBooleanClaim, getStringClaim, parseJwtPayload } from '../utils/jwt.js';

export function parseIdToken(idToken: string): IdTokenInfo {
  const payload = parseJwtPayload(idToken);
  const auth =
    payload['https://api.openai.com/auth'] &&
    typeof payload['https://api.openai.com/auth'] === 'object' &&
    !Array.isArray(payload['https://api.openai.com/auth'])
      ? (payload['https://api.openai.com/auth'] as Record<string, unknown>)
      : {};

  const profile =
    payload['https://api.openai.com/profile'] &&
    typeof payload['https://api.openai.com/profile'] === 'object' &&
    !Array.isArray(payload['https://api.openai.com/profile'])
      ? (payload['https://api.openai.com/profile'] as Record<string, unknown>)
      : {};

  const email = getStringClaim(payload.email) ?? getStringClaim(profile.email);
  const chatgptPlan = getStringClaim(auth.chatgpt_plan_type);
  const chatgptUserId = getStringClaim(auth.chatgpt_user_id) ?? getStringClaim(auth.user_id);
  const chatgptAccountId = getStringClaim(auth.chatgpt_account_id);
  const chatgptAccountIsFedramp = getBooleanClaim(auth.chatgpt_account_is_fedramp) ?? false;

  return {
    email,
    chatgpt_plan_type: chatgptPlan,
    chatgpt_user_id: chatgptUserId,
    chatgpt_account_id: chatgptAccountId,
    chatgpt_account_is_fedramp: chatgptAccountIsFedramp,
    raw_jwt: idToken,
  };
}

export function extractAccountId(idToken: string): string | undefined {
  return parseIdToken(idToken).chatgpt_account_id;
}
