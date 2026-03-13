import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runDoctor } from 'dominds/cli/doctor';

async function writeText(filePathAbs: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePathAbs), { recursive: true });
  await fs.writeFile(filePathAbs, content, 'utf-8');
}

async function writeLocalPackage(params: {
  packageRootAbs: string;
  appId: string;
  moduleRelPath: string;
  exportName: string;
}): Promise<void> {
  await writeText(
    path.join(params.packageRootAbs, 'package.json'),
    JSON.stringify(
      {
        name: params.appId,
        version: '0.0.0',
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
      `    name: ${JSON.stringify(params.appId)},`,
      "    version: '0.0.0',",
      '    rootAbs: process.cwd(),',
      '  },',
      `  host: { kind: 'node_module', moduleRelPath: ${JSON.stringify(params.moduleRelPath)}, exportName: ${JSON.stringify(params.exportName)} },`,
      '};',
      'process.stdout.write(JSON.stringify(json));',
      '',
    ].join('\n'),
  );
  await writeText(
    path.join(params.packageRootAbs, '.minds', 'app.yaml'),
    ['apiVersion: dominds.io/v1alpha1', 'kind: DomindsApp', `id: ${params.appId}`, ''].join('\n'),
  );
}

async function main(): Promise<void> {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-apps-doctor-'));
  const appId = '@longrun-ai/doctor-case';
  const packageRootAbs = path.join(tmpRoot, 'dominds-apps', '@longrun-ai', 'doctor-case');

  try {
    await writeText(
      path.join(tmpRoot, '.minds', 'app.yaml'),
      [
        'apiVersion: dominds.io/v1alpha1',
        'kind: DomindsApp',
        'id: rtws_root',
        'dependencies:',
        `  - id: ${JSON.stringify(appId)}`,
        '',
      ].join('\n'),
    );
    await writeText(
      path.join(tmpRoot, '.minds', 'app-lock.yaml'),
      [
        'schemaVersion: 1',
        'apps:',
        `  - id: ${JSON.stringify(appId)}`,
        '    package:',
        `      name: ${JSON.stringify(appId)}`,
        "      version: '0.0.0'",
        '',
      ].join('\n'),
    );
    await writeText(
      path.join(tmpRoot, '.apps', 'resolution.yaml'),
      [
        'schemaVersion: 1',
        'apps:',
        `  - id: ${JSON.stringify(appId)}`,
        '    enabled: true',
        '    source:',
        '      kind: local',
        `      pathAbs: ${JSON.stringify(packageRootAbs)}`,
        '    assignedPort: null',
        '    installJson:',
        '      schemaVersion: 1',
        `      appId: ${JSON.stringify(appId)}`,
        '      package:',
        `        name: ${JSON.stringify(appId)}`,
        "        version: '0.0.0'",
        `        rootAbs: ${JSON.stringify(packageRootAbs)}`,
        '      host:',
        '        kind: node_module',
        '        moduleRelPath: src/app-host.js',
        '        exportName: createDomindsAppHost',
        '',
      ].join('\n'),
    );

    await writeLocalPackage({
      packageRootAbs,
      appId,
      moduleRelPath: 'dist/app.js',
      exportName: 'createDomindsApp',
    });

    const report = await runDoctor({ rtwsRootAbs: tmpRoot, appId });
    assert.equal(report.diagnoses.length, 1);
    const diagnosis = report.diagnoses[0];
    assert.equal(diagnosis.status, 'degraded');
    assert.ok(
      diagnosis.reasons.some((reason) => reason.includes('entry module mismatch')),
      `expected entry module mismatch, got ${JSON.stringify(diagnosis.reasons)}`,
    );
    assert.ok(
      diagnosis.reasons.some((reason) => reason.includes('entry export mismatch')),
      `expected entry export mismatch, got ${JSON.stringify(diagnosis.reasons)}`,
    );
    assert.ok(
      diagnosis.nextActions.some((action) => action.includes('handshake only')),
      `expected handshake guidance, got ${JSON.stringify(diagnosis.nextActions)}`,
    );
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
