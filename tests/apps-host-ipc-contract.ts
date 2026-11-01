import assert from 'node:assert/strict';

import {
  parseAppsHostMessageFromKernel,
  parseAppsHostMessageToKernel,
} from '../main/apps-host/ipc-types';

function makeInstallJson(appId = 'example-app'): Record<string, unknown> {
  return {
    appId,
    package: {
      name: '@example/app',
      version: '1.0.0',
      rootAbs: 'C:\\apps\\example',
    },
    host: {
      kind: 'node_module',
      moduleRelPath: 'dist/app.js',
      exportName: 'createApp',
    },
  };
}

function makeToolCall(args: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'tool_call',
    callId: 'call-1',
    toolName: 'example_tool',
    args,
    ctx: {
      dialogId: 'dialog-1',
      mainDialogId: 'main-1',
      agentId: 'agent-1',
      taskDocPath: 'tasks/example.md',
      callerId: 'caller-1',
    },
  };
}

function makeReminderState(): Record<string, unknown> {
  return { content: 'remember this' };
}

function makeMessagesFromKernel(): ReadonlyArray<Record<string, unknown>> {
  return [
    { type: 'shutdown' },
    {
      type: 'init',
      rtwsRootAbs: 'C:\\rtws',
      kernel: { scheme: 'http', host: '127.0.0.1', port: 0 },
      apps: [
        {
          appId: 'example-app',
          runtimePort: null,
          installJson: makeInstallJson(),
        },
      ],
    },
    makeToolCall(),
    {
      type: 'reminder_apply',
      callId: 'call-2',
      appId: 'example-app',
      ownerRef: 'owner-1',
      request: {
        kind: 'upsert',
        ownerRef: 'owner-1',
        content: 'new reminder',
      },
      ctx: {
        dialogId: 'dialog-1',
        ownedReminders: [makeReminderState()],
      },
    },
    {
      type: 'reminder_update',
      callId: 'call-3',
      appId: 'example-app',
      ownerRef: 'owner-1',
      ctx: {
        dialogId: 'dialog-1',
        reminder: makeReminderState(),
      },
    },
    {
      type: 'reminder_render',
      callId: 'call-4',
      appId: 'example-app',
      ownerRef: 'owner-1',
      ctx: {
        dialogId: 'dialog-1',
        reminder: makeReminderState(),
        reminderId: 'reminder-1',
        workLanguage: 'zh',
      },
    },
  ];
}

function makeMessagesToKernel(): ReadonlyArray<Record<string, unknown>> {
  return [
    {
      type: 'ready',
      apps: [
        { appId: 'headless-app', frontend: null },
        {
          appId: 'web-app',
          frontend: {
            port: 43_001,
            baseUrl: 'http://127.0.0.1:43001',
            wsUrl: null,
          },
        },
      ],
    },
    {
      type: 'log',
      level: 'info',
      msg: 'started',
      appId: null,
    },
    {
      type: 'tool_result',
      callId: 'call-1',
      ok: true,
      output: {
        content: 'done',
        outcome: 'success',
      },
    },
    {
      type: 'reminder_apply_result',
      callId: 'call-2',
      ok: true,
      result: {
        treatment: 'add',
        reminder: makeReminderState(),
      },
    },
    {
      type: 'reminder_update_result',
      callId: 'call-3',
      ok: true,
      result: {
        treatment: 'update',
        updatedContent: 'updated',
      },
    },
    {
      type: 'reminder_render_result',
      callId: 'call-4',
      ok: true,
      message: {
        content: 'rendered',
      },
    },
  ];
}

function makeFailureMessagesToKernel(): ReadonlyArray<Record<string, unknown>> {
  return [
    {
      type: 'tool_result',
      callId: 'call-failed-tool',
      ok: false,
      errorText: 'tool failed',
    },
    {
      type: 'reminder_apply_result',
      callId: 'call-failed-apply',
      ok: false,
      errorText: 'apply failed',
    },
    {
      type: 'reminder_update_result',
      callId: 'call-failed-update',
      ok: false,
      errorText: 'update failed',
    },
    {
      type: 'reminder_render_result',
      callId: 'call-failed-render',
      ok: false,
      errorText: 'render failed',
    },
  ];
}

function assertNoOwnProperty(value: object, property: string): void {
  assert.equal(
    Object.prototype.hasOwnProperty.call(value, property),
    false,
    `Expected '${property}' to be absent`,
  );
}

function testKernelToHostValidAndRebuilt(): void {
  const initRaw = makeMessagesFromKernel()[1];
  assert.ok(initRaw);
  const init = parseAppsHostMessageFromKernel(initRaw);
  assert.equal(init.type, 'init');
  if (init.type !== 'init') throw new Error('Expected init');
  assert.deepEqual(init, initRaw);
  assert.notStrictEqual(init, initRaw);
  assert.notStrictEqual(init.kernel, initRaw['kernel']);
  assert.notStrictEqual(init.apps, initRaw['apps']);
  const initAppsRaw = initRaw['apps'];
  assert.ok(Array.isArray(initAppsRaw));
  const initAppRaw = initAppsRaw[0];
  assert.ok(typeof initAppRaw === 'object' && initAppRaw !== null);
  assert.notStrictEqual(
    init.apps[0]?.installJson,
    (initAppRaw as Record<string, unknown>)['installJson'],
  );

  const args = { nested: { value: 42 }, list: [true, null, 'value'] };
  const toolRaw = makeToolCall(args);
  const tool = parseAppsHostMessageFromKernel(toolRaw);
  assert.equal(tool.type, 'tool_call');
  if (tool.type !== 'tool_call') throw new Error('Expected tool_call');
  assert.deepEqual(tool, toolRaw);
  assert.notStrictEqual(tool.args, args);
  assert.notStrictEqual(tool.args['nested'], args.nested);
  assertNoOwnProperty(tool.ctx, 'sessionSlug');
  // The validated payload owns its data even if the untrusted sender changes its input.
  args.nested.value = 99;
  args.list.push(false);
  assert.deepEqual(tool.args, { nested: { value: 42 }, list: [true, null, 'value'] });
  const nested = tool.args['nested'];
  assert.ok(typeof nested === 'object' && nested !== null);
  const changed = Reflect.set(nested, 'value', 43);
  assert.equal(Reflect.get(nested, 'value'), changed ? 43 : 42);
  assert.equal(args.nested.value, 99);

  const apply = parseAppsHostMessageFromKernel(makeMessagesFromKernel()[3]);
  assert.equal(apply.type, 'reminder_apply');
  if (apply.type !== 'reminder_apply') throw new Error('Expected reminder_apply');
  assertNoOwnProperty(apply.request, 'meta');
  assertNoOwnProperty(apply.request, 'position');
  assertNoOwnProperty(apply.request, 'echoback');
  assertNoOwnProperty(apply.request, 'renderMode');
  const ownedReminder = apply.ctx.ownedReminders[0];
  assert.ok(ownedReminder);
  assertNoOwnProperty(ownedReminder, 'meta');
  assertNoOwnProperty(ownedReminder, 'echoback');
  assertNoOwnProperty(ownedReminder, 'renderMode');

  assert.deepEqual(parseAppsHostMessageFromKernel({ type: 'shutdown' }), {
    type: 'shutdown',
  });
  assert.equal(parseAppsHostMessageFromKernel(makeMessagesFromKernel()[4]).type, 'reminder_update');
  assert.equal(parseAppsHostMessageFromKernel(makeMessagesFromKernel()[5]).type, 'reminder_render');
}

function testKernelToHostExactKeys(): void {
  for (const message of makeMessagesFromKernel()) {
    assert.throws(
      () => parseAppsHostMessageFromKernel({ ...message, unsupportedExtension: true }),
      Error,
    );
  }

  const init = makeMessagesFromKernel()[1];
  assert.ok(init);
  assert.throws(
    () =>
      parseAppsHostMessageFromKernel({
        ...init,
        kernel: {
          ...(init['kernel'] as Record<string, unknown>),
          unsupportedExtension: true,
        },
      }),
    Error,
  );
  const initApps = init['apps'];
  assert.ok(Array.isArray(initApps));
  const firstApp = initApps[0];
  assert.ok(typeof firstApp === 'object' && firstApp !== null);
  assert.throws(
    () =>
      parseAppsHostMessageFromKernel({
        ...init,
        apps: [{ ...firstApp, unsupportedExtension: true }],
      }),
    Error,
  );
  assert.throws(
    () =>
      parseAppsHostMessageFromKernel({
        ...init,
        apps: [
          {
            ...firstApp,
            installJson: {
              ...makeInstallJson(),
              unsupportedExtension: true,
            },
          },
        ],
      }),
    Error,
  );

  const tool = makeToolCall();
  assert.throws(
    () =>
      parseAppsHostMessageFromKernel({
        ...tool,
        ctx: {
          ...(tool['ctx'] as Record<string, unknown>),
          unsupportedExtension: true,
        },
      }),
    Error,
  );

  const apply = makeMessagesFromKernel()[3];
  assert.ok(apply);
  const applyContext = apply['ctx'] as Record<string, unknown>;
  assert.throws(
    () =>
      parseAppsHostMessageFromKernel({
        ...apply,
        request: {
          ...(apply['request'] as Record<string, unknown>),
          unsupportedExtension: true,
        },
      }),
    Error,
  );
  assert.throws(
    () =>
      parseAppsHostMessageFromKernel({
        ...apply,
        ctx: { ...applyContext, unsupportedExtension: true },
      }),
    Error,
  );
  assert.throws(
    () =>
      parseAppsHostMessageFromKernel({
        ...apply,
        ctx: {
          ...applyContext,
          ownedReminders: [{ content: 'value', unsupportedExtension: true }],
        },
      }),
    Error,
  );

  const update = makeMessagesFromKernel()[4];
  assert.ok(update);
  assert.throws(
    () =>
      parseAppsHostMessageFromKernel({
        ...update,
        ctx: {
          ...(update['ctx'] as Record<string, unknown>),
          unsupportedExtension: true,
        },
      }),
    Error,
  );

  const render = makeMessagesFromKernel()[5];
  assert.ok(render);
  assert.throws(
    () =>
      parseAppsHostMessageFromKernel({
        ...render,
        ctx: {
          ...(render['ctx'] as Record<string, unknown>),
          unsupportedExtension: true,
        },
      }),
    Error,
  );
}

function testKernelToHostLosslessJsonPortsAndInstallJson(): void {
  for (const message of makeMessagesFromKernel()) {
    assert.throws(() => parseAppsHostMessageFromKernel({ ...message, invalidJson: -0 }), Error);
  }

  assert.throws(() => parseAppsHostMessageFromKernel(makeToolCall({ invalid: -0 })), Error);

  let accessorReads = 0;
  const accessorArgs: Record<string, unknown> = {};
  Object.defineProperty(accessorArgs, 'value', {
    enumerable: true,
    get: () => {
      accessorReads += 1;
      return 42;
    },
  });
  assert.throws(() => parseAppsHostMessageFromKernel(makeToolCall(accessorArgs)), Error);
  assert.equal(accessorReads, 0, 'IPC validation must not evaluate accessors');

  const init = makeMessagesFromKernel()[1];
  assert.ok(init);
  const invalidKernelPorts = [-1, 1.5, 65_536];
  for (const port of invalidKernelPorts) {
    assert.throws(
      () =>
        parseAppsHostMessageFromKernel({
          ...init,
          kernel: { scheme: 'http', host: '127.0.0.1', port },
        }),
      Error,
    );
  }
  assert.throws(
    () =>
      parseAppsHostMessageFromKernel({
        ...init,
        kernel: { scheme: 'http', host: '127.0.0.1', port: -0 },
      }),
    Error,
  );

  const invalidRuntimePorts: ReadonlyArray<unknown> = [-1, 1.5, 65_536, '43001', undefined];
  for (const runtimePort of invalidRuntimePorts) {
    const app = {
      appId: 'example-app',
      runtimePort,
      installJson: makeInstallJson(),
    };
    assert.throws(() => parseAppsHostMessageFromKernel({ ...init, apps: [app] }), Error);
  }
  const maxPortInit = parseAppsHostMessageFromKernel({
    ...init,
    kernel: { scheme: 'https', host: 'localhost', port: 65_535 },
    apps: [
      {
        appId: 'example-app',
        runtimePort: 65_535,
        installJson: makeInstallJson(),
      },
    ],
  });
  assert.equal(maxPortInit.type, 'init');
  if (maxPortInit.type !== 'init') throw new Error('Expected init');
  assert.equal(maxPortInit.kernel.port, 65_535);
  assert.equal(maxPortInit.apps[0]?.runtimePort, 65_535);

  assert.throws(
    () =>
      parseAppsHostMessageFromKernel({
        ...init,
        apps: [
          {
            appId: 'outer-app',
            runtimePort: null,
            installJson: makeInstallJson('inner-app'),
          },
        ],
      }),
    Error,
  );
}

function testHostToKernelValidAndRebuilt(): void {
  const readyRaw = makeMessagesToKernel()[0];
  assert.ok(readyRaw);
  const ready = parseAppsHostMessageToKernel(readyRaw);
  assert.equal(ready.type, 'ready');
  if (ready.type !== 'ready') throw new Error('Expected ready');
  assert.deepEqual(ready, readyRaw);
  assert.notStrictEqual(ready, readyRaw);
  assert.notStrictEqual(ready.apps, readyRaw['apps']);

  const log = parseAppsHostMessageToKernel(makeMessagesToKernel()[1]);
  assert.equal(log.type, 'log');
  if (log.type !== 'log') throw new Error('Expected log');
  assertNoOwnProperty(log, 'data');

  const tool = parseAppsHostMessageToKernel(makeMessagesToKernel()[2]);
  assert.equal(tool.type, 'tool_result');
  if (tool.type !== 'tool_result' || !tool.ok) throw new Error('Expected successful tool_result');
  assertNoOwnProperty(tool, 'reminderRequests');
  assertNoOwnProperty(tool, 'dialogReminderRequests');
  assertNoOwnProperty(tool.output, 'contentItems');

  const fullToolRaw = {
    type: 'tool_result',
    callId: 'call-full',
    ok: true,
    output: {
      content: 'with content items',
      outcome: 'partial_failure',
      contentItems: [
        { type: 'input_text', text: 'text item' },
        {
          type: 'input_image',
          mimeType: 'image/png',
          byteLength: 42,
          artifact: {
            rootId: 'root-1',
            selfId: 'dialog-1',
            status: 'running',
            relPath: 'artifacts/example.png',
          },
        },
      ],
    },
    reminderRequests: [
      {
        kind: 'delete',
        ownerRef: 'owner-1',
        meta: { nested: [true, null] },
      },
    ],
    dialogReminderRequests: [
      {
        target: { agentId: 'agent-1' },
        reminderRequests: [
          {
            kind: 'upsert',
            ownerRef: 'owner-1',
            content: 'dialog reminder',
          },
        ],
      },
    ],
  };
  const fullTool = parseAppsHostMessageToKernel(fullToolRaw);
  assert.equal(fullTool.type, 'tool_result');
  if (fullTool.type !== 'tool_result' || !fullTool.ok) {
    throw new Error('Expected successful tool_result');
  }
  assert.deepEqual(fullTool, fullToolRaw);
  assert.notStrictEqual(fullTool.output, fullToolRaw.output);
  assert.notStrictEqual(fullTool.output.contentItems, fullToolRaw.output.contentItems);
  const parsedMeta = fullTool.reminderRequests?.[0]?.meta;
  assert.deepEqual(parsedMeta, { nested: [true, null] });
  assert.notStrictEqual(parsedMeta, fullToolRaw.reminderRequests[0]?.meta);
  fullToolRaw.reminderRequests[0].meta.nested.push(false);
  assert.deepEqual(parsedMeta, { nested: [true, null] });
  assert.ok(typeof parsedMeta === 'object' && parsedMeta !== null);
  const inserted = Reflect.set(parsedMeta, 'parsedOnly', true);
  assert.equal(Reflect.get(parsedMeta, 'parsedOnly'), inserted ? true : undefined);
  assert.equal(Object.hasOwn(parsedMeta, 'parsedOnly'), inserted);
  assert.equal(Object.hasOwn(fullToolRaw.reminderRequests[0].meta, 'parsedOnly'), false);

  const dialogTarget = fullTool.dialogReminderRequests?.[0]?.target;
  assert.ok(dialogTarget);
  assertNoOwnProperty(dialogTarget, 'mainDialogId');
  assertNoOwnProperty(dialogTarget, 'sessionSlug');

  const failedTool = parseAppsHostMessageToKernel({
    type: 'tool_result',
    callId: 'call-failed',
    ok: false,
    errorText: 'failed',
  });
  assert.deepEqual(failedTool, {
    type: 'tool_result',
    callId: 'call-failed',
    ok: false,
    errorText: 'failed',
  });
  for (const failureMessage of makeFailureMessagesToKernel()) {
    assert.deepEqual(parseAppsHostMessageToKernel(failureMessage), failureMessage);
  }

  const apply = parseAppsHostMessageToKernel(makeMessagesToKernel()[3]);
  assert.equal(apply.type, 'reminder_apply_result');
  if (apply.type !== 'reminder_apply_result' || !apply.ok) {
    throw new Error('Expected successful reminder_apply_result');
  }
  if (apply.result.treatment !== 'add') throw new Error('Expected add result');
  assertNoOwnProperty(apply.result, 'position');
  assertNoOwnProperty(apply.result.reminder, 'meta');

  const update = parseAppsHostMessageToKernel(makeMessagesToKernel()[4]);
  assert.equal(update.type, 'reminder_update_result');
  if (update.type !== 'reminder_update_result' || !update.ok) {
    throw new Error('Expected successful reminder_update_result');
  }
  if (update.result.treatment !== 'update') throw new Error('Expected update result');
  assertNoOwnProperty(update.result, 'updatedMeta');

  assert.equal(
    parseAppsHostMessageToKernel(makeMessagesToKernel()[5]).type,
    'reminder_render_result',
  );
}

function testHostToKernelExactKeys(): void {
  for (const message of [...makeMessagesToKernel(), ...makeFailureMessagesToKernel()]) {
    assert.throws(
      () => parseAppsHostMessageToKernel({ ...message, unsupportedExtension: true }),
      Error,
    );
  }

  const ready = makeMessagesToKernel()[0];
  assert.ok(ready);
  assert.throws(
    () =>
      parseAppsHostMessageToKernel({
        ...ready,
        apps: [{ appId: 'app', frontend: null, unsupportedExtension: true }],
      }),
    Error,
  );
  assert.throws(
    () =>
      parseAppsHostMessageToKernel({
        ...ready,
        apps: [
          {
            appId: 'app',
            frontend: {
              port: 43_001,
              baseUrl: 'http://localhost:43001',
              wsUrl: null,
              unsupportedExtension: true,
            },
          },
        ],
      }),
    Error,
  );

  const tool = makeMessagesToKernel()[2];
  assert.ok(tool);
  assert.throws(
    () =>
      parseAppsHostMessageToKernel({
        ...tool,
        output: {
          content: 'value',
          outcome: 'success',
          contentItems: [
            {
              type: 'input_text',
              text: 'value',
              unsupportedExtension: true,
            },
          ],
        },
      }),
    Error,
  );
  assert.throws(
    () =>
      parseAppsHostMessageToKernel({
        ...tool,
        output: {
          ...(tool['output'] as Record<string, unknown>),
          unsupportedExtension: true,
        },
      }),
    Error,
  );

  const contentItemBase = {
    type: 'input_image',
    mimeType: 'image/png',
    byteLength: 1,
    artifact: {
      rootId: 'root-1',
      selfId: 'dialog-1',
      status: 'completed',
      relPath: 'artifacts/image.png',
    },
  };
  assert.throws(
    () =>
      parseAppsHostMessageToKernel({
        ...tool,
        output: {
          content: 'value',
          outcome: 'success',
          contentItems: [{ ...contentItemBase, unsupportedExtension: true }],
        },
      }),
    Error,
  );
  assert.throws(
    () =>
      parseAppsHostMessageToKernel({
        ...tool,
        output: {
          content: 'value',
          outcome: 'success',
          contentItems: [
            {
              ...contentItemBase,
              artifact: {
                ...contentItemBase.artifact,
                unsupportedExtension: true,
              },
            },
          ],
        },
      }),
    Error,
  );

  assert.throws(
    () =>
      parseAppsHostMessageToKernel({
        ...tool,
        reminderRequests: [
          {
            kind: 'delete',
            ownerRef: 'owner-1',
            unsupportedExtension: true,
          },
        ],
      }),
    Error,
  );
  assert.throws(
    () =>
      parseAppsHostMessageToKernel({
        ...tool,
        dialogReminderRequests: [
          {
            target: { dialogId: 'dialog-1' },
            reminderRequests: [],
            unsupportedExtension: true,
          },
        ],
      }),
    Error,
  );
  assert.throws(
    () =>
      parseAppsHostMessageToKernel({
        ...tool,
        dialogReminderRequests: [
          {
            target: { dialogId: 'dialog-1', unsupportedExtension: true },
            reminderRequests: [],
          },
        ],
      }),
    Error,
  );

  const apply = makeMessagesToKernel()[3];
  assert.ok(apply);
  const applyResult = apply['result'] as Record<string, unknown>;
  assert.throws(
    () =>
      parseAppsHostMessageToKernel({
        ...apply,
        result: { ...applyResult, unsupportedExtension: true },
      }),
    Error,
  );
  assert.throws(
    () =>
      parseAppsHostMessageToKernel({
        ...apply,
        result: {
          ...applyResult,
          reminder: { content: 'value', unsupportedExtension: true },
        },
      }),
    Error,
  );

  const update = makeMessagesToKernel()[4];
  assert.ok(update);
  assert.throws(
    () =>
      parseAppsHostMessageToKernel({
        ...update,
        result: {
          ...(update['result'] as Record<string, unknown>),
          unsupportedExtension: true,
        },
      }),
    Error,
  );

  const render = makeMessagesToKernel()[5];
  assert.ok(render);
  assert.throws(
    () =>
      parseAppsHostMessageToKernel({
        ...render,
        message: {
          ...(render['message'] as Record<string, unknown>),
          unsupportedExtension: true,
        },
      }),
    Error,
  );
}

function testHostToKernelShapesAndLosslessJson(): void {
  for (const message of [...makeMessagesToKernel(), ...makeFailureMessagesToKernel()]) {
    assert.throws(() => parseAppsHostMessageToKernel({ ...message, invalidJson: -0 }), Error);
  }

  const ready = makeMessagesToKernel()[0];
  assert.ok(ready);
  for (const port of [0, 1.5, 65_536]) {
    assert.throws(
      () =>
        parseAppsHostMessageToKernel({
          ...ready,
          apps: [
            {
              appId: 'app',
              frontend: {
                port,
                baseUrl: 'http://localhost',
                wsUrl: null,
              },
            },
          ],
        }),
      Error,
    );
  }

  assert.throws(
    () =>
      parseAppsHostMessageToKernel({
        type: 'log',
        level: 'info',
        msg: 'value',
        appId: null,
        data: [],
      }),
    Error,
  );

  const tool = makeMessagesToKernel()[2];
  assert.ok(tool);
  assert.throws(
    () =>
      parseAppsHostMessageToKernel({
        ...tool,
        output: { content: 'value', outcome: 'unknown' },
      }),
    Error,
  );
  assert.throws(
    () =>
      parseAppsHostMessageToKernel({
        ...tool,
        output: {
          content: 'value',
          outcome: 'success',
          contentItems: [
            {
              type: 'input_image',
              mimeType: 'image/png',
              byteLength: 1.5,
              artifact: {
                rootId: 'root-1',
                selfId: 'dialog-1',
                status: 'running',
                relPath: 'artifacts/image.png',
              },
            },
          ],
        },
      }),
    Error,
  );

  assert.throws(
    () =>
      parseAppsHostMessageToKernel({
        ...tool,
        reminderRequests: [
          {
            kind: 'delete',
            ownerRef: 'owner-1',
            meta: { invalid: -0 },
          },
        ],
      }),
    Error,
  );

  let accessorReads = 0;
  const dataWithAccessor: Record<string, unknown> = {};
  Object.defineProperty(dataWithAccessor, 'value', {
    enumerable: true,
    get: () => {
      accessorReads += 1;
      return 42;
    },
  });
  assert.throws(
    () =>
      parseAppsHostMessageToKernel({
        type: 'log',
        level: 'info',
        msg: 'value',
        appId: null,
        data: dataWithAccessor,
      }),
    Error,
  );
  assert.equal(accessorReads, 0, 'IPC validation must not evaluate accessors');

  assert.throws(
    () =>
      parseAppsHostMessageToKernel({
        type: 'reminder_apply_result',
        callId: 'call',
        ok: true,
        result: { treatment: 'update', ownedIndex: -1, reminder: makeReminderState() },
      }),
    Error,
  );
  assert.throws(
    () =>
      parseAppsHostMessageToKernel({
        type: 'reminder_update_result',
        callId: 'call',
        ok: true,
        result: { treatment: 'update', updatedContent: 42 },
      }),
    Error,
  );
  assert.throws(
    () =>
      parseAppsHostMessageToKernel({
        type: 'reminder_render_result',
        callId: 'call',
        ok: true,
        message: { content: 'value', unsupportedExtension: true },
      }),
    Error,
  );
}

function main(): void {
  testKernelToHostValidAndRebuilt();
  testKernelToHostExactKeys();
  testKernelToHostLosslessJsonPortsAndInstallJson();
  testHostToKernelValidAndRebuilt();
  testHostToKernelExactKeys();
  testHostToKernelShapesAndLosslessJson();
  console.log('apps-host IPC contract tests passed');
}

main();
