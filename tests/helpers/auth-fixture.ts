import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/** Only explicit AuthManager options use these profiles; HOME/CODEX_HOME stay user-owned. */
export function makeAuthProfile(): string {
  assert.equal(process.env.DOMINDS_TEST_RTWS_MANAGED, '1', 'run through tests/cli.ts');
  return fs.mkdtempSync(path.join(process.cwd(), '.auth-profile-'));
}
export function makeAuthJwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.sig`;
}
export function captureAuthError(action: () => unknown): Error {
  let failure: unknown;
  try {
    action();
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof Error, 'the operation must reject');
  return failure;
}
export async function captureAsyncAuthError(action: () => Promise<unknown>): Promise<Error> {
  let failure: unknown;
  try {
    await action();
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof Error, 'the asynchronous operation must reject');
  return failure;
}
