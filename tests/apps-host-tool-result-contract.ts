import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';

import type { JsonValue } from '@longrun-ai/kernel/app-json';
import { startAppsHost } from '../main/apps-host/client';
import { runDomindsAppJsonViaLocalPackage } from '../main/apps/run-app-json';
import { semanticEvidenceCollector } from './helpers/semantic-evidence';
import { withTempRtws } from './kernel-driver/helpers';
const evidence = semanticEvidenceCollector('dominds-component-ipc-');

async function writeText(filePathAbs: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePathAbs), { recursive: true });
  await fs.writeFile(filePathAbs, content, 'utf-8');
}

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    const appRootAbs = path.join(tmpRoot, 'dominds-apps', 'probe-app');
    let shutdownHost: (() => Promise<void>) | null = null;
    const invocationPath = path.join(tmpRoot, 'host-invocations.jsonl');
    const getterPath = path.join(tmpRoot, 'host-output-getter.marker');
    async function invocations(): Promise<{ route: string }[]> {
      let text: string;
      try {
        text = await fs.readFile(invocationPath, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      }
      return text
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    }
    async function rejected(
      id: string,
      scenario: string,
      route: string,
      action: () => Promise<unknown>,
    ) {
      const before = await invocations();
      let error: unknown;
      try {
        await action();
      } catch (value) {
        error = value;
      }
      assert.ok(
        error instanceof Error,
        'The declared malformed boundary input/result must be refused',
      );
      const after = await invocations();
      assert.deepEqual(after.slice(before.length), route === 'client' ? [] : [{ route }]);
      if (id === 'accessor-output') await assert.rejects(fs.access(getterPath), { code: 'ENOENT' });
      evidence.record({
        id,
        scenario,
        businessValue:
          'Refuse lossy or unsupported current component-boundary data without evaluating accessors or silently converting it into a different result.',
        context: {
          appId: 'probe_app',
          expectedHandlerRoute: route,
          actualHandlerDelta: JSON.stringify(after.slice(before.length)),
          scope:
            'Actual local package entry, native host subprocess and IPC. Component entry markers establish delegation; client-side invalid inputs do not execute it. No frontend listener, artifact file/image decoding, live provider or destination App architecture is claimed.',
        },
        reviewQuestions: [
          'Does the actual diagnostic accurately identify this supplied invalid shape/value and relevant tool/owner boundary, without claiming the refused result was accepted or suggesting a nonexistent repair?',
        ],
        actualText: error.message,
      });
    }

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
          "            name: 'non_plain_delete_meta_tool',",
          "            description: 'Delete metadata boundary fixture',",
          "            parameters: { type: 'object', properties: {}, additionalProperties: false },",
          '          },',
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
          "import fs from 'node:fs';",
          'const invocationPath = ' + JSON.stringify(invocationPath) + ';',
          'const getterPath = ' + JSON.stringify(getterPath) + ';',
          '',
          'export async function createDomindsApp() {',
          '  const instance = {',
          '    tools: {',
          '      non_plain_delete_meta_tool: async () => ({',
          "        output: {content: 'delete-meta-data:5b2c', outcome: 'success'},",
          "        reminderRequests: [{kind:'delete',ownerRef:'probe_owner',meta:new Date(0)}],",
          '      }),',
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
          "          get: () => { fs.writeFileSync(getterPath, 'evaluated'); return 'getter content must never cross IPC'; },",
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
          "          if (request.meta?.mode === 'date_state_meta') {",
          "            return {treatment:'add',reminder:{content:'state-meta-data:58d1',meta:new Date(0)}};",
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
          "          ctx.reminder.meta?.mode === 'date_updated_meta'",
          "            ? {treatment:'update',updatedContent:'updated-meta-data:49d6',updatedMeta:new Date(0)}",
          "            : ctx.reminder.meta?.mode === 'invalid_update'",
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
          '  const wrap = (target, prefix) => {',
          '    for (const [name, handler] of Object.entries(target)) {',
          '      target[name] = async (...args) => {',
          '        fs.appendFileSync(invocationPath, JSON.stringify({route: prefix + name}) + String.fromCharCode(10));',
          '        return await handler(...args);',
          '      };',
          '    }',
          '  };',
          "  wrap(instance.tools, 'tool:');",
          "  wrap(instance.reminderOwners.probe_owner, 'owner:');",
          '  return instance;',
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
      assert.deepEqual(
        started.ready.apps.map((app) => app.appId),
        [installJson.appId],
      );

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
      await rejected(
        'tool-args-nan',
        'Tool arguments contain {invalid: NaN}; they must not reach the component handler.',
        'client',
        async () => await started.client.callTool('modern_tool', { invalid: Number.NaN }, ctx),
      );
      await rejected(
        'tool-args-negative-zero',
        'Tool arguments contain {invalid: negative zero}; they must not reach the component handler.',
        'client',
        async () => await started.client.callTool('modern_tool', { invalid: -0 }, ctx),
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
      await rejected(
        'tool-args-accessor',
        'Tool arguments contain an enumerable accessor property; validation must not evaluate it or invoke the handler.',
        'client',
        async () => await started.client.callTool('modern_tool', accessorArgs, ctx),
      );
      assert.equal(accessorReads, 0, 'Lossless JSON validation must not evaluate accessors.');

      await rejected(
        'bare-result',
        'legacy_bare_tool returns a bare string rather than a structured output.',
        'tool:legacy_bare_tool',
        async () => await started.client.callTool('legacy_bare_tool', {}, ctx),
      );
      await rejected(
        'string-output',
        'legacy_output_tool returns output as a string rather than a structured content/outcome object.',
        'tool:legacy_output_tool',
        async () => await started.client.callTool('legacy_output_tool', {}, ctx),
      );
      await rejected(
        'extra-result-field',
        'unsupported_result_property_tool returns an extra top-level unsupportedExtension field.',
        'tool:unsupported_result_property_tool',
        async () => await started.client.callTool('unsupported_result_property_tool', {}, ctx),
      );
      await rejected(
        'extra-output-field',
        'unsupported_output_property_tool returns an extra output.unsupportedExtension field.',
        'tool:unsupported_output_property_tool',
        async () => await started.client.callTool('unsupported_output_property_tool', {}, ctx),
      );
      await rejected(
        'accessor-output',
        'accessor_output_tool returns an enumerable content getter; the result is rejected without evaluating that getter.',
        'tool:accessor_output_tool',
        async () => await started.client.callTool('accessor_output_tool', {}, ctx),
      );
      await rejected(
        'invalid-content-items',
        'invalid_content_items_tool returns Date/NaN content items.',
        'tool:invalid_content_items_tool',
        async () => await started.client.callTool('invalid_content_items_tool', {}, ctx),
      );
      await rejected(
        'extra-content-item-field',
        'unsupported_content_item_property_tool returns an input_text item with unsupportedExtension.',
        'tool:unsupported_content_item_property_tool',
        async () =>
          await started.client.callTool('unsupported_content_item_property_tool', {}, ctx),
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
      await rejected(
        'legacy-target-field',
        'legacy_dialog_target_tool uses target.rootDialogId/agentId instead of the current dialog target shape.',
        'tool:legacy_dialog_target_tool',
        async () => await started.client.callTool('legacy_dialog_target_tool', {}, ctx),
      );
      await rejected(
        'extra-upsert-field',
        'unsupported_upsert_request_property_tool returns an upsert request with unsupportedExtension.',
        'tool:unsupported_upsert_request_property_tool',
        async () =>
          await started.client.callTool('unsupported_upsert_request_property_tool', {}, ctx),
      );
      await rejected(
        'extra-delete-field',
        'unsupported_delete_request_property_tool returns a delete request with unsupportedExtension.',
        'tool:unsupported_delete_request_property_tool',
        async () =>
          await started.client.callTool('unsupported_delete_request_property_tool', {}, ctx),
      );
      await rejected(
        'extra-dialog-batch-field',
        'unsupported_dialog_batch_property_tool returns a dialog request batch with unsupportedExtension.',
        'tool:unsupported_dialog_batch_property_tool',
        async () =>
          await started.client.callTool('unsupported_dialog_batch_property_tool', {}, ctx),
      );
      await rejected(
        'nan-meta',
        'non_finite_reminder_meta_tool returns metadata containing NaN.',
        'tool:non_finite_reminder_meta_tool',
        async () => await started.client.callTool('non_finite_reminder_meta_tool', {}, ctx),
      );
      await rejected(
        'date-meta',
        'non_plain_reminder_meta_tool returns Date metadata.',
        'tool:non_plain_reminder_meta_tool',
        async () => await started.client.callTool('non_plain_reminder_meta_tool', {}, ctx),
      );
      await rejected(
        'class-meta',
        'class_instance_reminder_meta_tool returns a class-instance metadata object.',
        'tool:class_instance_reminder_meta_tool',
        async () => await started.client.callTool('class_instance_reminder_meta_tool', {}, ctx),
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
      const fractionalRequest = fractionalReminderPositionResult.reminderRequests?.[0];
      assert.ok(fractionalRequest?.kind === 'upsert');
      assert.equal(
        fractionalRequest.position,
        -1.5,
        'Finite tool-result reminder positions remain lossless until MicroKernel insertion normalization.',
      );

      const ownerCtx = { dialogId: 'dlg_1', ownedReminders: [] } as const;
      const stableReminder = { content: 'stable reminder' } as const;
      await rejected(
        'apply-request-infinity',
        'An apply request contains positive Infinity in metadata; it must not invoke the owner handler.',
        'client',
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
      );
      await rejected(
        'apply-request-date',
        'An intentionally invalid runtime apply request contains Date metadata outside JsonValue; it must not invoke the owner handler.',
        'client',
        async () =>
          await started.client.applyReminder(
            installJson.appId,
            'probe_owner',
            {
              kind: 'upsert',
              ownerRef: 'probe_owner',
              content: 'probe',
              // Intentional invalid JS-boundary input, not a valid typed value.
              meta: new Date(0) as unknown as JsonValue,
            },
            ownerCtx,
          ),
      );
      await rejected(
        'apply-request-nan-position',
        'An apply request contains NaN position; it must not invoke the owner handler.',
        'client',
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
      );
      await rejected(
        'apply-request-negative-zero-position',
        'An apply request contains negative-zero position; it must not invoke the owner handler.',
        'client',
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
        'Finite reminder positions remain valid; the MicroKernel owns insertion normalization.',
      );
      await rejected(
        'apply-result-negative-zero',
        'The actual owner apply callback returns add with negative-zero position.',
        'owner:apply',
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
      );
      await rejected(
        'extra-apply-result-field',
        'The actual owner apply callback returns noop with unsupportedExtension.',
        'owner:apply',
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
      );
      await rejected(
        'extra-added-state-field',
        'The actual owner apply callback returns add whose reminder has unsupportedExtension.',
        'owner:apply',
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
      );
      await rejected(
        'extra-update-result-field',
        'The actual owner update callback returns keep with unsupportedExtension.',
        'owner:updateReminder',
        async () =>
          await started.client.updateReminder(installJson.appId, 'probe_owner', {
            dialogId: 'dlg_1',
            reminder: { content: 'probe', meta: { mode: 'invalid_update' } },
          }),
      );
      await rejected(
        'missing-updated-content',
        'The actual owner update callback returns update with only updatedMeta and no updatedContent.',
        'owner:updateReminder',
        async () =>
          await started.client.updateReminder(installJson.appId, 'probe_owner', {
            dialogId: 'dlg_1',
            reminder: { content: 'probe', meta: { mode: 'missing_update_content' } },
          }),
      );
      await rejected(
        'extra-render-result-field',
        'The actual owner render callback returns content with unsupportedExtension.',
        'owner:renderReminder',
        async () =>
          await started.client.renderReminder(installJson.appId, 'probe_owner', {
            dialogId: 'dlg_1',
            reminder: { content: 'probe', meta: { mode: 'invalid_render' } },
            reminderId: 'probe_reminder',
            workLanguage: 'en',
          }),
      );

      await rejected(
        'delete-date-meta',
        'A real tool handler returns a delete reminder request with Date metadata, which is serializable but not a lossless JSON/plain-data value.',
        'tool:non_plain_delete_meta_tool',
        () => started.client.callTool('non_plain_delete_meta_tool', {}, ctx),
      );
      await rejected(
        'apply-state-date-meta',
        'The actual owner apply callback returns add with Date in the returned reminder state metadata.',
        'owner:apply',
        () =>
          started.client.applyReminder(
            installJson.appId,
            'probe_owner',
            {
              kind: 'upsert',
              ownerRef: 'probe_owner',
              content: 'probe',
              meta: { mode: 'date_state_meta' },
            },
            ownerCtx,
          ),
      );
      await rejected(
        'update-date-meta',
        'The actual owner update callback returns updatedContent with Date in updatedMeta.',
        'owner:updateReminder',
        () =>
          started.client.updateReminder(installJson.appId, 'probe_owner', {
            dialogId: 'dlg_1',
            reminder: { content: 'probe', meta: { mode: 'date_updated_meta' } },
          }),
      );

      await shutdownHost();
      shutdownHost = null;
      const frontendOnlyInstallJson = { ...installJson, contributes: undefined };
      const reminderOnlyInstallJson = {
        ...installJson,
        contributes: { reminderOwners: installJson.contributes?.reminderOwners },
      };
      const readinessCases = [
        {
          id: 'host-extra-instance-field',
          scenario:
            'The loaded factory returns tools plus an unsupported top-level instance field.',
          install: installJson,
          port: null,
          body: 'return {tools:{},unsupportedExtension:async()=>{}};',
          phase: 'factory',
        },
        {
          id: 'host-missing-declared-handlers',
          scenario: 'The loaded factory omits declared tool and reminder-owner handlers.',
          install: installJson,
          port: null,
          body: 'return {tools:{}};',
          phase: 'factory',
        },
        {
          id: 'host-undeclared-tool',
          scenario: 'A frontend-only declaration is paired with an undeclared tool handler.',
          install: frontendOnlyInstallJson,
          port: null,
          body: "return {tools:{undeclared_tool:async()=>({output:{content:'undeclared',outcome:'success'}})}};",
          phase: 'factory',
        },
        {
          id: 'host-missing-declared-owner',
          scenario: 'A reminder-only declaration is paired with no declared owner handler.',
          install: reminderOnlyInstallJson,
          port: null,
          body: 'return {tools:{}};',
          phase: 'factory',
        },
        {
          id: 'host-extra-start-result-field',
          scenario:
            'A valid frontend-only factory actually enters start, then returns an unsupported start-result field alongside its declared URL data.',
          install: frontendOnlyInstallJson,
          port: 43123,
          body: "return {tools:{},start:async()=>{ fs.appendFileSync(marker, '\\nstart'); return {port:43123,baseUrl:'http://127.0.0.1:43123/',wsUrl:null,unsupportedExtension:true}; }};",
          phase: 'start',
        },
      ] as const;
      for (const item of readinessCases) {
        const marker = path.join(tmpRoot, item.id + '.marker');
        await writeText(
          path.join(appRootAbs, 'src', 'app.js'),
          [
            "import fs from 'node:fs';",
            'const marker=' + JSON.stringify(marker) + ';',
            "export async function createDomindsApp() { fs.writeFileSync(marker, 'factory'); " +
              item.body +
              ' }',
          ].join('\n'),
        );
        const logs: string[] = [];
        const originalError = console.error;
        console.error = (...parts: unknown[]) => {
          logs.push(parts.map(String).join(' '));
          originalError(...parts);
        };
        let error: unknown;
        let unexpectedlyReady: Awaited<ReturnType<typeof startAppsHost>> | undefined;
        try {
          try {
            unexpectedlyReady = await startAppsHost({
              rtwsRootAbs: tmpRoot,
              kernel: { scheme: 'http', host: '127.0.0.1', port: 0 },
              apps: [
                {
                  appId: item.install.appId,
                  runtimePort: item.port,
                  installJson: item.install,
                  hostSourceVersion: null,
                },
              ],
            });
          } catch (value) {
            error = value;
          }
        } finally {
          console.error = originalError;
          if (unexpectedlyReady) await unexpectedlyReady.client.shutdown();
        }
        assert.equal(unexpectedlyReady, undefined);
        assert.ok(error instanceof Error);
        const phases = (await fs.readFile(marker, 'utf8')).split('\n');
        assert.deepEqual(phases, item.phase === 'start' ? ['factory', 'start'] : ['factory']);
        evidence.record({
          id: item.id,
          scenario: item.scenario,
          businessValue:
            'Prevent an invalid or incomplete compatibility component from becoming ready, while distinguishing its real validation refusal from a bootstrap failure before the fixture ran.',
          context: {
            actualEnteredPhases: JSON.stringify(phases),
            givenContributes: JSON.stringify(item.install.contributes ?? null),
            declaredRuntimePort: item.port ?? 'none',
            validControl:
              'The same package entry and host pipeline previously became ready and executed actual tool/owner IPC positive controls.',
            scope:
              'Actual owned local host subprocess. Per-case native file markers prove factory/start entry before refusal. The start method only returns URL data; no real HTTP/WebSocket frontend listener or browser interaction is established.',
          },
          reviewQuestions: [
            'Do the actual error and parent-received runtime IPC diagnostics explain this specific invalid declaration/handler/result accurately, with no false ready state or unrelated bootstrap cause?',
          ],
          actualText: JSON.stringify({ error: error.message, runtimeDiagnostics: logs }, null, 2),
        });
      }
    } finally {
      if (shutdownHost) {
        await shutdownHost();
      }
    }
  });
  await evidence.write();
}

void main()
  .then(() => {
    console.log('OK');
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exit(1);
  });
