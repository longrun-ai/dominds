import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { loadLocalAppEntry } from './helpers/app-entry';
import {
  assertRecord,
  assertStructuredResult,
  createFakePlaywrightEnvironment,
  createWebDevFixture,
  pathExists,
  requireReminderStateAdded,
  requireSingleUpsertReminder,
  sessionIdFromReminder,
  type ToolCtx,
  type WebDevAppFactoryContext,
  type WebDevAppHost,
} from './helpers/web-dev-session-fixture';

function persistedSessionId(hexDigit: string): string {
  assert.match(hexDigit, /^[0-9a-f]$/);
  return `pws_${hexDigit.repeat(32)}`;
}

function obsoleteSessionId(): string {
  return `${['js', 'r'].join('')}_${'a'.repeat(32)}`;
}

function buildPersistedSession(
  id: string,
  cwdAbs: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  const timestamp = '2026-01-01T00:00:00.000Z';
  return {
    id,
    label: id,
    kind: 'web',
    state: 'degraded',
    createdAt: timestamp,
    updatedAt: timestamp,
    revision: 1,
    runtime: {
      transport: 'playwright_browser_runtime',
      cwdAbs,
      browserMode: 'desktop',
      headless: true,
    },
    bindings: {
      chromium: false,
      browser: false,
      context: false,
      page: false,
      mobileContext: false,
      mobilePage: false,
      electronApp: false,
      appWindow: false,
    },
    surfaces: [],
    lastAction: {
      at: timestamp,
      kind: 'reset',
      summary: 'persisted test session',
      actor: {
        kind: 'app_host',
      },
      ok: false,
      errorText: 'runtime unavailable',
    },
    evidence: {
      screenshots: [],
      console: [],
      network: [],
      viewportChecks: [],
    },
    qa: {
      inventory: [],
      signoff: {
        status: 'not_started',
        functional: false,
        visual: false,
        viewport: false,
        exploratory: false,
        cleanupStatus: 'not_run',
        summary: null,
        negativeChecks: [],
        exclusions: [],
        updatedAt: null,
      },
    },
    attachments: [],
    ...overrides,
  };
}

async function assertPersistedSessionRejected(
  params: Readonly<{
    id: string;
    expected: RegExp;
    overrides?: (tempRoot: string) => Readonly<Record<string, unknown>>;
  }>,
): Promise<void> {
  await assert.rejects(
    async () =>
      await createWebDevFixture({
        prepareRtws: async ({ sessionsCacheDirAbs, tempRoot }) => {
          await fs.mkdir(sessionsCacheDirAbs, { recursive: true });
          await fs.writeFile(
            path.join(sessionsCacheDirAbs, `${params.id}.json`),
            `${JSON.stringify(
              buildPersistedSession(params.id, tempRoot, params.overrides?.(tempRoot)),
            )}\n`,
            'utf-8',
          );
        },
      }),
    params.expected,
  );
}

async function runLinkedRtwsRestartContract(): Promise<void> {
  const repoRootAbs = path.resolve(__dirname, '..', '..');
  const packageRootAbs = path.join(repoRootAbs, 'dominds-apps', '@longrun-ai', 'web-dev');
  const tempContainerAbs = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-web-dev-linked-rtws-'));
  const physicalRtwsRootAbs = path.join(tempContainerAbs, 'physical-rtws');
  const linkedRtwsRootAbs = path.join(tempContainerAbs, 'linked-rtws');
  await fs.mkdir(physicalRtwsRootAbs);
  await fs.symlink(
    physicalRtwsRootAbs,
    linkedRtwsRootAbs,
    process.platform === 'win32' ? 'junction' : 'dir',
  );

  const fakeEnv = createFakePlaywrightEnvironment();
  const { appFactory } = await loadLocalAppEntry({ packageRootAbs });
  const webDevAppFactory = appFactory as unknown as (
    ctx: WebDevAppFactoryContext,
  ) => Promise<WebDevAppHost>;
  const factoryContext: WebDevAppFactoryContext = {
    appId: '@longrun-ai/web-dev',
    rtwsRootAbs: linkedRtwsRootAbs,
    rtwsAppDirAbs: path.join(linkedRtwsRootAbs, '.apps', '@longrun-ai', 'web-dev'),
    packageRootAbs,
    kernel: { scheme: 'http', host: '127.0.0.1', port: 0 },
    log: () => undefined,
    playwrightLoader: async () => fakeEnv.playwright,
  };
  const toolCtx: ToolCtx = {
    dialogId: 'dlg_linked_rtws',
    mainDialogId: 'main_linked_rtws',
    agentId: 'web_tester_from_app',
    sessionSlug: 'linked',
    callerId: 'fullstack',
  };

  let firstHost: WebDevAppHost | null = null;
  let restartedHost: WebDevAppHost | null = null;
  try {
    firstHost = await webDevAppFactory(factoryContext);
    const created = await firstHost.tools.playwright_session_new({ kind: 'web' }, toolCtx);
    assertStructuredResult(created);
    const reminderRequest = requireSingleUpsertReminder(created);
    assertRecord(reminderRequest.meta);
    const sessionId = reminderRequest.meta['sessionId'];
    assert.equal(typeof sessionId, 'string');
    if (typeof sessionId !== 'string') {
      throw new Error('Expected persisted linked-rtws session id');
    }
    await firstHost.shutdown();
    firstHost = null;

    restartedHost = await webDevAppFactory(factoryContext);
    const restartedStatus = await restartedHost.tools.playwright_session_status(
      { sessionId },
      toolCtx,
    );
    assertStructuredResult(restartedStatus);
    assert.match(restartedStatus.output.content, /state=degraded/);
    assert.match(restartedStatus.output.content, /role=controller/);
  } finally {
    await firstHost?.shutdown();
    await restartedHost?.shutdown();
    await fs.rm(tempContainerAbs, { recursive: true, force: true });
  }
}

async function runWriteTimeValidationContract(): Promise<void> {
  const fixture = await createWebDevFixture();
  try {
    const created = await fixture.host.tools.playwright_session_new(
      { kind: 'web', label: 'write-time-validation' },
      fixture.controllerCtx,
    );
    assertStructuredResult(created);
    const sessionId = sessionIdFromReminder(
      requireReminderStateAdded(
        await fixture.reminderOwner.apply(requireSingleUpsertReminder(created), {
          dialogId: fixture.controllerCtx.dialogId,
          ownedReminders: [],
        }),
      ),
    );
    const sessionFileAbs = path.join(fixture.sessionsCacheDirAbs, `${sessionId}.json`);
    const persistedBeforeMutation = await fs.readFile(sessionFileAbs);

    await assert.rejects(
      async () =>
        await fixture.host.tools.playwright_session_eval(
          {
            sessionId,
            code: 'session.runtime.transport = "corrupt_transport"; return session.runtime;',
          },
          fixture.controllerCtx,
        ),
      /\.runtime\.transport must be 'playwright_browser_runtime'/,
    );

    const persistedAfterMutation = await fs.readFile(sessionFileAbs);
    assert.deepEqual(
      persistedAfterMutation,
      persistedBeforeMutation,
      'invalid runtime mutation must not alter the persisted session',
    );
  } finally {
    await fixture.cleanup();
  }
}

async function runCoreContract(): Promise<void> {
  const fixture = await createWebDevFixture();
  let outsideCwdAbs: string | null = null;
  try {
    const created = await fixture.host.tools.playwright_session_new(
      {
        kind: 'web',
        label: 'browser-smoke',
        entryUrl: 'https://example.test/initial',
      },
      fixture.controllerCtx,
    );
    assertStructuredResult(created);
    assert.match(created.output.content, /ok: created Web Dev browser session\./);
    assert.match(
      created.output.content,
      /state=ready \| role=controller \| runtime=playwright_browser_runtime \| browserMode=desktop/,
    );
    assert.match(created.output.content, /surface: page https:\/\/example\.test\/initial/);

    const controllerReminder = requireReminderStateAdded(
      await fixture.reminderOwner.apply(requireSingleUpsertReminder(created), {
        dialogId: fixture.controllerCtx.dialogId,
        ownedReminders: [],
      }),
    );
    const sessionId = sessionIdFromReminder(controllerReminder);
    assert.match(sessionId, /^pws_[0-9a-f]{32}$/);
    assert.equal(
      await pathExists(path.join(fixture.sessionsCacheDirAbs, `${sessionId}.json`)),
      true,
    );
    const persistedSession = JSON.parse(
      await fs.readFile(path.join(fixture.sessionsCacheDirAbs, `${sessionId}.json`), 'utf-8'),
    ) as unknown;
    assertRecord(persistedSession);
    assertRecord(persistedSession['runtime']);
    assert.equal(persistedSession['runtime']['cwdAbs'], fixture.tempRoot);

    await assert.rejects(
      async () =>
        await fixture.host.tools.playwright_session_new(
          { kind: 'web', cwd: '..' },
          fixture.controllerCtx,
        ),
      /cwd must stay within the rtws root/,
    );

    outsideCwdAbs = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-web-dev-cwd-outside-'));
    await assert.rejects(
      async () =>
        await fixture.host.tools.playwright_session_new(
          { kind: 'web', cwd: outsideCwdAbs ?? undefined },
          fixture.controllerCtx,
        ),
      /cwd must stay within the rtws root/,
    );

    const linkedOutsideCwdAbs = path.join(fixture.tempRoot, 'linked-outside');
    await fs.symlink(
      outsideCwdAbs,
      linkedOutsideCwdAbs,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await assert.rejects(
      async () =>
        await fixture.host.tools.playwright_session_new(
          { kind: 'web', cwd: 'linked-outside' },
          fixture.controllerCtx,
        ),
      /cwd must stay within the rtws root/,
    );

    const evalResult = await fixture.host.tools.playwright_session_eval(
      {
        sessionId,
        surfaceHint: 'page',
        code: [
          'await goto("https://example.test/after-eval");',
          'await fill("#search", "alpha");',
          'await click("#increment");',
          'remember("lastStatus", await textContent("#status"));',
          'return {',
          '  url: url(),',
          '  title: await title(),',
          '  remembered: readState("lastStatus"),',
          '};',
        ].join('\n'),
      },
      fixture.controllerCtx,
    );
    assertStructuredResult(evalResult);
    assert.match(evalResult.output.content, /ok: session eval completed\./);
    assert.match(evalResult.output.content, /"url":"https:\/\/example\.test\/after-eval"/);
    assert.match(evalResult.output.content, /"remembered":"Clicked 1"/);

    const screenshotResult = await fixture.host.tools.playwright_session_screenshot(
      { sessionId, label: 'after-eval-proof', imageType: 'png' },
      fixture.controllerCtx,
    );
    assertStructuredResult(screenshotResult);
    assert.match(screenshotResult.output.content, /ok: session screenshot captured\./);
    const artifacts = await fs.readdir(path.join(fixture.artifactsDirAbs, sessionId));
    assert.equal(artifacts.length, 1);
    assert.ok(artifacts.some((entry) => /after-eval-proof\.png$/.test(entry)));

    const closed = await fixture.host.tools.playwright_session_close(
      { sessionId },
      fixture.controllerCtx,
    );
    assertStructuredResult(closed);
    assert.match(closed.output.content, /ok: session closed\./);

    const controllerReminderUpdate = await fixture.reminderOwner.updateReminder({
      dialogId: fixture.controllerCtx.dialogId,
      reminder: controllerReminder,
    });
    assert.equal(controllerReminderUpdate.treatment, 'drop');
  } finally {
    await fixture.cleanup();
    if (outsideCwdAbs) {
      await fs.rm(outsideCwdAbs, { recursive: true, force: true });
    }
  }

  await assert.rejects(
    async () =>
      await createWebDevFixture({
        prepareRtws: async ({ sessionsCacheDirAbs, packageRootAbs }) => {
          const sessionId = persistedSessionId('1');
          await fs.mkdir(sessionsCacheDirAbs, { recursive: true });
          await fs.writeFile(
            path.join(sessionsCacheDirAbs, `${sessionId}.json`),
            `${JSON.stringify(buildPersistedSession(sessionId, packageRootAbs))}\n`,
            'utf-8',
          );
        },
      }),
    /cwd must stay within the rtws root/,
  );

  await assert.rejects(
    async () =>
      await createWebDevFixture({
        prepareRtws: async ({ sessionsCacheDirAbs, tempRoot }) => {
          const sessionId = persistedSessionId('2');
          await fs.mkdir(sessionsCacheDirAbs, { recursive: true });
          await fs.writeFile(
            path.join(sessionsCacheDirAbs, `${sessionId}.json`),
            `${JSON.stringify(
              buildPersistedSession(sessionId, tempRoot, {
                attachments: [
                  {
                    dialogId: 'dlg_legacy',
                    rootDialogId: 'root_legacy',
                    role: 'controller',
                  },
                ],
              }),
            )}\n`,
            'utf-8',
          );
        },
      }),
    /unsupported legacy property rootDialogId/,
  );

  await assert.rejects(
    async () =>
      await createWebDevFixture({
        prepareRtws: async ({ sessionsCacheDirAbs, tempRoot }) => {
          const sessionId = persistedSessionId('3');
          await fs.mkdir(sessionsCacheDirAbs, { recursive: true });
          await fs.writeFile(
            path.join(sessionsCacheDirAbs, `${sessionId}.json`),
            `${JSON.stringify(
              buildPersistedSession(sessionId, tempRoot, { kind: 'unsupported' }),
            )}\n`,
            'utf-8',
          );
        },
      }),
    /has unsupported kind 'unsupported'/,
  );

  await assert.rejects(
    async () =>
      await createWebDevFixture({
        prepareRtws: async ({ sessionsCacheDirAbs, tempRoot }) => {
          const sessionId = persistedSessionId('4');
          await fs.mkdir(sessionsCacheDirAbs, { recursive: true });
          await fs.writeFile(
            path.join(sessionsCacheDirAbs, `${sessionId}.json`),
            `${JSON.stringify(
              buildPersistedSession(sessionId, tempRoot, {
                state: 'mystery',
                revision: 'oops',
                evidence: 'corrupt',
                qa: 'corrupt',
              }),
            )}\n`,
            'utf-8',
          );
        },
      }),
    /has unsupported state 'mystery'/,
  );

  await assertPersistedSessionRejected({
    id: obsoleteSessionId(),
    expected: /\.id must match pws_<32 lowercase hexadecimal characters>/,
  });

  await assertPersistedSessionRejected({
    id: persistedSessionId('6'),
    overrides: () => ({ revision: 0 }),
    expected: /\.revision must be a positive safe integer/,
  });

  await assertPersistedSessionRejected({
    id: persistedSessionId('c'),
    overrides: () => ({
      lastAction: {
        at: '2026-01-01T00:00:00.000Z',
        kind: 'reset',
        summary: 'obsolete component-as-agent actor',
        actor: {
          dialogId: 'apps-host',
          mainDialogId: 'apps-host',
          agentId: '@longrun-ai/web-dev',
        },
        ok: false,
        errorText: 'runtime unavailable',
      },
    }),
    expected: /\.lastAction\.actor\.kind must be 'dialog' or 'app_host'/,
  });

  await assertPersistedSessionRejected({
    id: persistedSessionId('7'),
    overrides: () => ({
      evidence: {
        screenshots: [{ unexpected: true }],
        console: [],
        network: [],
        viewportChecks: [],
      },
    }),
    expected: /\.evidence\.screenshots\[0\] contains unsupported properties: unexpected/,
  });

  await assertPersistedSessionRejected({
    id: persistedSessionId('8'),
    overrides: () => ({
      evidence: {
        screenshots: [],
        console: [{ at: '2026-01-01T00:00:00.000Z', type: 'log', text: 42 }],
        network: [],
        viewportChecks: [],
      },
    }),
    expected: /\.evidence\.console\[0\]\.text must be string/,
  });

  await assertPersistedSessionRejected({
    id: persistedSessionId('9'),
    overrides: () => ({
      evidence: {
        screenshots: [],
        console: [],
        network: [
          {
            at: '2026-01-01T00:00:00.000Z',
            kind: 'unknown',
            method: 'GET',
            url: null,
          },
        ],
        viewportChecks: [],
      },
    }),
    expected: /\.evidence\.network\[0\]\.kind is unsupported: unknown/,
  });

  await assertPersistedSessionRejected({
    id: persistedSessionId('a'),
    overrides: () => ({
      evidence: {
        screenshots: [],
        console: [],
        network: [],
        viewportChecks: [
          {
            at: '2026-01-01T00:00:00.000Z',
            pass: true,
            surfaceRole: 'page',
            url: null,
            title: null,
            metrics: {
              viewportWidth: 1280,
              viewportHeight: 720,
              documentClientWidth: 1280,
              documentClientHeight: 720,
              documentScrollWidth: 1280,
              documentScrollHeight: 720,
              outerWidth: 1280,
              outerHeight: 720,
              devicePixelRatio: 1,
              scrollX: 0,
              scrollY: 0,
            },
            requiredRegions: [],
            issues: ['contradictory persisted issue'],
          },
        ],
      },
    }),
    expected: /\.evidence\.viewportChecks\[0\]\.issues count is inconsistent/,
  });

  await assertPersistedSessionRejected({
    id: persistedSessionId('b'),
    overrides: () => ({
      qa: {
        inventory: 'corrupt',
        signoff: {
          status: 'not_started',
          functional: false,
          visual: false,
          viewport: false,
          exploratory: false,
          cleanupStatus: 'not_run',
          summary: null,
          negativeChecks: [],
          exclusions: [],
          updatedAt: null,
        },
      },
    }),
    expected: /\.qa\.inventory must be an array/,
  });

  const closedHistoryFixture = await createWebDevFixture({
    prepareRtws: async ({ sessionsCacheDirAbs, tempRoot }) => {
      const sessionId = persistedSessionId('5');
      await fs.mkdir(sessionsCacheDirAbs, { recursive: true });
      const removedCwdAbs = path.join(tempRoot, 'removed-closed-session-cwd');
      await fs.writeFile(
        path.join(sessionsCacheDirAbs, `${sessionId}.json`),
        `${JSON.stringify(buildPersistedSession(sessionId, removedCwdAbs, { state: 'closed' }))}\n`,
        'utf-8',
      );
    },
  });
  await closedHistoryFixture.cleanup();

  await runLinkedRtwsRestartContract();
  await runWriteTimeValidationContract();
}

void runCoreContract()
  .then(() => {
    console.log('OK');
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exit(1);
  });
