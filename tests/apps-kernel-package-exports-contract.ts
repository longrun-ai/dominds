import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';

import {
  type Q4HDialogContext,
  TEAM_MGMT_GUIDE_UI_TOPIC_ORDER,
  appToolSuccess,
  getTeamMgmtGuideTopicTitle,
  isTeamMgmtGuideTopicKey,
  parseDomindsAppInstallJson,
  toolSuccess,
} from '@longrun-ai/kernel';
import type { CreateDomindsAppFn } from '@longrun-ai/kernel/app-host-contract';
import { type DomindsAppInstallJson, isJsonValue } from '@longrun-ai/kernel/app-json';
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
  const exportsField = expectRecord(packageJson.exports, 'MicroKernel package.json exports');
  const publishConfig = expectRecord(
    packageJson.publishConfig,
    'MicroKernel package.json publishConfig',
  );

  assert.equal(packageJson.name, '@longrun-ai/kernel', 'MicroKernel package name must be stable.');
  assert.equal(
    packageJson.main,
    'dist/index.js',
    'MicroKernel package main must point at dist/index.js.',
  );
  assert.equal(
    packageJson.types,
    'src/index.ts',
    'MicroKernel package types must point at src/index.ts so workspace consumers can type-check against the formal package surface before prebuilding dist.',
  );
  assert.equal(
    publishConfig['access'],
    'public',
    'MicroKernel package must declare publishConfig.access=public for scoped npm publishing.',
  );
  assert.deepEqual(
    Object.keys(exportsField).sort(),
    [
      '.',
      './app-host-contract',
      './app-json',
      './diligence',
      './evt',
      './team-mgmt-guide',
      './types',
      './types/*',
      './utils/html',
      './utils/id',
      './utils/time',
    ].sort(),
    'MicroKernel package must expose the first formal contract set used by apps and WebUI.',
  );
  const typesExport = expectRecord(exportsField['./types'], 'MicroKernel ./types export');
  assert.equal(
    typesExport['types'],
    './src/types.ts',
    'MicroKernel ./types export must point type consumers at src/types.ts.',
  );
  assert.equal(
    typesExport['require'],
    './dist/types.js',
    'MicroKernel ./types export must resolve to MicroKernel-owned dist/types.js.',
  );
  const typesStarExport = expectRecord(exportsField['./types/*'], 'MicroKernel ./types/* export');
  assert.equal(
    typesStarExport['types'],
    './src/types/*.ts',
    'MicroKernel ./types/* export must point type consumers at src/types/*.ts.',
  );
  assert.equal(
    typesStarExport['require'],
    './dist/types/*.js',
    'MicroKernel ./types/* export must resolve to MicroKernel-owned dist/types/*.js.',
  );
  const appJsonExport = expectRecord(exportsField['./app-json'], 'MicroKernel ./app-json export');
  assert.equal(
    appJsonExport['types'],
    './src/app-json.ts',
    'MicroKernel ./app-json export must point type consumers at src/app-json.ts.',
  );
  assert.equal(
    appJsonExport['require'],
    './dist/app-json.js',
    'MicroKernel ./app-json export must resolve to MicroKernel-owned dist/app-json.js.',
  );
  const appHostExport = expectRecord(
    exportsField['./app-host-contract'],
    'MicroKernel ./app-host-contract export',
  );
  assert.equal(
    appHostExport['types'],
    './src/app-host-contract.ts',
    'MicroKernel ./app-host-contract export must point type consumers at src/app-host-contract.ts.',
  );
  assert.equal(
    appHostExport['require'],
    './dist/app-host-contract.js',
    'MicroKernel ./app-host-contract export must resolve to MicroKernel-owned dist/app-host-contract.js.',
  );

  const installJsonInput = {
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
  assert.equal(parsed.ok, true, 'MicroKernel root export must parse valid app install json.');
  const canonicalized = parseDomindsAppInstallJson({
    ...installJsonInput,
    displayName: undefined,
    frontend: {
      kind: 'http',
      defaultPort: undefined,
      basePath: undefined,
      wsPath: undefined,
    },
    contributes: {
      teammatesYamlRelPath: undefined,
      toolsets: [
        {
          id: 'probe',
          descriptionI18n: undefined,
          tools: [
            {
              name: 'probe_tool',
              description: undefined,
              descriptionI18n: undefined,
              parameters: {},
            },
          ],
        },
      ],
      reminderOwners: [
        {
          ref: 'probe_owner',
          manager: undefined,
          update: undefined,
          delete: undefined,
        },
      ],
    },
  });
  assert.equal(canonicalized.ok, true, 'Valid install json must remain canonicalizable.');
  if (canonicalized.ok) {
    assert.equal(
      isJsonValue(canonicalized.json),
      true,
      'Parsed install json must be a lossless IPC value without undefined optional properties.',
    );
    assert.deepEqual(canonicalized.json, {
      appId: '@demo/example',
      package: {
        name: '@demo/example',
        version: '1.0.0',
        rootAbs: '/tmp/example-app',
      },
      host: {
        kind: 'node_module',
        moduleRelPath: 'dist/app.js',
        exportName: 'createDomindsApp',
      },
      frontend: { kind: 'http' },
      contributes: {
        toolsets: [{ id: 'probe', tools: [{ name: 'probe_tool', parameters: {} }] }],
        reminderOwners: [{ ref: 'probe_owner' }],
      },
    });
  }
  class InstallManifestClass {
    readonly appId = installJsonInput.appId;
    readonly displayName = installJsonInput.displayName;
    readonly package = installJsonInput.package;
    readonly host = installJsonInput.host;
  }
  assert.equal(
    parseDomindsAppInstallJson(new InstallManifestClass()).ok,
    false,
    'Install json must reject class instances rather than treating them as plain manifests.',
  );
  let installGetterRead = false;
  const getterInstallJson = { ...installJsonInput };
  Object.defineProperty(getterInstallJson, 'displayName', {
    enumerable: true,
    get() {
      installGetterRead = true;
      return 'Getter Example';
    },
  });
  assert.equal(
    parseDomindsAppInstallJson(getterInstallJson).ok,
    false,
    'Install json must reject accessor properties.',
  );
  assert.equal(
    installGetterRead,
    false,
    'Install json validation must reject accessors without invoking them.',
  );
  const symbolInstallJson: Record<PropertyKey, unknown> = { ...installJsonInput };
  symbolInstallJson[Symbol('hidden')] = true;
  assert.equal(
    parseDomindsAppInstallJson(symbolInstallJson).ok,
    false,
    'Install json must reject symbol-keyed properties instead of silently discarding them.',
  );
  const unsupportedContribution = parseDomindsAppInstallJson({
    ...installJsonInput,
    contributes: {
      unsupportedExtension: {},
    },
  });
  assert.equal(
    unsupportedContribution.ok,
    false,
    'Unknown app contributions must fail closed instead of being silently ignored.',
  );
  if (!unsupportedContribution.ok) {
    assert.match(
      unsupportedContribution.errorText,
      /contributes contains unsupported properties: unsupportedExtension/,
    );
  }
  const unsupportedReminderOwner = parseDomindsAppInstallJson({
    ...installJsonInput,
    contributes: {
      reminderOwners: [
        {
          ref: 'probe_owner',
          managedByTool: 'probe_tool',
          updateExample: 'probe_tool({})',
        },
      ],
    },
  });
  assert.equal(
    unsupportedReminderOwner.ok,
    false,
    'Unknown reminder-owner properties must fail closed instead of being silently ignored.',
  );
  if (!unsupportedReminderOwner.ok) {
    assert.match(
      unsupportedReminderOwner.errorText,
      /contributes\.reminderOwners\[0\]: contains unsupported properties: managedByTool, updateExample/,
    );
  }

  const validParameters = {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        enum: ['current', 'archived'],
      },
      limit: {
        type: 'integer',
        minimum: 0,
      },
    },
    required: ['query'],
    additionalProperties: false,
  };
  const validParametersResult = parseDomindsAppInstallJson({
    ...installJsonInput,
    contributes: {
      toolsets: [
        {
          id: 'probe',
          tools: [{ name: 'probe_tool', parameters: validParameters }],
        },
      ],
    },
  });
  assert.equal(
    validParametersResult.ok,
    true,
    'A nested lossless JSON object must remain a valid tool parameter schema.',
  );
  if (validParametersResult.ok) {
    assert.deepEqual(
      validParametersResult.json.contributes?.toolsets?.[0]?.tools[0]?.parameters,
      validParameters,
      'The parser must preserve every JSON schema value without normalization loss.',
    );
  }

  class SchemaClass {
    readonly type = 'object';
  }
  const cyclicParameters: Record<string, unknown> = { type: 'object' };
  cyclicParameters['self'] = cyclicParameters;
  let getterRead = false;
  const getterParameters: Record<string, unknown> = {};
  Object.defineProperty(getterParameters, 'type', {
    enumerable: true,
    get() {
      getterRead = true;
      return 'object';
    },
  });
  const symbolKeyParameters: Record<PropertyKey, unknown> = { type: 'object' };
  symbolKeyParameters[Symbol('hidden')] = true;
  const sparseEnum = new Array<unknown>(1);
  const invalidParameterCases: ReadonlyArray<Readonly<{ label: string; parameters: unknown }>> = [
    {
      label: 'positive infinity',
      parameters: { type: 'object', maximum: Number.POSITIVE_INFINITY },
    },
    {
      label: 'negative infinity',
      parameters: { type: 'object', minimum: Number.NEGATIVE_INFINITY },
    },
    {
      label: 'NaN',
      parameters: { type: 'object', default: Number.NaN },
    },
    {
      label: 'negative zero',
      parameters: { type: 'object', default: -0 },
    },
    {
      label: 'Date instance',
      parameters: new Date(0),
    },
    {
      label: 'class instance',
      parameters: new SchemaClass(),
    },
    {
      label: 'getter property',
      parameters: getterParameters,
    },
    {
      label: 'cyclic object',
      parameters: cyclicParameters,
    },
    {
      label: 'undefined value',
      parameters: { type: 'object', default: undefined },
    },
    {
      label: 'symbol value',
      parameters: { type: 'object', default: Symbol('invalid') },
    },
    {
      label: 'symbol key',
      parameters: symbolKeyParameters,
    },
    {
      label: 'function value',
      parameters: { type: 'object', default: () => 'invalid' },
    },
    {
      label: 'bigint value',
      parameters: { type: 'object', default: BigInt(1) },
    },
    {
      label: 'sparse array',
      parameters: { type: 'object', enum: sparseEnum },
    },
  ];
  for (const testCase of invalidParameterCases) {
    const result = parseDomindsAppInstallJson({
      ...installJsonInput,
      contributes: {
        toolsets: [
          {
            id: 'probe',
            tools: [{ name: 'probe_tool', parameters: testCase.parameters }],
          },
        ],
      },
    });
    assert.equal(result.ok, false, `${testCase.label} must fail the JsonSchema boundary.`);
    if (!result.ok) {
      assert.match(
        result.errorText,
        /contributes\.toolsets\[0\]\.tools\[0\]\.parameters: expected lossless JSON object/,
      );
    }
  }
  assert.equal(
    getterRead,
    false,
    'JsonSchema validation must reject accessors without invoking them.',
  );

  const invalidOptionalFieldCases: ReadonlyArray<
    Readonly<{ label: string; input: unknown; expected: RegExp }>
  > = [
    {
      label: 'displayName wrong type',
      input: { ...installJsonInput, displayName: 42 },
      expected: /displayName must be a string/,
    },
    {
      label: 'package.version wrong type',
      input: {
        ...installJsonInput,
        package: { ...installJsonInput.package, version: 42 },
      },
      expected: /package\.version must be string\|null/,
    },
    {
      label: 'frontend.basePath wrong type',
      input: {
        ...installJsonInput,
        frontend: { kind: 'http', basePath: 42 },
      },
      expected: /frontend\.basePath must be a string/,
    },
    {
      label: 'frontend.wsPath wrong type',
      input: {
        ...installJsonInput,
        frontend: { kind: 'http', wsPath: false },
      },
      expected: /frontend\.wsPath must be a string/,
    },
    {
      label: 'frontend.defaultPort fractional value',
      input: {
        ...installJsonInput,
        frontend: { kind: 'http', defaultPort: 43123.5 },
      },
      expected: /frontend\.defaultPort must be an integer between 0 and 65535/,
    },
    {
      label: 'frontend.defaultPort negative zero',
      input: {
        ...installJsonInput,
        frontend: { kind: 'http', defaultPort: -0 },
      },
      expected: /frontend\.defaultPort must be an integer between 0 and 65535/,
    },
    {
      label: 'frontend.defaultPort above TCP port range',
      input: {
        ...installJsonInput,
        frontend: { kind: 'http', defaultPort: 65_536 },
      },
      expected: /frontend\.defaultPort must be an integer between 0 and 65535/,
    },
    {
      label: 'teammatesYamlRelPath wrong type',
      input: {
        ...installJsonInput,
        contributes: { teammatesYamlRelPath: 42 },
      },
      expected: /teammatesYamlRelPath must be a non-empty string/,
    },
    {
      label: 'tool description wrong type',
      input: {
        ...installJsonInput,
        contributes: {
          toolsets: [
            {
              id: 'probe',
              tools: [{ name: 'probe', description: 42, parameters: {} }],
            },
          ],
        },
      },
      expected: /tools\[0\]\.description: expected string/,
    },
    {
      label: 'descriptionI18n extra language',
      input: {
        ...installJsonInput,
        contributes: {
          toolsets: [
            {
              id: 'probe',
              descriptionI18n: { zh: '探针', en: 'Probe', fr: 'Sonde' },
              tools: [],
            },
          ],
        },
      },
      expected: /descriptionI18n: expected \{zh,en\} string/,
    },
    {
      label: 'duplicate toolset id',
      input: {
        ...installJsonInput,
        contributes: {
          toolsets: [
            { id: 'probe', tools: [] },
            { id: 'probe', tools: [] },
          ],
        },
      },
      expected: /duplicate toolset id 'probe'/,
    },
    {
      label: 'duplicate tool name within one component',
      input: {
        ...installJsonInput,
        contributes: {
          toolsets: [
            {
              id: 'probe',
              tools: [
                { name: 'probe_tool', parameters: {} },
                { name: 'probe_tool', parameters: {} },
              ],
            },
          ],
        },
      },
      expected: /duplicate tool name 'probe_tool'/,
    },
    {
      label: 'duplicate reminder owner ref',
      input: {
        ...installJsonInput,
        contributes: {
          reminderOwners: [{ ref: 'probe_owner' }, { ref: 'probe_owner' }],
        },
      },
      expected: /duplicate reminder owner ref 'probe_owner'/,
    },
  ];
  for (const testCase of invalidOptionalFieldCases) {
    const result = parseDomindsAppInstallJson(testCase.input);
    assert.equal(result.ok, false, `${testCase.label} must fail closed.`);
    if (!result.ok) {
      assert.match(result.errorText, testCase.expected);
    }
  }
  assert.equal(
    parseDomindsAppInstallJson({
      ...installJsonInput,
      frontend: { kind: 'http', defaultPort: 0 },
    }).ok,
    true,
    'Port 0 remains the explicit Stage 0 request for automatic port assignment.',
  );
  assert.equal(
    parseDomindsAppInstallJson({
      ...installJsonInput,
      frontend: { kind: 'http', defaultPort: 65_535 },
    }).ok,
    true,
    'The highest valid TCP port must remain accepted.',
  );
  const installJsonContract: DomindsAppInstallJson = installJsonInput;
  assert.equal(installJsonContract.host.exportName, 'createDomindsApp');
  assert.deepEqual(
    TEAM_MGMT_GUIDE_UI_TOPIC_ORDER.slice(0, 3),
    ['topics', 'team', 'member-properties'],
    'MicroKernel root export must keep team manual UI ordering stable.',
  );
  assert.equal(
    getTeamMgmtGuideTopicTitle('en', 'topics'),
    'Index',
    'MicroKernel root export must expose team manual titles.',
  );
  assert.equal(
    isTeamMgmtGuideTopicKey('topics'),
    true,
    'MicroKernel root export must expose topic guard.',
  );
  assert.deepEqual(
    supportedLanguageCodes,
    ['en', 'zh'],
    'MicroKernel language contract must stay explicit.',
  );
  assert.equal(
    typeof DILIGENCE_FALLBACK_TEXT.zh,
    'string',
    'MicroKernel diligence contract must be consumable by WebUI.',
  );

  const chan = createPubChan<string>();
  const sub = createSubChan(chan);
  chan.write('ok');
  assert.equal(
    await sub.read(),
    'ok',
    'MicroKernel evt contract must remain consumable outside main private runtime sources.',
  );
  assert.equal(
    formatUnifiedTimestamp(new Date('2026-03-13T01:02:03Z')).length,
    19,
    'MicroKernel shared util export must remain callable.',
  );
  assert.equal(
    escapeHtml('<tag>'),
    '&lt;tag&gt;',
    'MicroKernel html util export must be part of the public contract.',
  );
  assert.equal(
    escapeHtmlAttr('x"y'),
    'x&quot;y',
    'MicroKernel html-attr util export must be part of the public contract.',
  );
  assert.equal(
    generateShortId().length,
    6,
    'MicroKernel id util export must be part of the public contract.',
  );
  assert.deepEqual(
    toolSuccess('ok'),
    { content: 'ok', outcome: 'success' },
    'MicroKernel tool helpers must omit absent optional fields instead of relying on JSON IPC to erase undefined values.',
  );
  assert.deepEqual(
    appToolSuccess('ok'),
    { output: { content: 'ok', outcome: 'success' } },
    'Stage 0 App tool helpers must produce lossless IPC objects without undefined optional fields.',
  );

  const q4hContext: Q4HDialogContext = {
    selfId: 'dlg-1',
    rootId: 'dlg-1',
    agentId: '@qa',
    taskDocPath: 'demo.tsk',
    questions: [],
  };
  assert.equal(q4hContext.questions.length, 0, 'MicroKernel root export must carry Q4H typing.');

  const createApp: CreateDomindsAppFn = async () => ({
    tools: {},
  });
  assert.equal(
    typeof createApp,
    'function',
    'MicroKernel app host contract export must stay callable by consumers.',
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
