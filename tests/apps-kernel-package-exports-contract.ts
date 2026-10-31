import {
  appToolSuccess,
  isTeamMgmtGuideTopicKey,
  parseDomindsAppInstallJson,
  toolSuccess,
} from '@longrun-ai/kernel';
import { isJsonValue } from '@longrun-ai/kernel/app-json';
import { supportedLanguageCodes } from '@longrun-ai/kernel/types/language';
import { escapeHtmlAttr } from '@longrun-ai/kernel/utils/html';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { inspect } from 'node:util';
import { checkConsumerTypes, repository, withConsumer } from './helpers/packaging/consumer';
import { semanticEvidenceCollector } from './helpers/semantic-evidence';

const evidence = semanticEvidenceCollector('dominds-manifest-contract-');
function rejected(label: string, input: unknown) {
  const result = parseDomindsAppInstallJson(input);
  assert.equal(result.ok, false, label);
  assert.ok(!result.ok);
  evidence.record({
    id: label.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    scenario: `The public install parser rejects ${label}.`,
    businessValue:
      'Help a component author repair an invalid current compatibility manifest without silently losing capability data or executing accessor code.',
    context: {
      input: inspect(input, {
        depth: null,
        getters: false,
        customInspect: false,
        showHidden: true,
      }),
      accepted: result.ok,
      scope:
        'Public parser boundary only; no component installation, host process or target App architecture claim. Input is an inspection representation so non-JSON values remain visible without invoking getters.',
    },
    reviewQuestions: [
      'Does this actual diagnostic identify the invalid manifest area and the rejected constraint accurately enough to correct it, without implying installation succeeded?',
    ],
    actualText: result.errorText,
  });
  return result;
}

async function main(): Promise<void> {
  // A workspace consumer must type-check before dist exists, without repository path aliases.
  await withConsumer(async (directory) => {
    const installed = path.join(directory, 'node_modules/@longrun-ai/kernel');
    await fs.mkdir(installed, { recursive: true });
    await fs.cp(path.join(repository, 'packages/kernel/src'), path.join(installed, 'src'), {
      recursive: true,
    });
    await fs.copyFile(
      path.join(repository, 'packages/kernel/package.json'),
      path.join(installed, 'package.json'),
    );
    await checkConsumerTypes(
      directory,
      `import { toolSuccess, type Q4HDialogContext } from '@longrun-ai/kernel';
import type { CreateDomindsAppFn } from '@longrun-ai/kernel/app-host-contract';
const attention: Q4HDialogContext = { selfId: 'self', rootId: 'root', agentId: 'agent', taskDocPath: 'task.tsk', questions: [], answers: [] };
const createApp: CreateDomindsAppFn = async () => ({ tools: {} });
void [attention, createApp, toolSuccess];
`,
    );
  });
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
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.json, installJsonInput);
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
    rejected('manifest-class', new InstallManifestClass()).ok,
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
    rejected('manifest-getter', getterInstallJson).ok,
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
    rejected('manifest-symbol', symbolInstallJson).ok,
    false,
    'Install json must reject symbol-keyed properties instead of silently discarding them.',
  );
  rejected('unsupported-contribution', {
    ...installJsonInput,
    contributes: {
      unsupportedExtension: {},
    },
  });
  rejected('unsupported-reminder-owner', {
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
    rejected(`schema-${testCase.label}`, {
      ...installJsonInput,
      contributes: {
        toolsets: [
          { id: 'probe', tools: [{ name: 'probe_tool', parameters: testCase.parameters }] },
        ],
      },
    });
  }
  assert.equal(
    getterRead,
    false,
    'JsonSchema validation must reject accessors without invoking them.',
  );

  const invalidOptionalFieldCases: ReadonlyArray<Readonly<{ label: string; input: unknown }>> = [
    {
      label: 'displayName wrong type',
      input: { ...installJsonInput, displayName: 42 },
    },
    {
      label: 'package.version wrong type',
      input: {
        ...installJsonInput,
        package: { ...installJsonInput.package, version: 42 },
      },
    },
    {
      label: 'frontend.basePath wrong type',
      input: {
        ...installJsonInput,
        frontend: { kind: 'http', basePath: 42 },
      },
    },
    {
      label: 'frontend.wsPath wrong type',
      input: {
        ...installJsonInput,
        frontend: { kind: 'http', wsPath: false },
      },
    },
    {
      label: 'frontend.defaultPort fractional value',
      input: {
        ...installJsonInput,
        frontend: { kind: 'http', defaultPort: 43123.5 },
      },
    },
    {
      label: 'frontend.defaultPort negative zero',
      input: {
        ...installJsonInput,
        frontend: { kind: 'http', defaultPort: -0 },
      },
    },
    {
      label: 'frontend.defaultPort above TCP port range',
      input: {
        ...installJsonInput,
        frontend: { kind: 'http', defaultPort: 65_536 },
      },
    },
    {
      label: 'teammatesYamlRelPath wrong type',
      input: {
        ...installJsonInput,
        contributes: { teammatesYamlRelPath: 42 },
      },
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
    },
    {
      label: 'duplicate reminder owner ref',
      input: {
        ...installJsonInput,
        contributes: {
          reminderOwners: [{ ref: 'probe_owner' }, { ref: 'probe_owner' }],
        },
      },
    },
  ];
  for (const testCase of invalidOptionalFieldCases) {
    rejected(`field-${testCase.label}`, testCase.input);
  }
  assert.equal(
    parseDomindsAppInstallJson({
      ...installJsonInput,
      frontend: { kind: 'http', defaultPort: 0 },
    }).ok,
    true,
    'Port 0 remains the explicit request for automatic port assignment.',
  );
  assert.equal(
    parseDomindsAppInstallJson({
      ...installJsonInput,
      frontend: { kind: 'http', defaultPort: 65_535 },
    }).ok,
    true,
    'The highest valid TCP port must remain accepted.',
  );
  assert.equal(isTeamMgmtGuideTopicKey('topics'), true);
  assert.equal(isTeamMgmtGuideTopicKey('unknown-topic-data'), false);
  assert.deepEqual(supportedLanguageCodes, ['en', 'zh']);
  assert.equal(escapeHtmlAttr('x"y'), 'x&quot;y');
  const payload = 'opaque-ipc-data-34f8';
  assert.deepEqual(toolSuccess(payload), { content: payload, outcome: 'success' });
  assert.deepEqual(appToolSuccess(payload), { output: { content: payload, outcome: 'success' } });
  await evidence.write();
  console.log('Public manifest boundary and source-only consumer: PASS');
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
