import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  type DomindsAppRunControlResult,
  type Q4HDialogContext,
  TEAM_MGMT_MANUAL_UI_TOPIC_ORDER,
  getTeamMgmtManualTopicTitle,
  isTeamMgmtManualTopicKey,
  parseDomindsAppInstallJson,
} from '@longrun-ai/kernel';
import type { CreateDomindsAppFn } from '@longrun-ai/kernel/app-host-contract';
import type { DomindsAppInstallJsonV1 } from '@longrun-ai/kernel/app-json';
import { DILIGENCE_FALLBACK_TEXT } from '@longrun-ai/kernel/diligence';
import { createPubChan, createSubChan } from '@longrun-ai/kernel/evt';
import { supportedLanguageCodes } from '@longrun-ai/kernel/types/language';
import { escapeHtml, escapeHtmlAttr } from '@longrun-ai/kernel/utils/html';
import { generateShortId } from '@longrun-ai/kernel/utils/id';
import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';

type PackageJsonShape = Readonly<{
  name?: unknown;
  main?: unknown;
  types?: unknown;
  exports?: unknown;
  publishConfig?: unknown;
}>;

type PhaseGatePackageJsonShape = Readonly<{
  exports?: unknown;
  scripts?: unknown;
  dependencies?: unknown;
  devDependencies?: unknown;
}>;

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  assert.equal(typeof value, 'object', `${label} must be an object.`);
  assert.notEqual(value, null, `${label} must not be null.`);
  assert.equal(Array.isArray(value), false, `${label} must not be an array.`);
  return value as Record<string, unknown>;
}

async function main(): Promise<void> {
  const domindsRootAbs = path.resolve(__dirname, '..');
  const repoRootAbs = path.resolve(domindsRootAbs, '..');
  const packageJsonText = await fs.readFile(
    path.join(domindsRootAbs, 'packages', 'kernel', 'package.json'),
    'utf-8',
  );
  const packageJson = JSON.parse(packageJsonText) as PackageJsonShape;
  const exportsField = expectRecord(packageJson.exports, 'kernel package.json exports');
  const publishConfig = expectRecord(
    packageJson.publishConfig,
    'kernel package.json publishConfig',
  );

  assert.equal(packageJson.name, '@longrun-ai/kernel', 'Kernel package name must be stable.');
  assert.equal(
    packageJson.main,
    'dist/index.js',
    'Kernel package main must point at dist/index.js.',
  );
  assert.equal(
    packageJson.types,
    'src/index.ts',
    'Kernel package types must point at src/index.ts so workspace consumers can type-check against the formal package surface before prebuilding dist.',
  );
  assert.equal(
    publishConfig['access'],
    'public',
    'Kernel package must declare publishConfig.access=public for scoped npm publishing.',
  );
  assert.deepEqual(
    Object.keys(exportsField).sort(),
    [
      '.',
      './app-host-contract',
      './app-json',
      './diligence',
      './evt',
      './team-mgmt-manual',
      './types',
      './types/*',
      './utils/html',
      './utils/id',
      './utils/time',
    ].sort(),
    'Kernel package must expose the first formal contract set used by apps and WebUI.',
  );
  const typesExport = expectRecord(exportsField['./types'], 'kernel ./types export');
  assert.equal(
    typesExport['types'],
    './src/types.ts',
    'Kernel ./types export must point type consumers at src/types.ts.',
  );
  assert.equal(
    typesExport['require'],
    './dist/types.js',
    'Kernel ./types export must resolve to kernel-owned dist/types.js.',
  );
  const typesStarExport = expectRecord(exportsField['./types/*'], 'kernel ./types/* export');
  assert.equal(
    typesStarExport['types'],
    './src/types/*.ts',
    'Kernel ./types/* export must point type consumers at src/types/*.ts.',
  );
  assert.equal(
    typesStarExport['require'],
    './dist/types/*.js',
    'Kernel ./types/* export must resolve to kernel-owned dist/types/*.js.',
  );
  const appJsonExport = expectRecord(exportsField['./app-json'], 'kernel ./app-json export');
  assert.equal(
    appJsonExport['types'],
    './src/app-json.ts',
    'Kernel ./app-json export must point type consumers at src/app-json.ts.',
  );
  assert.equal(
    appJsonExport['require'],
    './dist/app-json.js',
    'Kernel ./app-json export must resolve to kernel-owned dist/app-json.js.',
  );
  const appHostExport = expectRecord(
    exportsField['./app-host-contract'],
    'kernel ./app-host-contract export',
  );
  assert.equal(
    appHostExport['types'],
    './src/app-host-contract.ts',
    'Kernel ./app-host-contract export must point type consumers at src/app-host-contract.ts.',
  );
  assert.equal(
    appHostExport['require'],
    './dist/app-host-contract.js',
    'Kernel ./app-host-contract export must resolve to kernel-owned dist/app-host-contract.js.',
  );

  const installJsonInput = {
    schemaVersion: 1,
    appId: '@demo/example',
    displayName: 'Example',
    package: {
      name: '@demo/example',
      version: '1.0.0',
      rootAbs: '/tmp/example-app',
    },
    host: {
      kind: 'node_module' as const,
      moduleRelPath: 'dist/app.js',
      exportName: 'createDomindsApp',
    },
  };

  const parsed = parseDomindsAppInstallJson(installJsonInput);
  assert.equal(parsed.ok, true, 'Kernel root export must parse valid app install json.');
  const installJsonContract: DomindsAppInstallJsonV1 = installJsonInput;
  assert.equal(installJsonContract.host.exportName, 'createDomindsApp');
  assert.deepEqual(
    TEAM_MGMT_MANUAL_UI_TOPIC_ORDER.slice(0, 3),
    ['topics', 'team', 'member-properties'],
    'Kernel root export must keep team manual UI ordering stable.',
  );
  assert.equal(
    getTeamMgmtManualTopicTitle('en', 'topics'),
    'Index',
    'Kernel root export must expose team manual titles.',
  );
  assert.equal(
    isTeamMgmtManualTopicKey('topics'),
    true,
    'Kernel root export must expose topic guard.',
  );
  assert.deepEqual(
    supportedLanguageCodes,
    ['en', 'zh'],
    'Kernel language contract must stay explicit.',
  );
  assert.equal(
    typeof DILIGENCE_FALLBACK_TEXT.zh,
    'string',
    'Kernel diligence contract must be consumable by WebUI.',
  );

  const chan = createPubChan<string>();
  const sub = createSubChan(chan);
  chan.write('ok');
  assert.equal(
    await sub.read(),
    'ok',
    'Kernel evt contract must remain consumable outside main/shared.',
  );
  assert.equal(
    formatUnifiedTimestamp(new Date('2026-03-13T01:02:03Z')).length,
    19,
    'Kernel shared util export must remain callable.',
  );
  assert.equal(
    escapeHtml('<tag>'),
    '&lt;tag&gt;',
    'Kernel html util export must be part of the public contract.',
  );
  assert.equal(
    escapeHtmlAttr('x"y'),
    'x&quot;y',
    'Kernel html-attr util export must be part of the public contract.',
  );
  assert.equal(
    generateShortId().length,
    6,
    'Kernel id util export must be part of the public contract.',
  );

  const runControlResult: DomindsAppRunControlResult = {
    kind: 'allow',
    recoveryAction: { actionId: 'continue', promptSummary: 'Continue' },
  };
  assert.equal(
    runControlResult.recoveryAction?.promptSummary,
    'Continue',
    'Kernel root export must carry run-control result typing.',
  );

  const q4hContext: Q4HDialogContext = {
    selfId: 'dlg-1',
    rootId: 'dlg-1',
    agentId: '@qa',
    taskDocPath: 'demo.tsk',
    questions: [],
  };
  assert.equal(q4hContext.questions.length, 0, 'Kernel root export must carry Q4H typing.');

  const createApp: CreateDomindsAppFn = async () => ({
    tools: {},
  });
  assert.equal(
    typeof createApp,
    'function',
    'Kernel app host contract export must stay callable by consumers.',
  );

  const phaseGatePackageJsonText = await fs.readFile(
    path.join(repoRootAbs, 'dominds-apps', '@longrun-ai', 'phase-gate', 'package.json'),
    'utf-8',
  );
  const phaseGatePackageJson = JSON.parse(phaseGatePackageJsonText) as PhaseGatePackageJsonShape;
  const phaseGateExports = expectRecord(
    phaseGatePackageJson.exports,
    'phase-gate package.json exports',
  );
  assert.deepEqual(
    Object.keys(phaseGateExports).sort(),
    ['.', './app', './install', './package.json'].sort(),
    'Phase Gate app must expose its formal TS app/install entrypoints only.',
  );
  const phaseGateRootExport = expectRecord(phaseGateExports['.'], 'phase-gate root export');
  assert.equal(
    phaseGateRootExport['types'],
    './src/app.ts',
    'Phase Gate root export must point type consumers at src/app.ts.',
  );
  assert.equal(
    phaseGateRootExport['import'],
    './dist/app.js',
    'Phase Gate root export must resolve runtime imports to dist/app.js.',
  );
  const phaseGateInstallExport = expectRecord(
    phaseGateExports['./install'],
    'phase-gate install export',
  );
  assert.equal(
    phaseGateInstallExport['types'],
    './src/install.ts',
    'Phase Gate install export must point type consumers at src/install.ts.',
  );
  assert.equal(
    phaseGateInstallExport['import'],
    './dist/install.js',
    'Phase Gate install export must resolve runtime imports to dist/install.js.',
  );
  const phaseGateScripts = expectRecord(
    phaseGatePackageJson.scripts,
    'phase-gate package.json scripts',
  );
  assert.equal(
    phaseGateScripts['build'],
    'pnpm -C ../../../dominds exec tsc -p ../dominds-apps/@longrun-ai/phase-gate/tsconfig.json && cp ./src/app-impl.js ./src/app-metadata.js ./src/app-runtime-contract.js ./src/install-runtime.js ./dist/ && node --check ./src/app.js && node --check ./src/app-impl.js && node --check ./src/install.js && node --check ./src/install-runtime.js && node --check ./src/app-metadata.js && node --check ./src/app-runtime-contract.js && node --check ./bin/phase-gate.js',
    'Phase Gate build must compile its formal TS entrypoints before runtime checks.',
  );
  assert.equal(
    phaseGateScripts['lint:types'],
    'pnpm -C ../../../dominds exec tsc -p ../dominds-apps/@longrun-ai/phase-gate/tsconfig.json --noEmit && node --check ./src/app.js && node --check ./src/app-impl.js && node --check ./src/install.js && node --check ./src/install-runtime.js && node --check ./src/app-metadata.js && node --check ./src/app-runtime-contract.js && node --check ./bin/phase-gate.js',
    'Phase Gate typecheck must run through the formal TS authoring path.',
  );
  const phaseGateDependencies = expectRecord(
    phaseGatePackageJson.dependencies,
    'phase-gate package.json dependencies',
  );
  assert.equal(typeof phaseGateDependencies['@longrun-ai/kernel'], 'string');
  assert.equal(
    String(phaseGateDependencies['@longrun-ai/kernel']).startsWith('file:'),
    false,
    'Phase Gate app must depend on the published/formal kernel package surface instead of a repo-local file deep path.',
  );
  assert.equal(
    String(phaseGateDependencies['@longrun-ai/kernel']).includes('workspace:'),
    false,
    'Phase Gate app must not rely on workspace protocol for its formal kernel dependency.',
  );

  const phaseGateInstallModule = (await import(
    pathToFileURL(
      path.join(repoRootAbs, 'dominds-apps', '@longrun-ai', 'phase-gate', 'src', 'install.ts'),
    ).href
  )) as Readonly<{
    createInstallJson: () => Promise<DomindsAppInstallJsonV1>;
  }>;
  const phaseGateAppModule = (await import(
    pathToFileURL(
      path.join(repoRootAbs, 'dominds-apps', '@longrun-ai', 'phase-gate', 'src', 'app.ts'),
    ).href
  )) as Readonly<{
    createDomindsApp: CreateDomindsAppFn;
  }>;
  const phaseGateInstallJson = await phaseGateInstallModule.createInstallJson();
  assert.equal(phaseGateInstallJson.appId, '@longrun-ai/phase-gate');
  assert.equal(phaseGateInstallJson.host.exportName, 'createDomindsApp');
  assert.match(
    phaseGateInstallJson.host.moduleRelPath,
    /^\.\/(src|dist)\/app\.js$/,
    'Phase Gate install handshake must resolve to the formal app seam in source or built form.',
  );
  const phaseGateHost = await phaseGateAppModule.createDomindsApp({
    appId: '@longrun-ai/phase-gate',
    rtwsRootAbs: repoRootAbs,
    rtwsAppDirAbs: path.join(repoRootAbs, '.apps', '@longrun-ai', 'phase-gate'),
    packageRootAbs: path.join(repoRootAbs, 'dominds-apps', '@longrun-ai', 'phase-gate'),
    kernel: { host: '127.0.0.1', port: 4321 },
    log: () => {},
  });
  assert.equal(typeof phaseGateHost.dynamicToolsets, 'function');
  assert.equal(typeof phaseGateHost.tools['phase_gate_validate_flow'], 'function');
  assert.equal(typeof phaseGateHost.runControls?.['phase_gate_autonomy'], 'function');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
