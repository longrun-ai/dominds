import assert from 'node:assert/strict';
import path from 'node:path';
import {
  checkConsumerTypes,
  linkExternalDependencies,
  packIntoConsumer,
  repository,
  runNativeConsumer,
  withConsumer,
} from './helpers/packaging/consumer';

async function main(): Promise<void> {
  await withConsumer(async (directory) => {
    const root = await packIntoConsumer(directory, repository);
    const kernel = await packIntoConsumer(directory, path.join(repository, 'packages/kernel'));
    const shell = await packIntoConsumer(directory, path.join(repository, 'packages/shell'));
    const auth = await packIntoConsumer(directory, path.join(repository, 'codex-auth'));
    assert.equal(root.manifest.name, 'dominds');
    const packed = [kernel, shell, auth];
    for (const dependency of packed)
      assert.equal(
        root.manifest.dependencies?.[dependency.manifest.name],
        dependency.manifest.version,
        'packed workspace dependencies must have installable versions',
      );
    const names = new Set([root, ...packed].map((p) => p.manifest.name));
    await linkExternalDependencies(directory, repository, root.manifest, names);
    await linkExternalDependencies(
      directory,
      path.join(repository, 'codex-auth'),
      auth.manifest,
      names,
    );
    await runNativeConsumer(directory, 'root.cjs');
    await checkConsumerTypes(
      directory,
      `import { main } from 'dominds/cli';
const launch: (argv?: readonly string[]) => Promise<void> = main;
void launch;
`,
    );
  });
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
