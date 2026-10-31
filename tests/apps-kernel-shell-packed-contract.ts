import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  checkConsumerTypes,
  nativeEnv,
  packIntoConsumer,
  repository,
  runNativeConsumer,
  withConsumer,
} from './helpers/packaging/consumer';

async function main(): Promise<void> {
  await withConsumer(async (directory) => {
    const kernel = await packIntoConsumer(directory, path.join(repository, 'packages/kernel'));
    const shell = await packIntoConsumer(directory, path.join(repository, 'packages/shell'));
    assert.equal(kernel.manifest.name, '@longrun-ai/kernel');
    assert.equal(shell.manifest.name, '@longrun-ai/shell');
    assert.equal(shell.manifest.dependencies?.[kernel.manifest.name], kernel.manifest.version);
    await runNativeConsumer(directory, 'kernel.cjs');
    await checkConsumerTypes(
      directory,
      `import { toolSuccess } from '@longrun-ai/kernel';
import type { CreateDomindsAppFn } from '@longrun-ai/kernel/app-host-contract';
import type { DialogLatestFile } from '@longrun-ai/kernel/types/storage';
import type { DialogDisplayState } from '@longrun-ai/kernel/types/display-state';
import type { LanguageCode } from '@longrun-ai/kernel/types/language';
import type { TypedDialogEvent } from '@longrun-ai/kernel/types/dialog';
import type { DialogsQuarantinedMessage } from '@longrun-ai/kernel/types/wire';
import * as shell from '@longrun-ai/shell';
const createApp: CreateDomindsAppFn = async () => ({ tools: {} });
const language: LanguageCode = 'en';
const display: DialogDisplayState = { kind: 'idle_waiting_user' };
const latest: Pick<DialogLatestFile, 'displayState'> = { displayState: display };
const output = toolSuccess('supplied-data');
const outcome: 'success' | 'failure' | 'partial_failure' | undefined = output.outcome;
void [createApp, language, latest, outcome, shell];
const acceptsEvents = (event: TypedDialogEvent | DialogsQuarantinedMessage) => event.type;
void acceptsEvents;
`,
    );
    // Removing the entire shipped package must defeat fresh native/runtime and type
    // consumers. A missing preferred .ts file alone may legitimately use packed declarations.
    await fs.rename(kernel.root, `${kernel.root}.held`);
    const probe = path.join(directory, 'missing-runtime.cjs');
    await fs.writeFile(probe, "require('@longrun-ai/kernel');\n");
    assert.throws(
      () =>
        execFileSync(process.execPath, [probe], {
          cwd: directory,
          env: nativeEnv,
          stdio: 'pipe',
          timeout: 10000,
        }),
      { status: 1, signal: null },
    );
    await assert.rejects(
      checkConsumerTypes(
        directory,
        "import { toolSuccess } from '@longrun-ai/kernel'; void toolSuccess;",
      ),
      { status: 2, signal: null },
    );
    await fs.rename(`${kernel.root}.held`, kernel.root);
  });
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
