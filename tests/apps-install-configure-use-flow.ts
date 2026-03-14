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
      '  schemaVersion: 1,',
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
      '  web_tester:',
      '    name: Web Tester From App',
      '    toolsets: [ws_read]',
      '    gofor:',
      '      - capture browser evidence',
      '  web_developer:',
      '    name: Web Developer From App',
      '    toolsets: [ws_read, playwright_interactive, codex_style_tools]',
      '    gofor:',
      '      - attach to existing browser sessions with a provided sessionId before asking others for status relays',
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
  const appId = '@longrun-ai/web-dev';
  const packageName = '@longrun-ai/web-dev';
  const packageVersion = '0.1.0';
  const localAppRel = path.join('dominds-apps', '@longrun-ai', 'web-dev');
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
      new RegExp(`Installed app '${escapeRegExp(appId)}' from local package:`),
    );
    assert.match(installRes.stdout, new RegExp(`Enabled app '${escapeRegExp(appId)}'`));

    const manifestLoaded = await loadDomindsAppManifest({
      packageRootAbs: tmpRoot,
      manifestRelPath: path.join('.minds', 'app.yaml'),
    });
    assert.equal(
      manifestLoaded.kind,
      'ok',
      manifestLoaded.kind === 'ok' ? 'expected ok' : manifestLoaded.errorText,
    );
    if (manifestLoaded.kind !== 'ok') throw new Error(manifestLoaded.errorText);
    assert.equal(manifestLoaded.manifest.dependencies?.length, 1);
    assert.equal(manifestLoaded.manifest.dependencies?.[0]?.id, appId);

    const configLoaded = await loadAppsConfigurationFile({ rtwsRootAbs: tmpRoot });
    assert.equal(
      configLoaded.kind,
      'ok',
      configLoaded.kind === 'ok' ? 'expected ok' : configLoaded.errorText,
    );
    if (configLoaded.kind !== 'ok') throw new Error(configLoaded.errorText);
    assert.deepEqual(configLoaded.file.disabledApps ?? [], []);

    const lockLoaded = await loadAppLockFile({ rtwsRootAbs: tmpRoot });
    assert.equal(
      lockLoaded.kind,
      'ok',
      lockLoaded.kind === 'ok' ? 'expected ok' : lockLoaded.errorText,
    );
    if (lockLoaded.kind !== 'ok') throw new Error(lockLoaded.errorText);
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
    assert.equal(
      resolutionLoaded.kind,
      'ok',
      resolutionLoaded.kind === 'ok' ? 'expected ok' : resolutionLoaded.errorText,
    );
    if (resolutionLoaded.kind !== 'ok') throw new Error(resolutionLoaded.errorText);
    assert.equal(resolutionLoaded.file.apps.length, 1);
    const resolvedApp = resolutionLoaded.file.apps[0] ?? null;
    assert.ok(resolvedApp, 'expected resolved app entry');
    assert.equal(resolvedApp?.id, appId);
    assert.equal(resolvedApp?.enabled, true);
    assert.equal(resolvedApp?.source.kind, 'local');
    const resolvedSourcePath =
      resolvedApp?.source.kind === 'local' ? await canonicalPath(resolvedApp.source.pathAbs) : null;
    assert.equal(resolvedSourcePath, await canonicalPath(localAppAbs));
    assert.equal(resolvedApp?.installJson.appId, appId);
    assert.equal(resolvedApp?.installJson.package.name, packageName);
    assert.equal(
      resolvedApp?.assignedPort !== null,
      true,
      'frontend app should get a stable assignedPort',
    );
    assert.equal(typeof resolvedApp?.assignedPort, 'number');
    assert.ok(
      (resolvedApp?.assignedPort ?? 0) > 0,
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
        '  qa_from_app:',
        `    from: ${JSON.stringify(appId)}`,
        '    use: web_tester',
        '    name: QA Override',
        '  dev_from_app:',
        `    from: ${JSON.stringify(appId)}`,
        '    use: web_developer',
        '    name: Dev Override',
        '',
      ].join('\n'),
    );

    const team = await Team.load();
    const importedMember = team.getMember('qa_from_app');
    assert.ok(importedMember, 'expected team import from installed app');
    assert.equal(importedMember?.name, 'QA Override');
    assert.deepEqual(importedMember?.toolsets, ['ws_read']);
    assert.deepEqual(importedMember?.gofor, ['capture browser evidence']);

    const importedDeveloper = team.getMember('dev_from_app');
    assert.ok(importedDeveloper, 'expected developer import from installed app');
    assert.equal(importedDeveloper?.name, 'Dev Override');
    assert.deepEqual(importedDeveloper?.toolsets, [
      'ws_read',
      'playwright_interactive',
      'codex_style_tools',
    ]);
    assert.deepEqual(importedDeveloper?.gofor, [
      'attach to existing browser sessions with a provided sessionId before asking others for status relays',
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
