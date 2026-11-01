import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';

let fixtureFailure: WebDevFixtureSetupError | undefined;
let selectedRoot: string | undefined;
let selectedIdentity: Readonly<{ root: string; packageJsonSha256: string }> | undefined;

export class WebDevFixtureSetupError extends Error {
  constructor(
    readonly stage: 'prepare' | 'load-entry' | 'host-contract' | 'adapter-contract',
    cause: unknown,
  ) {
    super('External Web Dev fixture setup failed: ' + stage, { cause });
    fixtureFailure ??= this;
  }
}

export function webDevPackageRoot(): string {
  if (!selectedRoot)
    throw new Error('Select the external Web Dev component before executing its cases');
  return selectedRoot;
}

export function webDevComponentIdentity() {
  if (!selectedIdentity) throw new Error('External Web Dev component identity is unavailable');
  return selectedIdentity;
}

async function selectComponent(): Promise<boolean> {
  const raw = process.env.DOMINDS_TEST_WEB_DEV_PACKAGE_ROOT;
  const skip = (code: string, detail: string) => {
    console.log(JSON.stringify({ status: 'skipped', code, detail, componentLoadAttempted: false }));
    process.exitCode = 77;
    return false;
  };
  if (!raw)
    return skip(
      'external_component_root_required',
      'UNEXECUTED: set DOMINDS_TEST_WEB_DEV_PACKAGE_ROOT to an absolute, already available Web Dev component package directory. No component code or browser was loaded.',
    );
  if (!path.isAbsolute(raw))
    throw new Error('DOMINDS_TEST_WEB_DEV_PACKAGE_ROOT must be an absolute package directory');
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(path.join(raw, 'package.json'));
  } catch (error) {
    if (
      typeof error !== 'object' ||
      error === null ||
      !('code' in error) ||
      (error.code !== 'ENOENT' && error.code !== 'EACCES')
    )
      throw error;
    return skip(
      'external_component_unavailable',
      'UNEXECUTED: the configured package.json is missing or unreadable at ' +
        path.join(raw, 'package.json') +
        '. Supply an existing built component; this test does not install dependencies.',
    );
  }
  const info: unknown = JSON.parse(bytes.toString('utf8'));
  if (typeof info !== 'object' || info === null || Array.isArray(info))
    throw new Error('Configured external package.json must contain an object');
  selectedRoot = raw;
  selectedIdentity = {
    root: raw,
    packageJsonSha256: createHash('sha256').update(bytes).digest('hex'),
  };
  return true;
}

/** Explicit component prerequisite and a completion boundary; neither skips nor pending work pass. */
export function runExternalWebDevScenario(scenario: () => Promise<void>): void {
  let complete = false;
  process.once('beforeExit', () => {
    if (!complete) {
      console.error('External Web Dev scenario exited before its completion boundary');
      process.exitCode = 1;
    }
  });
  (async () => {
    if (!(await selectComponent())) {
      complete = true;
      return;
    }
    await scenario();
    if (fixtureFailure) throw fixtureFailure;
    complete = true;
  })().catch((error: unknown) => {
    complete = true;
    console.error(error);
    process.exitCode = 1;
  });
}

export async function rejectWebDevAction(action: () => Promise<unknown>): Promise<Error> {
  let failure: unknown;
  try {
    await action();
  } catch (error) {
    failure = error;
  }
  // A component may wrap a fixture error; retain its origin outside the thrown object.
  if (fixtureFailure) throw fixtureFailure;
  assert.ok(failure instanceof Error, 'The selected component operation must reject');
  assert.equal(
    failure instanceof WebDevFixtureSetupError,
    false,
    'Fixture preparation/import failure is not a component rejection',
  );
  return failure;
}
