import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import YAML from 'yaml';

import { loadAppLockFile } from '../main/apps/app-lock-file';
import { loadAppsConfigurationFile } from '../main/apps/configuration-file';
import { loadDomindsAppManifest } from '../main/apps/manifest';
import { loadAppsResolutionFile } from '../main/apps/resolution-file';
import { Team } from '../main/team';
import '../main/tools/builtins';

type ExecResult = Readonly<{ code: number; stdout: string; stderr: string }>;

async function writeText(filePathAbs: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePathAbs), { recursive: true });
  await fs.writeFile(filePathAbs, content, 'utf-8');
}

async function canonicalPath(pathAbs: string): Promise<string> {
  try {
    return await fs.realpath(pathAbs);
  } catch {
    return path.resolve(pathAbs);
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function runTsCli(params: {
  tsconfigAbs: string;
  scriptAbs: string;
  args: ReadonlyArray<string>;
  cwdAbs: string;
}): Promise<ExecResult> {
  return await new Promise<ExecResult>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        require.resolve('tsx/cli'),
        '--tsconfig',
        params.tsconfigAbs,
        params.scriptAbs,
        ...params.args,
      ],
      {
        cwd: params.cwdAbs,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });
    child.on('error', (err: Error) => {
      reject(err);
    });
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (signal) return resolve({ code: 1, stdout, stderr: `${stderr}\n[sig] ${signal}`.trim() });
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function writeLocalAppPackage(params: {
  packageRootAbs: string;
  appId: string;
  packageName: string;
  packageVersion: string;
}): Promise<void> {
  await writeText(
    path.join(params.packageRootAbs, 'package.json'),
    JSON.stringify(
      {
        name: params.packageName,
        version: params.packageVersion,
        type: 'module',
        bin: 'bin.js',
      },
      null,
      2,
    ),
  );
  await writeText(
    path.join(params.packageRootAbs, 'bin.js'),
    [
      "'use strict';",
      "if (!process.argv.includes('--dominds-app')) throw new Error('expected --dominds-app');",
      'const json = {',
      `  appId: ${JSON.stringify(params.appId)},`,
      '  package: {',
      `    name: ${JSON.stringify(params.packageName)},`,
      `    version: ${JSON.stringify(params.packageVersion)},`,
      '    rootAbs: process.cwd(),',
      '  },',
      "  host: { kind: 'node_module', moduleRelPath: './src/app.js', exportName: 'createDomindsApp' },",
      "  frontend: { kind: 'http', defaultPort: 0 },",
      "  contributes: { teammatesYamlRelPath: '.minds/team.yaml' },",
      '};',
      'process.stdout.write(JSON.stringify(json));',
      '',
    ].join('\n'),
  );
  await writeText(
    path.join(params.packageRootAbs, '.minds', 'app.yaml'),
    [
      'apiVersion: dominds.io/v1alpha1',
      'kind: DomindsApp',
      `id: ${JSON.stringify(params.appId)}`,
      'contributes:',
      '  teammates:',
      '    teamYaml: .minds/team.yaml',
      '  tools:',
      '    module: ./src/app.js',
      '',
    ].join('\n'),
  );
  await writeText(
    path.join(params.packageRootAbs, '.minds', 'team.yaml'),
    [
      'members:',
      '  reviewer:',
      '    name: Reviewer From Component',
      '    toolsets: [ws_read]',
      '    gofor:',
      '      - verify imported component behavior',
      '  implementer:',
      '    name: Implementer From Component',
      '    toolsets: [ws_read, ws_mod, codex_inspect_and_patch_tools]',
      '    gofor:',
      '      - implement changes using the selected component capabilities',
      '',
    ].join('\n'),
  );
  await writeText(
    path.join(params.packageRootAbs, 'src', 'app.js'),
    ['export async function createDomindsApp() {', '  return { tools: {} };', '}', ''].join('\n'),
  );
}

async function main(): Promise<void> {
  const oldCwd = process.cwd();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-apps-install-configure-use-'));
  const appId = '@tests/install-flow-package';
  const packageName = '@tests/install-flow-package';
  const packageVersion = '0.1.0';
  const localAppRel = path.join('dominds-apps', '@tests', 'install-flow-package');
  const localAppAbs = path.join(tmpRoot, localAppRel);

  const mainTsconfigAbs = path.resolve(__dirname, '..', 'main', 'tsconfig.json');
  const installCliAbs = path.resolve(__dirname, '..', 'main', 'cli', 'install.ts');

  try {
    process.chdir(tmpRoot);
    await writeLocalAppPackage({
      packageRootAbs: localAppAbs,
      appId,
      packageName,
      packageVersion,
    });

    const installRes = await runTsCli({
      tsconfigAbs: mainTsconfigAbs,
      scriptAbs: installCliAbs,
      args: [appId, '--enable'],
      cwdAbs: tmpRoot,
    });
    assert.equal(
      installRes.code,
      0,
      `install failed\nstdout=${installRes.stdout}\nstderr=${installRes.stderr}`,
    );
    assert.match(
      installRes.stdout,
      new RegExp(`Loaded Stage 0 package '${escapeRegExp(appId)}' from local package:`),
    );
    assert.match(installRes.stdout, new RegExp(`Enabled Stage 0 package '${escapeRegExp(appId)}'`));

    const manifestLoaded = await loadDomindsAppManifest({
      packageRootAbs: tmpRoot,
      manifestRelPath: path.join('.minds', 'app.yaml'),
    });
    if (manifestLoaded.kind !== 'ok') throw new Error(manifestLoaded.errorText);
    assert.equal(manifestLoaded.kind, 'ok', 'expected ok');
    assert.equal(manifestLoaded.manifest.dependencies?.length, 1);
    assert.equal(manifestLoaded.manifest.dependencies?.[0]?.id, appId);

    const configLoaded = await loadAppsConfigurationFile({ rtwsRootAbs: tmpRoot });
    if (configLoaded.kind !== 'ok') throw new Error(configLoaded.errorText);
    assert.equal(configLoaded.kind, 'ok', 'expected ok');
    assert.deepEqual(configLoaded.file.disabledApps ?? [], []);

    const lockLoaded = await loadAppLockFile({ rtwsRootAbs: tmpRoot });
    if (lockLoaded.kind !== 'ok') throw new Error(lockLoaded.errorText);
    assert.equal(lockLoaded.kind, 'ok', 'expected ok');
    assert.deepEqual(lockLoaded.file.apps, [
      {
        id: appId,
        package: {
          name: packageName,
          version: packageVersion,
        },
      },
    ]);

    const resolutionLoaded = await loadAppsResolutionFile({ rtwsRootAbs: tmpRoot });
    if (resolutionLoaded.kind !== 'ok') throw new Error(resolutionLoaded.errorText);
    assert.equal(resolutionLoaded.kind, 'ok', 'expected ok');
    assert.equal(resolutionLoaded.file.apps.length, 1);
    const resolvedPackage = resolutionLoaded.file.apps[0] ?? null;
    assert.ok(resolvedPackage, 'expected resolved Stage 0 package entry');
    assert.equal(resolvedPackage?.id, appId);
    assert.equal(resolvedPackage?.enabled, true);
    assert.equal(resolvedPackage?.source.kind, 'local');
    const resolvedSourcePath =
      resolvedPackage?.source.kind === 'local'
        ? await canonicalPath(resolvedPackage.source.pathAbs)
        : null;
    assert.equal(resolvedSourcePath, await canonicalPath(localAppAbs));
    assert.equal(resolvedPackage?.installJson.appId, appId);
    assert.equal(resolvedPackage?.installJson.package.name, packageName);
    assert.equal(
      resolvedPackage?.assignedPort !== null,
      true,
      'frontend Stage 0 package should get a stable assignedPort',
    );
    assert.equal(typeof resolvedPackage?.assignedPort, 'number');
    assert.ok(
      (resolvedPackage?.assignedPort ?? 0) > 0,
      'assignedPort must be non-zero once materialized',
    );

    await writeText(
      path.join(tmpRoot, '.minds', 'team.yaml'),
      [
        'member_defaults:',
        '  provider: openai',
        '  model: gpt-4',
        'default_responder: builder',
        'members:',
        '  builder:',
        '    name: Builder',
        '    toolsets: []',
        '  reviewer_from_package:',
        `    from: ${JSON.stringify(appId)}`,
        '    use: reviewer',
        '    name: Reviewer Override',
        '  implementer_from_package:',
        `    from: ${JSON.stringify(appId)}`,
        '    use: implementer',
        '    name: Implementer Override',
        '',
      ].join('\n'),
    );

    const team = await Team.load();
    const importedMember = team.getMember('reviewer_from_package');
    assert.ok(importedMember, 'expected component teammate import from loaded Stage 0 package');
    assert.equal(importedMember?.name, 'Reviewer Override');
    assert.deepEqual(importedMember?.toolsets, ['ws_read']);
    assert.deepEqual(importedMember?.gofor, ['verify imported component behavior']);

    const importedImplementer = team.getMember('implementer_from_package');
    assert.ok(importedImplementer, 'expected implementer import from loaded Stage 0 package');
    assert.equal(importedImplementer?.name, 'Implementer Override');
    assert.deepEqual(importedImplementer?.toolsets, [
      'ws_read',
      'ws_mod',
      'codex_inspect_and_patch_tools',
    ]);
    assert.deepEqual(importedImplementer?.gofor, [
      'implement changes using the selected component capabilities',
    ]);

    const resolutionYamlText = await fs.readFile(
      path.join(tmpRoot, '.apps', 'resolution.yaml'),
      'utf-8',
    );
    const resolutionYaml = YAML.parse(resolutionYamlText) as unknown;
    assert.equal(typeof resolutionYaml, 'object');
  } finally {
    process.chdir(oldCwd);
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

main()
  .then(() => {
    console.log('OK');
  })
  .catch((err: unknown) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(1);
  });
