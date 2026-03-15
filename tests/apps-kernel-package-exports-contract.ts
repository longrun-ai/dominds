import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';

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

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  assert.equal(typeof value, 'object', `${label} must be an object.`);
  assert.notEqual(value, null, `${label} must not be null.`);
  assert.equal(Array.isArray(value), false, `${label} must not be an array.`);
  return value as Record<string, unknown>;
}

async function main(): Promise<void> {
  const domindsRootAbs = path.resolve(__dirname, '..');
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

  const runControlResult: DomindsAppRunControlResult = { kind: 'continue' };
  assert.equal(
    runControlResult.kind,
    'continue',
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
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
