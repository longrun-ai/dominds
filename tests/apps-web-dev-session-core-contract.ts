import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  rejectWebDevAction,
  runExternalWebDevScenario,
  webDevComponentIdentity,
  webDevPackageRoot,
} from './helpers/external-web-dev';
import { semanticEvidenceCollector } from './helpers/semantic-evidence';

import { loadLocalAppEntry } from './helpers/app-entry';
import {
  assertRecord,
  assertSuccessfulResult,
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

const evidence = semanticEvidenceCollector('dominds-external-apps-web-dev-session-core-contract-');
const observations: Array<{ stage: string; text: string; outcome?: string }> = [];
function observe(stage: string, text: string, outcome?: string): void {
  observations.push({ stage, text, ...(outcome ? { outcome } : {}) });
}

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
    overrides?: (tempRoot: string) => Readonly<Record<string, unknown>>;
  }>,
): Promise<void> {
  await rejectWebDevAction(
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
  );
}

async function runLinkedRtwsRestartContract(): Promise<void> {
  const packageRootAbs = webDevPackageRoot();
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

  let completed = false;
  let firstHost: WebDevAppHost | null = null;
  let restartedHost: WebDevAppHost | null = null;
  try {
    firstHost = await webDevAppFactory(factoryContext);
    const created = await firstHost.tools.playwright_session_new({ kind: 'web' }, toolCtx);
    assertSuccessfulResult(created);
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
    assertSuccessfulResult(restartedStatus);
    observe('restartedStatus', restartedStatus.output.content, restartedStatus.output.outcome);
    completed = true;
  } finally {
    await firstHost?.shutdown();
    await restartedHost?.shutdown();
    if (completed) await fs.rm(tempContainerAbs, { recursive: true, force: true });
    else console.error('Linked-rtws fixture retained after failure: ' + tempContainerAbs);
  }
}

async function runWriteTimeValidationContract(): Promise<void> {
  const fixture = await createWebDevFixture();
  let completed = false;
  try {
    const created = await fixture.host.tools.playwright_session_new(
      { kind: 'web', label: 'write-time-validation' },
      fixture.controllerCtx,
    );
    assertSuccessfulResult(created);
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

    await rejectWebDevAction(
      async () =>
        await fixture.host.tools.playwright_session_eval(
          {
            sessionId,
            code: 'session.runtime.transport = "corrupt_transport"; return session.runtime;',
          },
          fixture.controllerCtx,
        ),
    );

    const persistedAfterMutation = await fs.readFile(sessionFileAbs);
    assert.deepEqual(
      persistedAfterMutation,
      persistedBeforeMutation,
      'invalid runtime mutation must not alter the persisted session',
    );
    completed = true;
  } finally {
    await fixture.cleanup({ preserve: !completed });
  }
}

async function runCoreContract(): Promise<void> {
  const fixture = await createWebDevFixture();
  let completed = false;
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
    assertSuccessfulResult(created);
    observe('created', created.output.content, created.output.outcome);

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

    // A legal explicit cwd prevents blanket rejection of every supplied cwd from passing.
    const legalCwd = path.join(fixture.tempRoot, 'inside-cwd');
    await fs.mkdir(legalCwd);
    const legalCwdSession = await fixture.host.tools.playwright_session_new(
      { kind: 'web', cwd: 'inside-cwd' },
      fixture.controllerCtx,
    );
    assertSuccessfulResult(legalCwdSession);
    const legalCwdId = sessionIdFromReminder(
      requireReminderStateAdded(
        await fixture.reminderOwner.apply(requireSingleUpsertReminder(legalCwdSession), {
          dialogId: fixture.controllerCtx.dialogId,
          ownedReminders: [controllerReminder],
        }),
      ),
    );
    const legalCwdRecord: unknown = JSON.parse(
      await fs.readFile(path.join(fixture.sessionsCacheDirAbs, legalCwdId + '.json'), 'utf8'),
    );
    assertRecord(legalCwdRecord);
    assertRecord(legalCwdRecord['runtime']);
    assert.equal(legalCwdRecord['runtime']['cwdAbs'], legalCwd);
    assertSuccessfulResult(
      await fixture.host.tools.playwright_session_close(
        { sessionId: legalCwdId },
        fixture.controllerCtx,
      ),
    );

    await rejectWebDevAction(
      async () =>
        await fixture.host.tools.playwright_session_new(
          { kind: 'web', cwd: '..' },
          fixture.controllerCtx,
        ),
    );

    outsideCwdAbs = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-web-dev-cwd-outside-'));
    await rejectWebDevAction(
      async () =>
        await fixture.host.tools.playwright_session_new(
          { kind: 'web', cwd: outsideCwdAbs ?? undefined },
          fixture.controllerCtx,
        ),
    );

    const linkedOutsideCwdAbs = path.join(fixture.tempRoot, 'linked-outside');
    await fs.symlink(
      outsideCwdAbs,
      linkedOutsideCwdAbs,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await rejectWebDevAction(
      async () =>
        await fixture.host.tools.playwright_session_new(
          { kind: 'web', cwd: 'linked-outside' },
          fixture.controllerCtx,
        ),
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
    assertSuccessfulResult(evalResult);
    observe('evalResult', evalResult.output.content, evalResult.output.outcome);
    // Given tool inputs must reach the external browser adapter unchanged.
    assert.equal(fixture.fakeEnv.trackers.navigations.at(-1), 'https://example.test/after-eval');
    assert.deepEqual(fixture.fakeEnv.trackers.fills.at(-1), {
      selector: '#search',
      value: 'alpha',
    });
    assert.equal(fixture.fakeEnv.trackers.clicks.at(-1), '#increment');

    const screenshotResult = await fixture.host.tools.playwright_session_screenshot(
      { sessionId, label: 'after-eval-proof', imageType: 'png' },
      fixture.controllerCtx,
    );
    assertSuccessfulResult(screenshotResult);
    observe('screenshotResult', screenshotResult.output.content, screenshotResult.output.outcome);
    const artifacts = await fs.readdir(path.join(fixture.artifactsDirAbs, sessionId));
    assert.equal(artifacts.length, 1);
    assert.ok(artifacts.some((entry) => /after-eval-proof\.png$/.test(entry)));
    assert.deepEqual(
      await fs.readFile(path.join(fixture.artifactsDirAbs, sessionId, artifacts[0])),
      fixture.fakeEnv.trackers.screenshotBodies.at(-1),
      'Artifact bytes must preserve the controlled provider payload; this is not a real PNG check',
    );

    const closed = await fixture.host.tools.playwright_session_close(
      { sessionId },
      fixture.controllerCtx,
    );
    assertSuccessfulResult(closed);
    observe('closed', closed.output.content, closed.output.outcome);

    const controllerReminderUpdate = await fixture.reminderOwner.updateReminder({
      dialogId: fixture.controllerCtx.dialogId,
      reminder: controllerReminder,
    });
    assert.equal(controllerReminderUpdate.treatment, 'drop');
    completed = true;
  } finally {
    await fixture.cleanup({ preserve: !completed });
    if (outsideCwdAbs && completed) {
      await fs.rm(outsideCwdAbs, { recursive: true, force: true });
    }
  }

  const validHistory = await createWebDevFixture({
    prepareRtws: async ({ sessionsCacheDirAbs, tempRoot }) => {
      const id = persistedSessionId('0');
      await fs.mkdir(sessionsCacheDirAbs, { recursive: true });
      await fs.writeFile(
        path.join(sessionsCacheDirAbs, id + '.json'),
        JSON.stringify(buildPersistedSession(id, tempRoot)),
      );
    },
  });
  await validHistory.cleanup();

  await rejectWebDevAction(
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
  );

  await rejectWebDevAction(
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
  );

  await rejectWebDevAction(
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
  );

  await rejectWebDevAction(
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
              }),
            )}\n`,
            'utf-8',
          );
        },
      }),
  );

  await assertPersistedSessionRejected({
    id: obsoleteSessionId(),
  });

  await assertPersistedSessionRejected({
    id: persistedSessionId('6'),
    overrides: () => ({ revision: 0 }),
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

runExternalWebDevScenario(async () => {
  await runCoreContract();
  const identity = webDevComponentIdentity();
  evidence.record({
    id: 'session-core-guidance',
    scenario:
      'A selected external component creates, evaluates, captures, closes and restores sessions; valid and corrupt persisted records and rtws boundaries are exercised.',
    businessValue:
      'Keep session continuity, cwd boundaries and returned execution/evidence guidance accurate without treating generated prose as machine state.',
    context: {
      ...{
        initialUrl: 'https://example.test/initial',
        evalDestination: 'https://example.test/after-eval',
        mockClickStatus: 'Clicked 1',
        boundary:
          'Real selected component; controlled Playwright/Electron provider, no real browser/visual QA acceptance.',
      },
      componentRoot: identity.root,
      componentPackageJsonSha256: identity.packageJsonSha256,
    },
    reviewQuestions: [
      'Do the actual create/eval/capture/close receipts agree with the requested initial URL, the controlled goto/fill/click/remember operations and the observable cleanup?',
      'Does linked-rtws restart guidance explain the restored session without claiming a lost browser runtime is still ready?',
    ],
    actualText: JSON.stringify(observations, null, 2),
  });
  await evidence.write();
  console.log(
    'Selected external Web Dev machine workflow completed; semantic acceptance is separate.',
  );
});
