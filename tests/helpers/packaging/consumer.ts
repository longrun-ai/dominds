import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const repository = path.resolve(__dirname, '../../..');
export type PackedManifest = {
  name: string;
  version: string;
  bin?: Record<string, string>;
  dependencies?: Record<string, string>;
};
export const nativeEnv = { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' };

export async function withConsumer(action: (directory: string) => Promise<void>): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-packed-consumer-'));
  try {
    await fs.writeFile(path.join(directory, 'package.json'), '{"private":true,"type":"commonjs"}');
    await action(directory);
  } catch (error) {
    console.error(`Packed consumer evidence retained: ${directory}`);
    throw error;
  }
  if (process.env.DOMINDS_TEST_RTWS_KEEP_TMP !== '1')
    await fs.rm(directory, { recursive: true, force: true });
}

export async function packIntoConsumer(
  directory: string,
  packageRoot: string,
): Promise<{ root: string; manifest: PackedManifest }> {
  const packDirectory = await fs.mkdtemp(path.join(directory, 'pack-'));
  execFileSync('pnpm', ['pack', '--pack-destination', packDirectory], {
    cwd: packageRoot,
    env: nativeEnv,
    stdio: 'pipe',
  });
  const tarballs = (await fs.readdir(packDirectory)).filter((file) => file.endsWith('.tgz'));
  assert.equal(tarballs.length, 1);
  const unpackDirectory = path.join(packDirectory, 'unpacked');
  await fs.mkdir(unpackDirectory);
  execFileSync('tar', ['-xzf', path.join(packDirectory, tarballs[0]!), '-C', unpackDirectory], {
    stdio: 'pipe',
  });
  const extracted = path.join(unpackDirectory, 'package');
  const manifest: PackedManifest = JSON.parse(
    await fs.readFile(path.join(extracted, 'package.json'), 'utf8'),
  );
  assert.equal(typeof manifest.name, 'string');
  assert.equal(typeof manifest.version, 'string');
  const root = path.join(directory, 'node_modules', manifest.name);
  await fs.mkdir(path.dirname(root), { recursive: true });
  await fs.rename(extracted, root);
  return { root, manifest };
}

// Supplied third-party dependencies come from the existing lock/install. Workspace packages
// themselves must come from tarballs, never workspace links. This is not a registry install.
export async function linkExternalDependencies(
  directory: string,
  packageRoot: string,
  manifest: PackedManifest,
  packedNames: ReadonlySet<string>,
): Promise<void> {
  const sourceManifest: PackedManifest = JSON.parse(
    await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8'),
  );
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    if (packedNames.has(name)) continue;
    assert.equal(
      sourceManifest.dependencies?.[name]?.startsWith('workspace:'),
      false,
      `workspace dependency ${name} must be supplied as its own tarball`,
    );
    const target = await fs.realpath(path.join(packageRoot, 'node_modules', name));
    const link = path.join(directory, 'node_modules', name);
    await fs.mkdir(path.dirname(link), { recursive: true });
    await fs.symlink(target, link, 'junction');
  }
}

export async function runNativeConsumer(directory: string, fixture: string): Promise<void> {
  const script = path.join(directory, path.basename(fixture));
  await fs.copyFile(path.join(__dirname, fixture), script);
  const output = execFileSync(process.execPath, [script], {
    cwd: directory,
    env: { ...nativeEnv, PATH: '' },
    encoding: 'utf8',
    timeout: 15000,
    maxBuffer: 2 * 1024 * 1024,
  });
  // An unresolved async main can exit zero when Node has no live handles. Require an
  // explicit machine completion packet after every native consumer action has finished.
  const completions = output.split('\n').flatMap((line) => {
    try {
      const packet: unknown = JSON.parse(line);
      return packet !== null &&
        typeof packet === 'object' &&
        'probe' in packet &&
        packet.probe === 'packed-consumer-complete'
        ? [packet]
        : [];
    } catch {
      return [];
    }
  });
  assert.deepEqual(completions, [{ probe: 'packed-consumer-complete', fixture }]);
  process.stdout.write(output);
}

export async function checkConsumerTypes(directory: string, source: string): Promise<void> {
  await fs.writeFile(path.join(directory, 'consumer.ts'), source);
  await fs.writeFile(
    path.join(directory, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        target: 'ES2022',
        lib: ['ES2022', 'DOM'],
        types: [],
        skipLibCheck: false,
      },
      include: ['consumer.ts'],
    }),
  );
  execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', directory], {
    cwd: directory,
    env: nativeEnv,
    stdio: 'pipe',
    timeout: 15000,
  });
}
