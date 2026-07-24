import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { JsonValue } from '@longrun-ai/kernel/app-json';
import { startAppsHost } from '../main/apps-host/client';
import { runDomindsAppJsonViaLocalPackage } from '../main/apps/run-app-json';

async function writeText(filePathAbs: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePathAbs), { recursive: true });
  await fs.writeFile(filePathAbs, content, 'utf-8');
}

async function main(): Promise<void> {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-apps-host-result-contract-'));
  const appRootAbs = path.join(tmpRoot, 'dominds-apps', 'probe-app');
  let shutdownHost: (() => Promise<void>) | null = null;

  try {
    await writeText(
      path.join(appRootAbs, 'package.json'),
      JSON.stringify(
        {
          name: '@tests/probe-app',
          version: '0.0.1',
          type: 'module',
          bin: {
            'probe-app': './bin/probe-app.js',
          },
          dominds: {
            appManifest: '.minds/app.yaml',
          },
        },
        null,
        2,
      ) + '\n',
    );

    await writeText(
      path.join(appRootAbs, '.minds', 'app.yaml'),
      ['apiVersion: dominds.io/v1alpha1', 'kind: DomindsApp', 'id: probe_app', ''].join('\n'),
    );

    await writeText(path.join(appRootAbs, '.minds', 'team.yaml'), 'members: {}\n');

    await writeText(
      path.join(appRootAbs, 'bin', 'probe-app.js'),
      [
        '#!/usr/bin/env node',
        'console.log(JSON.stringify({',
        "  appId: 'probe_app',",
        "  displayName: 'Probe App',",
        '  package: {',
        "    name: '@tests/probe-app',",
        "    version: '0.0.1',",
        '    rootAbs: process.cwd(),',
        '  },',
        "  host: { kind: 'node_module', moduleRelPath: './src/app.js', exportName: 'createDomindsApp' },",
        "  frontend: { kind: 'http', defaultPort: 43123, basePath: '/', wsPath: '/ws' },",
        '  contributes: {',
        '    toolsets: [',
        '      {',
        "        id: 'probe_toolset',",
        "        descriptionI18n: { zh: 'Probe toolset', en: 'Probe toolset' },",
        '        tools: [',
        '          {',
        "            name: 'modern_tool',",
        "            description: 'Modern tool',",
        "            parameters: { type: 'object', properties: {}, additionalProperties: false },",
        '          },',
        '          {',
        "            name: 'legacy_bare_tool',",
        "            description: 'Legacy bare tool',",
        "            parameters: { type: 'object', properties: {}, additionalProperties: false },",
        '          },',
        '          {',
        "            name: 'legacy_output_tool',",
        "            description: 'Legacy output tool',",
        "            parameters: { type: 'object', properties: {}, additionalProperties: false },",
        '          },',
        '          {',
        "            name: 'unsupported_result_property_tool',",
        "            description: 'Unsupported result property tool',",
        "            parameters: { type: 'object', properties: {}, additionalProperties: false },",
        '          },',
        '          {',
        "            name: 'unsupported_output_property_tool',",
        "            description: 'Unsupported output property tool',",
        "            parameters: { type: 'object', properties: {}, additionalProperties: false },",
        '          },',
        '          {',
        "            name: 'accessor_output_tool',",
        "            description: 'Accessor output tool',",
        "            parameters: { type: 'object', properties: {}, additionalProperties: false },",
        '          },',
        '          {',
        "            name: 'legacy_dialog_target_tool',",
        "            description: 'Legacy dialog target tool',",
        "            parameters: { type: 'object', properties: {}, additionalProperties: false },",
        '          },',
        '          {',
        "            name: 'unsupported_upsert_request_property_tool',",
        "            description: 'Unsupported upsert request property tool',",
        "            parameters: { type: 'object', properties: {}, additionalProperties: false },",
        '          },',
        '          {',
        "            name: 'unsupported_delete_request_property_tool',",
        "            description: 'Unsupported delete request property tool',",
        "            parameters: { type: 'object', properties: {}, additionalProperties: false },",
        '          },',
        '          {',
        "            name: 'unsupported_dialog_batch_property_tool',",
        "            description: 'Unsupported dialog batch property tool',",
        "            parameters: { type: 'object', properties: {}, additionalProperties: false },",
        '          },',
        '          {',
        "            name: 'non_finite_reminder_meta_tool',",
        "            description: 'Non-finite reminder metadata tool',",
        "            parameters: { type: 'object', properties: {}, additionalProperties: false },",
        '          },',
        '          {',
        "            name: 'non_plain_reminder_meta_tool',",
        "            description: 'Non-plain reminder metadata tool',",
        "            parameters: { type: 'object', properties: {}, additionalProperties: false },",
        '          },',
        '          {',
        "            name: 'class_instance_reminder_meta_tool',",
        "            description: 'Class-instance reminder metadata tool',",
        "            parameters: { type: 'object', properties: {}, additionalProperties: false },",
        '          },',
        '          {',
        "            name: 'cross_realm_reminder_meta_tool',",
        "            description: 'Cross-realm reminder metadata tool',",
        "            parameters: { type: 'object', properties: {}, additionalProperties: false },",
        '          },',
        '          {',
        "            name: 'fractional_reminder_position_tool',",
        "            description: 'Fractional reminder position tool',",
        "            parameters: { type: 'object', properties: {}, additionalProperties: false },",
        '          },',
        '          {',
        "            name: 'invalid_content_items_tool',",
        "            description: 'Invalid content items tool',",
        "            parameters: { type: 'object', properties: {}, additionalProperties: false },",
        '          },',
        '          {',
        "            name: 'unsupported_content_item_property_tool',",
        "            description: 'Unsupported content item property tool',",
        "            parameters: { type: 'object', properties: {}, additionalProperties: false },",
        '          },',
        '          {',
        "            name: 'valid_content_items_tool',",
        "            description: 'Valid content items tool',",
        "            parameters: { type: 'object', properties: {}, additionalProperties: false },",
        '          },',
        '        ],',
        '      },',
        '    ],',
        "    reminderOwners: [{ ref: 'probe_owner' }],",
        '  },',
        '}));',
        '',
      ].join('\n'),
    );

    await writeText(
      path.join(appRootAbs, 'src', 'app.js'),
      [
        "import vm from 'node:vm';",
        '',
        'export async function createDomindsApp() {',
        '  return {',
        '    tools: {',
        '      modern_tool: async () => ({',
        "        output: { content: 'modern ok', outcome: 'success' },",
        '      }),',
        "      legacy_bare_tool: async () => 'legacy bare string',",
        "      legacy_output_tool: async () => ({ output: 'legacy wrapped string' }),",
        '      unsupported_result_property_tool: async () => ({',
        "        output: { content: 'invalid top-level extension', outcome: 'success' },",
        '        unsupportedExtension: true,',
        '      }),',
        '      unsupported_output_property_tool: async () => ({',
        "        output: { content: 'invalid output extension', outcome: 'success', unsupportedExtension: true },",
        '      }),',
        '      accessor_output_tool: async () => {',
        "        const output = { outcome: 'success' };",
        "        Object.defineProperty(output, 'content', {",
        '          enumerable: true,',
        "          get: () => 'getter content must never cross IPC',",
        '        });',
        '        return { output };',
        '      },',
        '      legacy_dialog_target_tool: async () => ({',
        "        output: { content: 'invalid dialog target', outcome: 'success' },",
        '        dialogReminderRequests: [{',
        "          target: { agentId: 'tester', rootDialogId: 'root_2' },",
        '          reminderRequests: [],',
        '        }],',
        '      }),',
        '      unsupported_upsert_request_property_tool: async () => ({',
        "        output: { content: 'invalid upsert request extension', outcome: 'success' },",
        '        reminderRequests: [{',
        "          kind: 'upsert', ownerRef: 'probe_owner', content: 'probe', unsupportedExtension: true,",
        '        }],',
        '      }),',
        '      unsupported_delete_request_property_tool: async () => ({',
        "        output: { content: 'invalid delete request extension', outcome: 'success' },",
        '        reminderRequests: [{',
        "          kind: 'delete', ownerRef: 'probe_owner', unsupportedExtension: true,",
        '        }],',
        '      }),',
        '      unsupported_dialog_batch_property_tool: async () => ({',
        "        output: { content: 'invalid dialog batch extension', outcome: 'success' },",
        '        dialogReminderRequests: [{',
        "          target: { dialogId: 'dlg_2' }, reminderRequests: [], unsupportedExtension: true,",
        '        }],',
        '      }),',
        '      non_finite_reminder_meta_tool: async () => ({',
        "        output: { content: 'invalid non-finite metadata', outcome: 'success' },",
        '        reminderRequests: [{',
        "          kind: 'upsert', ownerRef: 'probe_owner', content: 'probe', meta: { value: NaN },",
        '        }],',
        '      }),',
        '      non_plain_reminder_meta_tool: async () => ({',
        "        output: { content: 'invalid non-plain metadata', outcome: 'success' },",
        '        reminderRequests: [{',
        "          kind: 'upsert', ownerRef: 'probe_owner', content: 'probe', meta: new Date(0),",
        '        }],',
        '      }),',
        '      class_instance_reminder_meta_tool: async () => ({',
        "        output: { content: 'invalid class metadata', outcome: 'success' },",
        '        reminderRequests: [{',
        "          kind: 'upsert', ownerRef: 'probe_owner', content: 'probe',",
        '          meta: new (class ProbeMeta { constructor() { this.value = 42; } })(),',
        '        }],',
        '      }),',
        '      cross_realm_reminder_meta_tool: async () => ({',
        "        output: { content: 'valid cross-realm metadata', outcome: 'success' },",
        '        reminderRequests: [{',
        "          kind: 'upsert', ownerRef: 'probe_owner', content: 'probe',",
        "          meta: vm.runInNewContext('({ value: 42, nested: [true, null] })'),",
        '        }],',
        '      }),',
        '      fractional_reminder_position_tool: async () => ({',
        "        output: { content: 'fractional reminder position', outcome: 'success' },",
        '        reminderRequests: [{',
        "          kind: 'upsert', ownerRef: 'probe_owner', content: 'probe', position: -1.5,",
        '        }],',
        '      }),',
        '      invalid_content_items_tool: async () => ({',
        "        output: { content: 'invalid content items', outcome: 'success', contentItems: [new Date(0), NaN] },",
        '      }),',
        '      unsupported_content_item_property_tool: async () => ({',
        "        output: { content: 'invalid content item property', outcome: 'success',",
        "          contentItems: [{ type: 'input_text', text: 'probe', unsupportedExtension: true }],",
        '        },',
        '      }),',
        '      valid_content_items_tool: async () => ({',
        "        output: { content: 'valid content items', outcome: 'success', contentItems: [",
        "          { type: 'input_text', text: 'probe text' },",
        '          {',
        "            type: 'input_image', mimeType: 'image/png', byteLength: 42,",
        '            artifact: {',
        "              rootId: 'root_1', selfId: 'dlg_1', status: 'running', relPath: 'artifacts/probe.png',",
        '            },',
        '          },',
        '        ] },',
        '      }),',
        '    },',
        '    reminderOwners: {',
        '      probe_owner: {',
        '        apply: async (request) => {',
        "          if (request.meta?.mode === 'invalid_apply') {",
        "            return { treatment: 'noop', unsupportedExtension: true };",
        '          }',
        "          if (request.meta?.mode === 'invalid_state') {",
        '            return {',
        "              treatment: 'add',",
        "              reminder: { content: 'invalid state', unsupportedExtension: true },",
        '            };',
        '          }',
        "          if (request.meta?.mode === 'fractional_position') {",
        '            return {',
        "              treatment: 'add', position: -1.5, reminder: { content: 'position probe' },",
        '            };',
        '          }',
        "          if (request.meta?.mode === 'negative_zero_position') {",
        '            return {',
        "              treatment: 'add', position: -0, reminder: { content: 'negative zero probe' },",
        '            };',
        '          }',
        "          return { treatment: 'noop' };",
        '        },',
        '        updateReminder: async (ctx) =>',
        "          ctx.reminder.meta?.mode === 'invalid_update'",
        "            ? { treatment: 'keep', unsupportedExtension: true }",
        "            : ctx.reminder.meta?.mode === 'missing_update_content'",
        "              ? { treatment: 'update', updatedMeta: { changed: true } }",
        "              : { treatment: 'keep' },",
        '        renderReminder: async (ctx) =>',
        "          ctx.reminder.meta?.mode === 'invalid_render'",
        "            ? { content: 'invalid render', unsupportedExtension: true }",
        "            : { content: 'valid render' },",
        '      },',
        '    },',
        "    start: async () => ({ port: 43123, baseUrl: 'http://127.0.0.1:43123/', wsUrl: 'ws://127.0.0.1:43123/ws' }),",
        '  };',
        '}',
        '',
      ].join('\n'),
    );

    const installJson = await runDomindsAppJsonViaLocalPackage({ packageRootAbs: appRootAbs });
    const started = await startAppsHost({
      rtwsRootAbs: tmpRoot,
      kernel: { scheme: 'http', host: '127.0.0.1', port: 0 },
      apps: [
        {
          appId: installJson.appId,
          runtimePort: null,
          installJson,
          hostSourceVersion: null,
        },
      ],
    });
    shutdownHost = started.client.shutdown;

    const ctx = {
      dialogId: 'dlg_1',
      mainDialogId: 'root_1',
      agentId: 'tester',
      taskDocPath: 'task.md',
      callerId: 'tester',
    } as const;

    const modern = await started.client.callTool('modern_tool', {}, ctx);
    assert.equal(modern.output.content, 'modern ok');
    assert.equal(modern.output.outcome, 'success');
    await assert.rejects(
      async () => await started.client.callTool('modern_tool', { invalid: Number.NaN }, ctx),
      /tool arguments for 'modern_tool' must be a lossless JSON value/,
    );
    await assert.rejects(
      async () => await started.client.callTool('modern_tool', { invalid: -0 }, ctx),
      /tool arguments for 'modern_tool' must be a lossless JSON value/,
    );
    let accessorReads = 0;
    const accessorArgs: Record<string, JsonValue> = {};
    Object.defineProperty(accessorArgs, 'value', {
      enumerable: true,
      get: () => {
        accessorReads += 1;
        return 42;
      },
    });
    await assert.rejects(
      async () => await started.client.callTool('modern_tool', accessorArgs, ctx),
      /tool arguments for 'modern_tool' must be a lossless JSON value/,
    );
    assert.equal(accessorReads, 0, 'Lossless JSON validation must not evaluate accessors.');

    await assert.rejects(
      async () => await started.client.callTool('legacy_bare_tool', {}, ctx),
      /Invalid Application Component tool result: expected \{ output: \{ content, outcome, contentItems\? \}, \.\.\. \}/,
    );
    await assert.rejects(
      async () => await started.client.callTool('legacy_output_tool', {}, ctx),
      /Invalid Application Component tool result: output must be \{ content, outcome, contentItems\? \}/,
    );
    await assert.rejects(
      async () => await started.client.callTool('unsupported_result_property_tool', {}, ctx),
      /Invalid Application Component tool result contains unsupported properties: unsupportedExtension/,
    );
    await assert.rejects(
      async () => await started.client.callTool('unsupported_output_property_tool', {}, ctx),
      /Invalid Application Component tool result output contains unsupported properties: unsupportedExtension/,
    );
    await assert.rejects(
      async () => await started.client.callTool('accessor_output_tool', {}, ctx),
      /Invalid Application Component tool result output\.content must be an enumerable data property/,
    );
    await assert.rejects(
      async () => await started.client.callTool('invalid_content_items_tool', {}, ctx),
      /Invalid Application Component tool result: output must be \{ content, outcome, contentItems\? \}/,
    );
    await assert.rejects(
      async () => await started.client.callTool('unsupported_content_item_property_tool', {}, ctx),
      /Invalid Application Component tool result: output must be \{ content, outcome, contentItems\? \}/,
    );
    assert.deepEqual(
      (await started.client.callTool('valid_content_items_tool', {}, ctx)).output.contentItems,
      [
        { type: 'input_text', text: 'probe text' },
        {
          type: 'input_image',
          mimeType: 'image/png',
          byteLength: 42,
          artifact: {
            rootId: 'root_1',
            selfId: 'dlg_1',
            status: 'running',
            relPath: 'artifacts/probe.png',
          },
        },
      ],
    );
    await assert.rejects(
      async () => await started.client.callTool('legacy_dialog_target_tool', {}, ctx),
      /Invalid dialog reminder target contains unsupported properties: rootDialogId/,
    );
    await assert.rejects(
      async () =>
        await started.client.callTool('unsupported_upsert_request_property_tool', {}, ctx),
      /Invalid Application Component tool reminder request contains unsupported properties: unsupportedExtension/,
    );
    await assert.rejects(
      async () =>
        await started.client.callTool('unsupported_delete_request_property_tool', {}, ctx),
      /Invalid Application Component tool reminder request contains unsupported properties: unsupportedExtension/,
    );
    await assert.rejects(
      async () => await started.client.callTool('unsupported_dialog_batch_property_tool', {}, ctx),
      /Invalid dialog reminder request batch contains unsupported properties: unsupportedExtension/,
    );
    await assert.rejects(
      async () => await started.client.callTool('non_finite_reminder_meta_tool', {}, ctx),
      /upsert\.meta must be JSON-serializable/,
    );
    await assert.rejects(
      async () => await started.client.callTool('non_plain_reminder_meta_tool', {}, ctx),
      /upsert\.meta must be JSON-serializable/,
    );
    await assert.rejects(
      async () => await started.client.callTool('class_instance_reminder_meta_tool', {}, ctx),
      /upsert\.meta must be JSON-serializable/,
    );
    const crossRealmMetaResult = await started.client.callTool(
      'cross_realm_reminder_meta_tool',
      {},
      ctx,
    );
    assert.deepEqual(crossRealmMetaResult.reminderRequests?.[0]?.meta, {
      value: 42,
      nested: [true, null],
    });
    const fractionalReminderPositionResult = await started.client.callTool(
      'fractional_reminder_position_tool',
      {},
      ctx,
    );
    assert.equal(
      fractionalReminderPositionResult.reminderRequests?.[0]?.position,
      -1.5,
      'Finite tool-result reminder positions remain lossless until Kernel insertion normalization.',
    );

    const ownerCtx = { dialogId: 'dlg_1', ownedReminders: [] } as const;
    const stableReminder = { content: 'stable reminder' } as const;
    await assert.rejects(
      async () =>
        await started.client.applyReminder(
          installJson.appId,
          'probe_owner',
          {
            kind: 'upsert',
            ownerRef: 'probe_owner',
            content: 'probe',
            meta: { value: Number.POSITIVE_INFINITY },
          },
          ownerCtx,
        ),
      /reminder apply request meta.*must be a lossless JSON value/,
    );
    await assert.rejects(
      async () =>
        await started.client.applyReminder(
          installJson.appId,
          'probe_owner',
          {
            kind: 'upsert',
            ownerRef: 'probe_owner',
            content: 'probe',
            meta: new Date(0) as unknown as JsonValue,
          },
          ownerCtx,
        ),
      /reminder apply request meta.*must be a lossless JSON value/,
    );
    await assert.rejects(
      async () =>
        await started.client.applyReminder(
          installJson.appId,
          'probe_owner',
          {
            kind: 'upsert',
            ownerRef: 'probe_owner',
            content: 'probe',
            position: Number.NaN,
          },
          ownerCtx,
        ),
      /reminder apply request position.*must be a lossless finite number/,
    );
    await assert.rejects(
      async () =>
        await started.client.applyReminder(
          installJson.appId,
          'probe_owner',
          {
            kind: 'upsert',
            ownerRef: 'probe_owner',
            content: 'probe',
            position: -0,
          },
          ownerCtx,
        ),
      /reminder apply request position.*must be a lossless finite number/,
    );
    assert.deepEqual(
      await started.client.applyReminder(
        installJson.appId,
        'probe_owner',
        { kind: 'upsert', ownerRef: 'probe_owner', content: 'probe' },
        ownerCtx,
      ),
      { treatment: 'noop' },
    );
    assert.deepEqual(
      await started.client.updateReminder(installJson.appId, 'probe_owner', {
        dialogId: 'dlg_1',
        reminder: stableReminder,
      }),
      { treatment: 'keep' },
    );
    assert.deepEqual(
      await started.client.renderReminder(installJson.appId, 'probe_owner', {
        dialogId: 'dlg_1',
        reminder: stableReminder,
        reminderId: 'probe_reminder',
        workLanguage: 'en',
      }),
      { content: 'valid render' },
    );
    assert.deepEqual(
      await started.client.applyReminder(
        installJson.appId,
        'probe_owner',
        {
          kind: 'upsert',
          ownerRef: 'probe_owner',
          content: 'probe',
          meta: { mode: 'fractional_position' },
        },
        ownerCtx,
      ),
      {
        treatment: 'add',
        position: -1.5,
        reminder: { content: 'position probe' },
      },
      'Finite reminder positions remain valid; the Kernel owns insertion normalization.',
    );
    await assert.rejects(
      async () =>
        await started.client.applyReminder(
          installJson.appId,
          'probe_owner',
          {
            kind: 'upsert',
            ownerRef: 'probe_owner',
            content: 'probe',
            meta: { mode: 'negative_zero_position' },
          },
          ownerCtx,
        ),
      /reminder apply result\.position must be a lossless finite number/,
    );
    await assert.rejects(
      async () =>
        await started.client.applyReminder(
          installJson.appId,
          'probe_owner',
          {
            kind: 'upsert',
            ownerRef: 'probe_owner',
            content: 'probe',
            meta: { mode: 'invalid_apply' },
          },
          ownerCtx,
        ),
      /Invalid reminder apply result contains unsupported properties: unsupportedExtension/,
    );
    await assert.rejects(
      async () =>
        await started.client.applyReminder(
          installJson.appId,
          'probe_owner',
          {
            kind: 'upsert',
            ownerRef: 'probe_owner',
            content: 'probe',
            meta: { mode: 'invalid_state' },
          },
          ownerCtx,
        ),
      /Invalid reminder apply result\.reminder contains unsupported properties: unsupportedExtension/,
    );
    await assert.rejects(
      async () =>
        await started.client.updateReminder(installJson.appId, 'probe_owner', {
          dialogId: 'dlg_1',
          reminder: { content: 'probe', meta: { mode: 'invalid_update' } },
        }),
      /Invalid reminder update result contains unsupported properties: unsupportedExtension/,
    );
    await assert.rejects(
      async () =>
        await started.client.updateReminder(installJson.appId, 'probe_owner', {
          dialogId: 'dlg_1',
          reminder: { content: 'probe', meta: { mode: 'missing_update_content' } },
        }),
      /Invalid reminder update result\.updatedContent must be string/,
    );
    await assert.rejects(
      async () =>
        await started.client.renderReminder(installJson.appId, 'probe_owner', {
          dialogId: 'dlg_1',
          reminder: { content: 'probe', meta: { mode: 'invalid_render' } },
          reminderId: 'probe_reminder',
          workLanguage: 'en',
        }),
      /Invalid reminder render result contains unsupported properties: unsupportedExtension/,
    );

    await shutdownHost();
    shutdownHost = null;
    await writeText(
      path.join(appRootAbs, 'src', 'app.js'),
      [
        'export async function createDomindsApp() {',
        '  return {',
        '    tools: {},',
        '    unsupportedExtension: async () => {},',
        '  };',
        '}',
        '',
      ].join('\n'),
    );
    await assert.rejects(
      async () =>
        await startAppsHost({
          rtwsRootAbs: tmpRoot,
          kernel: { scheme: 'http', host: '127.0.0.1', port: 0 },
          apps: [
            {
              appId: installJson.appId,
              runtimePort: null,
              installJson,
              hostSourceVersion: null,
            },
          ],
        }),
      /apps-host exited/,
      'Unknown host instance properties must prevent the app from becoming ready.',
    );

    await writeText(
      path.join(appRootAbs, 'src', 'app.js'),
      ['export async function createDomindsApp() {', '  return { tools: {} };', '}', ''].join('\n'),
    );
    await assert.rejects(
      async () =>
        await startAppsHost({
          rtwsRootAbs: tmpRoot,
          kernel: { scheme: 'http', host: '127.0.0.1', port: 0 },
          apps: [
            {
              appId: installJson.appId,
              runtimePort: null,
              installJson,
              hostSourceVersion: null,
            },
          ],
        }),
      /apps-host exited/,
      'Missing declared tool and reminder-owner handlers must prevent readiness.',
    );

    const frontendOnlyInstallJson = { ...installJson, contributes: undefined };
    await writeText(
      path.join(appRootAbs, 'src', 'app.js'),
      [
        'export async function createDomindsApp() {',
        '  return {',
        '    tools: { undeclared_tool: async () => ({',
        "      output: { content: 'undeclared', outcome: 'success' },",
        '    }) },',
        '  };',
        '}',
        '',
      ].join('\n'),
    );
    await assert.rejects(
      async () =>
        await startAppsHost({
          rtwsRootAbs: tmpRoot,
          kernel: { scheme: 'http', host: '127.0.0.1', port: 0 },
          apps: [
            {
              appId: frontendOnlyInstallJson.appId,
              runtimePort: null,
              installJson: frontendOnlyInstallJson,
              hostSourceVersion: null,
            },
          ],
        }),
      /apps-host exited/,
      'Undeclared tool handlers must prevent readiness.',
    );

    const reminderOnlyInstallJson = {
      ...installJson,
      contributes: { reminderOwners: installJson.contributes?.reminderOwners },
    };
    await writeText(
      path.join(appRootAbs, 'src', 'app.js'),
      ['export async function createDomindsApp() {', '  return { tools: {} };', '}', ''].join('\n'),
    );
    await assert.rejects(
      async () =>
        await startAppsHost({
          rtwsRootAbs: tmpRoot,
          kernel: { scheme: 'http', host: '127.0.0.1', port: 0 },
          apps: [
            {
              appId: reminderOnlyInstallJson.appId,
              runtimePort: null,
              installJson: reminderOnlyInstallJson,
              hostSourceVersion: null,
            },
          ],
        }),
      /apps-host exited/,
      'Missing declared reminder-owner handlers must prevent readiness.',
    );

    await writeText(
      path.join(appRootAbs, 'src', 'app.js'),
      [
        'export async function createDomindsApp() {',
        '  return {',
        '    tools: {},',
        '    start: async () => ({',
        '      port: 43123,',
        "      baseUrl: 'http://127.0.0.1:43123/',",
        '      wsUrl: null,',
        '      unsupportedExtension: true,',
        '    }),',
        '  };',
        '}',
        '',
      ].join('\n'),
    );
    await assert.rejects(
      async () =>
        await startAppsHost({
          rtwsRootAbs: tmpRoot,
          kernel: { scheme: 'http', host: '127.0.0.1', port: 0 },
          apps: [
            {
              appId: frontendOnlyInstallJson.appId,
              runtimePort: 43123,
              installJson: frontendOnlyInstallJson,
              hostSourceVersion: null,
            },
          ],
        }),
      /apps-host exited/,
      'Unknown start-result properties must prevent the app from becoming ready.',
    );
  } finally {
    if (shutdownHost) {
      await shutdownHost();
    }
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

void main()
  .then(() => {
    console.log('OK');
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exit(1);
  });
