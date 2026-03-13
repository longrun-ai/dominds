import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { loadLocalAppEntry } from './helpers/app-entry';

type ToolCtx = Readonly<{
  dialogId: string;
  rootDialogId: string;
  agentId: string;
  sessionSlug?: string;
  callerId: string;
}>;

type ReminderRequest =
  | Readonly<{
      kind: 'upsert';
      ownerRef: string;
      content: string;
      meta?: unknown;
      position?: number;
      echoback?: boolean;
    }>
  | Readonly<{
      kind: 'delete';
      ownerRef: string;
      meta?: unknown;
    }>;

type DialogReminderBatch = Readonly<{
  target: Readonly<Record<string, unknown>>;
  reminderRequests: ReadonlyArray<ReminderRequest>;
}>;

type StructuredToolResult = Readonly<{
  output: string;
  reminderRequests?: ReadonlyArray<ReminderRequest>;
  dialogReminderRequests?: ReadonlyArray<DialogReminderBatch>;
}>;

type ReminderState = Readonly<{
  content: string;
  meta?: unknown;
  echoback?: boolean;
}>;

type ReminderApplyResult =
  | Readonly<{ treatment: 'noop' }>
  | Readonly<{ treatment: 'add'; reminder: ReminderState; position?: number }>
  | Readonly<{ treatment: 'update'; ownedIndex: number; reminder: ReminderState }>
  | Readonly<{ treatment: 'delete'; ownedIndex: number }>;

type ReminderUpdateResult =
  | Readonly<{ treatment: 'keep' | 'drop' }>
  | Readonly<{ treatment: 'update'; updatedContent: string; updatedMeta?: unknown }>;

type ReminderOwnerHandler = Readonly<{
  apply: (
    request: ReminderRequest,
    ctx: Readonly<{ dialogId: string; ownedReminders: ReadonlyArray<ReminderState> }>,
  ) => Promise<ReminderApplyResult>;
  updateReminder: (
    ctx: Readonly<{ dialogId: string; reminder: ReminderState }>,
  ) => Promise<ReminderUpdateResult>;
  renderReminder: (
    ctx: Readonly<{
      dialogId: string;
      reminder: ReminderState;
      reminderNo: number;
      workLanguage: 'zh' | 'en';
    }>,
  ) => Promise<Readonly<{ content: string }>>;
}>;

type AppHost = Readonly<{
  tools: Readonly<
    Record<
      string,
      (args: Record<string, unknown>, ctx: ToolCtx) => Promise<string | StructuredToolResult>
    >
  >;
  reminderOwners?: Readonly<Record<string, ReminderOwnerHandler>>;
}>;

type BrowserRuntimePageState = {
  url: string;
  title: string;
  statusText: string;
  searchValue: string;
  html: string;
};

type FakePage = {
  on: (eventName: string, handler: (payload: unknown) => void | Promise<void>) => void;
  goto: (url: string, _options?: unknown) => Promise<void>;
  reload: (_options?: unknown) => Promise<void>;
  waitForLoadState: (_state?: unknown) => Promise<void>;
  evaluate: <T>(fn: () => T) => Promise<T>;
  click: (selector: string) => Promise<void>;
  fill: (selector: string, value: string) => Promise<void>;
  textContent: (selector: string) => Promise<string | null>;
  title: () => Promise<string>;
  url: () => string;
  content: () => Promise<string>;
  waitForSelector: (selector: string) => Promise<Readonly<{ selector: string }>>;
  locator: (selector: string) => Readonly<{ selector: string }>;
  screenshot: (_options?: unknown) => Promise<Buffer>;
  isClosed: () => boolean;
  close: () => Promise<void>;
};

type FakeBrowserContext = {
  newPage: () => Promise<FakePage>;
  pages: () => Promise<ReadonlyArray<FakePage>>;
  close: () => Promise<void>;
};

type FakeBrowser = {
  newContext: (_options?: unknown) => Promise<FakeBrowserContext>;
  close: () => Promise<void>;
};

type FakeBrowserType = {
  launch: (_options?: unknown) => Promise<FakeBrowser>;
};

type FakePlaywrightModule = Readonly<{
  chromium: FakeBrowserType;
  _electron: Readonly<{
    launch: (_options?: unknown) => Promise<FakeElectronApplication>;
  }>;
  devices: Readonly<Record<string, Record<string, unknown>>>;
}>;

type FakeElectronApplication = {
  firstWindow: () => Promise<FakePage>;
  windows: () => Promise<ReadonlyArray<FakePage>>;
  context: () => Promise<FakeBrowserContext>;
  close: () => Promise<void>;
};

type FakeConsoleMessage = Readonly<{
  type: () => Promise<string>;
  text: () => Promise<string>;
}>;

type FakeRequest = Readonly<{
  method: () => Promise<string>;
  url: () => Promise<string>;
  failure: () => Promise<Readonly<{ errorText: string }> | null>;
}>;

type FakeResponse = Readonly<{
  url: () => Promise<string>;
  status: () => Promise<number>;
  request: () => Promise<FakeRequest>;
}>;

type HostFactoryContext = Readonly<{
  appId: string;
  rtwsRootAbs: string;
  rtwsAppDirAbs: string;
  packageRootAbs: string;
  kernel: { host: string; port: number };
  log: (
    level: 'info' | 'warn' | 'error',
    msg: string,
    data?: Readonly<Record<string, unknown>>,
  ) => void;
  playwrightLoader?: () => Promise<FakePlaywrightModule>;
}>;

type AppModule = Readonly<{
  createDomindsApp: (ctx: HostFactoryContext) => Promise<AppHost>;
}>;

async function pathExists(absPath: string): Promise<boolean> {
  try {
    await fs.access(absPath);
    return true;
  } catch {
    return false;
  }
}

function assertStructuredResult(
  result: string | StructuredToolResult,
): asserts result is StructuredToolResult {
  assert.equal(typeof result, 'object');
  assert.notEqual(result, null);
  assert.equal(typeof result.output, 'string');
}

function assertRecord(value: unknown): asserts value is Record<string, unknown> {
  assert.equal(typeof value, 'object');
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
}

function requireSingleUpsertReminder(result: StructuredToolResult): ReminderRequest {
  assert.ok(Array.isArray(result.reminderRequests), 'expected reminderRequests');
  assert.equal(
    result.reminderRequests?.length,
    1,
    'expected exactly one current-dialog reminder request',
  );
  const request = result.reminderRequests?.[0];
  assert.ok(request, 'expected reminder request');
  assert.equal(request.kind, 'upsert');
  return request;
}

function requireReminderStateAdded(result: ReminderApplyResult): ReminderState {
  assert.equal(result.treatment, 'add');
  return result.reminder;
}

function createPageState(url: string): BrowserRuntimePageState {
  if (url.startsWith('data:text/html,')) {
    return {
      url,
      title: 'Smoke',
      statusText: '',
      searchValue: '',
      html: "<html><head><title>Smoke</title></head><body><input id='name'/><button id='go'>Go</button><div id='out'></div></body></html>",
    };
  }
  if (url === 'https://example.test/after-eval') {
    return {
      url,
      title: 'After Eval',
      statusText: 'Ready',
      searchValue: '',
      html: '<main><h1>After Eval</h1><p id="status">Ready</p><div id="search-value"></div></main>',
    };
  }
  return {
    url,
    title: 'Initial Page',
    statusText: 'Idle',
    searchValue: '',
    html: '<main><h1>Initial Page</h1><button id="increment">Increment</button><p id="status">Idle</p><div id="search-value"></div></main>',
  };
}

function buildRenderedHtml(state: BrowserRuntimePageState): string {
  if (state.url.startsWith('data:text/html,')) {
    return `<html><head><title>${state.title}</title></head><body><input id="name" value="${state.searchValue}"/><button id="go">Go</button><div id="out">${state.statusText}</div></body></html>`;
  }
  return `<main><h1>${state.title}</h1><button id="increment">Increment</button><p id="status">${state.statusText}</p><div id="search-value">${state.searchValue}</div></main>`;
}

function createFakePlaywrightEnvironment() {
  const trackers = {
    launched: 0,
    browserClosed: 0,
    contextClosed: 0,
    reloads: 0,
    electronLaunched: 0,
    electronClosed: 0,
    newContextOptions: [] as unknown[],
    electronLaunchOptions: [] as unknown[],
    screenshotCalls: [] as unknown[],
  };

  function createFakePage(initialUrl = 'about:blank'): FakePage {
    let currentState = createPageState(initialUrl);
    let pageClosed = false;
    const listeners = new Map<string, Array<(payload: unknown) => void | Promise<void>>>();

    const emit = async (eventName: string, payload: unknown) => {
      const handlers = listeners.get(eventName) ?? [];
      for (const handler of handlers) {
        await handler(payload);
      }
    };

    const makeRequest = (method: string, url: string, failureText?: string): FakeRequest => ({
      method: async () => method,
      url: async () => url,
      failure: async () => (failureText ? { errorText: failureText } : null),
    });

    const makeResponse = (request: FakeRequest, status: number): FakeResponse => ({
      url: async () => await request.url(),
      status: async () => status,
      request: async () => request,
    });

    const emitNavigation = async (url: string) => {
      const request = makeRequest('GET', url);
      await emit('request', request);
      await emit('response', makeResponse(request, 200));
    };

    return {
      on: (eventName, handler) => {
        const list = listeners.get(eventName) ?? [];
        list.push(handler);
        listeners.set(eventName, list);
      },
      goto: async (url, _options) => {
        await emitNavigation(url);
        currentState = createPageState(url);
        currentState.html = buildRenderedHtml(currentState);
      },
      reload: async (_options) => {
        trackers.reloads += 1;
        await emitNavigation(currentState.url);
        currentState = createPageState(currentState.url);
        currentState.html = buildRenderedHtml(currentState);
      },
      waitForLoadState: async (_state) => undefined,
      evaluate: async (fn) => fn(),
      click: async (selector) => {
        if (selector === '#increment') {
          currentState.statusText = 'Clicked 1';
          currentState.title = 'After Click';
          currentState.html = buildRenderedHtml(currentState);
          await emit('console', {
            type: async () => 'log',
            text: async () => 'Increment clicked',
          } satisfies FakeConsoleMessage);
          return;
        }
        assert.equal(selector, '#go');
        currentState.statusText = currentState.searchValue;
        currentState.html = buildRenderedHtml(currentState);
        await emit('console', {
          type: async () => 'info',
          text: async () => `Submitted ${currentState.searchValue}`,
        } satisfies FakeConsoleMessage);
      },
      fill: async (selector, value) => {
        if (selector !== '#search' && selector !== '#name') {
          throw new Error(`unexpected fill selector: ${selector}`);
        }
        currentState.searchValue = value;
        currentState.html = buildRenderedHtml(currentState);
      },
      textContent: async (selector) => {
        if (selector === '#status') return currentState.statusText;
        if (selector === '#search-value') return currentState.searchValue;
        if (selector === '#out') return currentState.statusText;
        return null;
      },
      title: async () => currentState.title,
      url: () => currentState.url,
      content: async () => currentState.html,
      waitForSelector: async (selector) => {
        if (
          selector !== '#status' &&
          selector !== '#search-value' &&
          selector !== '#increment' &&
          selector !== '#name' &&
          selector !== '#go' &&
          selector !== '#out'
        ) {
          throw new Error(`missing selector: ${selector}`);
        }
        return { selector };
      },
      locator: (selector) => ({ selector }),
      screenshot: async (options) => {
        trackers.screenshotCalls.push(options ?? null);
        return Buffer.from(
          `fake-screenshot:${currentState.url}:${JSON.stringify(options ?? null)}`,
        );
      },
      isClosed: () => pageClosed,
      close: async () => {
        pageClosed = true;
      },
    };
  }

  function createFakeBrowserContext(): FakeBrowserContext {
    const pages: FakePage[] = [];
    let contextClosed = false;
    return {
      newPage: async () => {
        const page = createFakePage();
        pages.push(page);
        return page;
      },
      pages: async () => (contextClosed ? [] : pages.filter((page) => !page.isClosed())),
      close: async () => {
        trackers.contextClosed += 1;
        contextClosed = true;
        await Promise.all(pages.map(async (page) => await page.close()));
      },
    };
  }

  function createFakeBrowser(): FakeBrowser {
    return {
      newContext: async (options) => {
        trackers.newContextOptions.push(options ?? null);
        return createFakeBrowserContext();
      },
      close: async () => {
        trackers.browserClosed += 1;
      },
    };
  }

  function createFakeElectronApplication(options?: unknown): FakeElectronApplication {
    trackers.electronLaunched += 1;
    trackers.electronLaunchOptions.push(options ?? null);
    const launchArgs =
      typeof options === 'object' &&
      options !== null &&
      'args' in options &&
      Array.isArray(options.args)
        ? options.args
        : [];
    const entry = typeof launchArgs[0] === 'string' ? launchArgs[0] : '.';
    const windowUrl = `electron://app/${entry}`;
    const browserContext = createFakeBrowserContext();
    let appClosed = false;
    let firstWindowPage: FakePage | null = null;
    return {
      firstWindow: async () => {
        if (firstWindowPage) return firstWindowPage;
        firstWindowPage = createFakePage(windowUrl);
        return firstWindowPage;
      },
      windows: async () => {
        if (appClosed) return [];
        const page = await (firstWindowPage
          ? Promise.resolve(firstWindowPage)
          : Promise.resolve(createFakePage(windowUrl)));
        if (!firstWindowPage) {
          firstWindowPage = page;
        }
        return page.isClosed() ? [] : [page];
      },
      context: async () => browserContext,
      close: async () => {
        if (appClosed) return;
        appClosed = true;
        trackers.electronClosed += 1;
        await browserContext.close();
        if (firstWindowPage && !firstWindowPage.isClosed()) {
          await firstWindowPage.close();
        }
      },
    };
  }

  const playwright: FakePlaywrightModule = {
    chromium: {
      launch: async () => {
        trackers.launched += 1;
        return createFakeBrowser();
      },
    },
    _electron: {
      launch: async (options) => createFakeElectronApplication(options),
    },
    devices: {
      'iPhone 13': { viewport: { width: 390, height: 844 } },
    },
  };

  return { playwright, trackers };
}

async function main(): Promise<void> {
  const repoRootAbs = path.resolve(__dirname, '..', '..');
  const appId = '@longrun-ai/web-dev';
  const appIdPathParts = ['@longrun-ai', 'web-dev'];
  const packageRootAbs = path.join(repoRootAbs, 'dominds-apps', ...appIdPathParts);
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-web-dev-session-prototype-'));
  const rtwsAppDirAbs = path.join(tempRoot, '.apps', ...appIdPathParts);
  const sessionsCacheDirAbs = path.join(
    tempRoot,
    '.cache',
    ...appIdPathParts,
    'js-repl',
    'sessions',
  );
  const artifactsDirAbs = path.join(tempRoot, '.cache', ...appIdPathParts, 'js-repl', 'artifacts');
  const legacySessionsDirAbs = path.join(rtwsAppDirAbs, 'state', 'js-repl', 'sessions');

  try {
    const { appFactory } = await loadLocalAppEntry({ packageRootAbs });
    const fakeEnv = createFakePlaywrightEnvironment();

    const host = (await appFactory({
      appId,
      rtwsRootAbs: tempRoot,
      rtwsAppDirAbs,
      packageRootAbs,
      kernel: { host: '127.0.0.1', port: 0 },
      log: () => undefined,
      playwrightLoader: async () => fakeEnv.playwright,
    })) as AppHost;

    const reminderOwner = host.reminderOwners?.['js_repl_session'];
    assert.ok(reminderOwner, 'expected js_repl_session reminder owner');

    const controllerCtx: ToolCtx = {
      dialogId: 'dlg_controller',
      rootDialogId: 'root_demo',
      agentId: 'web_tester_from_app',
      sessionSlug: 'smoke',
      callerId: 'fullstack',
    };
    const observerCtx: ToolCtx = {
      dialogId: 'dlg_observer',
      rootDialogId: 'root_demo',
      agentId: 'web_developer_from_app',
      sessionSlug: 'fix-loop',
      callerId: 'fullstack',
    };

    const created = await host.tools.playwright_session_new(
      {
        kind: 'web',
        label: 'browser-smoke',
        entryUrl: 'https://example.test/initial',
      },
      controllerCtx,
    );
    assertStructuredResult(created);
    assert.match(created.output, /ok: created Web Dev browser session\./);
    assert.match(
      created.output,
      /state=ready \| role=controller \| runtime=playwright_browser_runtime \| browserMode=desktop/,
    );
    assert.match(created.output, /surface: page https:\/\/example\.test\/initial/);
    assert.match(
      created.output,
      /coverage snapshot: inventory=0 functional=0\/0 visual=0\/0 pendingFunctional=none pendingVisual=none/,
    );
    assert.match(
      created.output,
      /decision gate: status=not_started functional=pending visual=pending viewport=pending exploratory=pending cleanup=not_run/,
    );
    assert.match(
      created.output,
      /qa relation: coverage snapshot tracks exercised coverage; decision gate stays manual until signoff_record marks it pass\./,
    );
    assert.match(created.output, /reminder sync: current=refreshed; other=none/);
    assert.equal(fakeEnv.trackers.launched, 1);
    assert.deepEqual(fakeEnv.trackers.newContextOptions[0], {
      viewport: { width: 1440, height: 960 },
    });

    const currentUpsert = requireSingleUpsertReminder(created);
    const currentReminderState = requireReminderStateAdded(
      await reminderOwner.apply(currentUpsert, {
        dialogId: controllerCtx.dialogId,
        ownedReminders: [],
      }),
    );
    const sessionMeta = currentReminderState.meta as Record<string, unknown>;
    assert.equal(typeof sessionMeta['sessionId'], 'string');
    const sessionId = String(sessionMeta['sessionId']);
    assert.equal(await pathExists(path.join(sessionsCacheDirAbs, `${sessionId}.json`)), true);
    assert.equal(await pathExists(legacySessionsDirAbs), false);

    const evalResult = await host.tools.playwright_session_eval(
      {
        sessionId,
        surfaceHint: 'page',
        code: [
          'await goto("https://example.test/after-eval");',
          'await waitForSelector("#status");',
          'await fill("#search", "alpha");',
          'await click("#increment");',
          'const statusText = await textContent("#status");',
          'const searchValue = await textContent("#search-value");',
          'remember("lastStatus", statusText);',
          'return {',
          '  url: url(),',
          '  title: await title(),',
          '  statusText,',
          '  searchValue,',
          '  remembered: readState("lastStatus"),',
          '  activeSurfaceRole: activeSurface?.role ?? null,',
          '};',
        ].join('\n'),
      },
      controllerCtx,
    );
    assertStructuredResult(evalResult);
    assert.match(evalResult.output, /ok: session eval completed\./);
    assert.match(evalResult.output, /surfaceHint=page/);
    assert.match(evalResult.output, /surface: page https:\/\/example\.test\/after-eval/);
    assert.match(evalResult.output, /result:/);
    assert.match(evalResult.output, /"url":"https:\/\/example\.test\/after-eval"/);
    assert.match(evalResult.output, /"statusText":"Clicked 1"/);
    assert.match(evalResult.output, /"searchValue":"alpha"/);
    assert.match(evalResult.output, /"remembered":"Clicked 1"/);
    assert.match(evalResult.output, /"activeSurfaceRole":"page"/);

    const consoleResult = await host.tools.playwright_session_console(
      { sessionId, limit: 5 },
      controllerCtx,
    );
    assertStructuredResult(consoleResult);
    assert.match(consoleResult.output, /ok: session console evidence retrieved\./);
    assert.match(consoleResult.output, /recent console:/);
    assert.match(consoleResult.output, /Increment clicked/);
    assert.match(
      consoleResult.output,
      /evidence: screenshots=0 console=[1-9]\d* network=[1-9]\d* viewportChecks=0/,
    );

    const networkResult = await host.tools.playwright_session_network(
      { sessionId, limit: 5 },
      controllerCtx,
    );
    assertStructuredResult(networkResult);
    assert.match(networkResult.output, /ok: session network evidence retrieved\./);
    assert.match(networkResult.output, /recent network:/);
    assert.match(networkResult.output, /request GET https:\/\/example\.test\/after-eval/);
    assert.match(networkResult.output, /response GET https:\/\/example\.test\/after-eval 200/);

    const screenshotResult = await host.tools.playwright_session_screenshot(
      { sessionId, label: 'after-eval-proof', imageType: 'png' },
      controllerCtx,
    );
    assertStructuredResult(screenshotResult);
    assert.match(screenshotResult.output, /ok: session screenshot captured\./);
    assert.match(screenshotResult.output, /captured screenshot:/);
    assert.match(screenshotResult.output, /image\/png/);
    const artifactEntries = await fs.readdir(path.join(artifactsDirAbs, sessionId));
    assert.equal(artifactEntries.length, 1);
    assert.match(artifactEntries[0] ?? '', /after-eval-proof\.png$/);

    const desktopFitCheck = await host.tools.playwright_session_viewport_fit_check(
      {
        sessionId,
        requiredRegions: [
          {
            id: 'primary_cta',
            label: 'Primary CTA block',
            x: 24,
            y: 24,
            width: 320,
            height: 120,
          },
        ],
      },
      controllerCtx,
    );
    assertStructuredResult(desktopFitCheck);
    assert.match(desktopFitCheck.output, /ok: session viewport fit check passed\./);
    assert.match(desktopFitCheck.output, /viewport fit check:/);
    assert.match(
      desktopFitCheck.output,
      /PASS surface=page viewport=1440x960 document=1440x960 regions=1/,
    );
    assert.match(
      desktopFitCheck.output,
      /region primary_cta label=Primary CTA block bounds=24,24 320x120 fitsViewport=true fitsDocument=true/,
    );

    const inventoryStatusInitial = await host.tools.playwright_session_inventory_status(
      { sessionId },
      controllerCtx,
    );
    assertStructuredResult(inventoryStatusInitial);
    assert.match(inventoryStatusInitial.output, /ok: session QA inventory retrieved\./);
    assert.match(
      inventoryStatusInitial.output,
      /coverage snapshot: inventory=0 functional=0\/0 visual=0\/0 pendingFunctional=none pendingVisual=none/,
    );
    assert.match(
      inventoryStatusInitial.output,
      /decision gate: status=not_started functional=pending visual=pending viewport=pending exploratory=pending cleanup=not_run/,
    );
    assert.match(inventoryStatusInitial.output, /qa inventory:/);
    assert.match(inventoryStatusInitial.output, /- pending functional items: none/);
    assert.match(inventoryStatusInitial.output, /- pending visual items: none/);

    const inventoryCreated = await host.tools.playwright_session_inventory_upsert(
      {
        sessionId,
        item: {
          id: 'critical_flow',
          kind: 'feature',
          label: 'Primary browser flow',
          functional: 'covered',
          visual: 'pending',
          artifact: 'after-eval-proof.png',
          notes: 'Initial functional pass on desktop runtime.',
        },
      },
      controllerCtx,
    );
    assertStructuredResult(inventoryCreated);
    assert.match(inventoryCreated.output, /ok: session QA inventory item created\./);
    assert.match(
      inventoryCreated.output,
      /critical_flow \[feature\] functional=covered visual=pending Primary browser flow artifact=after-eval-proof\.png/,
    );
    assert.match(
      inventoryCreated.output,
      /coverage snapshot: inventory=1 functional=1\/1 visual=0\/1 pendingFunctional=none pendingVisual=critical_flow/,
    );
    assert.match(inventoryCreated.output, /- pending visual items: critical_flow/);

    await assert.rejects(
      async () =>
        await host.tools.playwright_session_signoff_record(
          {
            sessionId,
            status: 'ready',
            functional: true,
            visual: true,
            viewport: true,
            exploratory: true,
            cleanupStatus: 'kept_alive',
            summary: 'Attempted signoff before visual coverage was complete.',
            negativeChecks: ['No unexpected console errors on the primary flow.'],
          },
          controllerCtx,
        ),
      /ready signoff requires visual coverage to be complete \(0\/1\)/,
    );

    const signoffInProgress = await host.tools.playwright_session_signoff_record(
      {
        sessionId,
        status: 'in_progress',
        summary: 'Functional pass completed; visual QA still pending.',
      },
      controllerCtx,
    );
    assertStructuredResult(signoffInProgress);
    assert.match(signoffInProgress.output, /ok: session QA signoff recorded\./);
    assert.match(
      signoffInProgress.output,
      /decision gate: status=in_progress functional=pending visual=pending viewport=pending exploratory=pending cleanup=not_run/,
    );
    assert.match(
      signoffInProgress.output,
      /decision gate detail: status=in_progress functional=pending visual=pending viewport=pending exploratory=pending cleanup=not_run/,
    );
    assert.match(
      signoffInProgress.output,
      /signoff summary: Functional pass completed; visual QA still pending\./,
    );

    const reloadResult = await host.tools.playwright_session_reload(
      { sessionId, waitUntil: 'domcontentloaded' },
      controllerCtx,
    );
    assertStructuredResult(reloadResult);
    assert.match(reloadResult.output, /ok: session page reloaded\./);
    assert.match(reloadResult.output, /browserMode=desktop/);
    assert.match(reloadResult.output, /waitUntil=domcontentloaded/);
    assert.equal(fakeEnv.trackers.reloads, 1);

    const postReloadStatus = await host.tools.playwright_session_status(
      { sessionId },
      controllerCtx,
    );
    assertStructuredResult(postReloadStatus);
    assert.match(postReloadStatus.output, /ok: Web Dev browser session status refreshed\./);
    assert.match(
      postReloadStatus.output,
      /state=ready \| role=controller \| runtime=playwright_browser_runtime \| browserMode=desktop/,
    );
    assert.match(postReloadStatus.output, /surface: page https:\/\/example\.test\/after-eval/);
    assert.match(postReloadStatus.output, /session detail:/);
    assert.match(postReloadStatus.output, /- attachments=1 .*role=controller/);

    const modeResult = await host.tools.playwright_session_mode(
      { sessionId, browserMode: 'native_window', waitUntil: 'networkidle' },
      controllerCtx,
    );
    assertStructuredResult(modeResult);
    assert.match(modeResult.output, /ok: session browser mode switched\./);
    assert.match(modeResult.output, /previousMode=desktop/);
    assert.match(modeResult.output, /browserMode=native_window/);
    assert.match(modeResult.output, /waitUntil=networkidle/);
    assert.equal(fakeEnv.trackers.contextClosed, 1);
    assert.deepEqual(fakeEnv.trackers.newContextOptions.at(-1), { viewport: null });

    const nativeWindowStatus = await host.tools.playwright_session_status(
      { sessionId },
      controllerCtx,
    );
    assertStructuredResult(nativeWindowStatus);
    assert.match(nativeWindowStatus.output, /ok: Web Dev browser session status refreshed\./);
    assert.match(
      nativeWindowStatus.output,
      /state=ready \| role=controller \| runtime=playwright_browser_runtime \| browserMode=native_window/,
    );
    assert.match(nativeWindowStatus.output, /surface: page https:\/\/example\.test\/after-eval/);

    const nativeWindowScreenshot = await host.tools.playwright_session_screenshot(
      { sessionId, label: 'native-window-proof', imageType: 'png' },
      controllerCtx,
    );
    assertStructuredResult(nativeWindowScreenshot);
    assert.match(nativeWindowScreenshot.output, /ok: session screenshot captured\./);
    assert.match(nativeWindowScreenshot.output, /image\/png/);
    const artifactEntriesAfterMode = await fs.readdir(path.join(artifactsDirAbs, sessionId));
    assert.equal(artifactEntriesAfterMode.length, 2);
    assert.ok(
      artifactEntriesAfterMode.some((entry) => /native-window-proof\.png$/.test(entry)),
      'expected native-window-proof screenshot artifact',
    );

    const nativeWindowNormalizedScreenshot =
      await host.tools.playwright_session_screenshot_normalized(
        {
          sessionId,
          label: 'native-window-normalized',
          imageType: 'png',
          normalizationMode: 'device',
          clip: { x: 40, y: 32, width: 640, height: 360 },
        },
        controllerCtx,
      );
    assertStructuredResult(nativeWindowNormalizedScreenshot);
    assert.match(
      nativeWindowNormalizedScreenshot.output,
      /ok: normalized session screenshot captured\./,
    );
    assert.match(nativeWindowNormalizedScreenshot.output, /normalization=device/);
    assert.match(nativeWindowNormalizedScreenshot.output, /clip=40,32 640x360/);
    assert.deepEqual(fakeEnv.trackers.screenshotCalls.at(-1), {
      type: 'png',
      scale: 'device',
      clip: { x: 40, y: 32, width: 640, height: 360 },
    });
    const artifactEntriesAfterNormalized = await fs.readdir(path.join(artifactsDirAbs, sessionId));
    assert.equal(artifactEntriesAfterNormalized.length, 3);
    assert.ok(
      artifactEntriesAfterNormalized.some((entry) => /native-window-normalized\.png$/.test(entry)),
      'expected native-window-normalized screenshot artifact',
    );

    const nativeWindowFitCheck = await host.tools.playwright_session_viewport_fit_check(
      {
        sessionId,
        requiredRegions: [
          {
            id: 'native_window_toolbar',
            label: 'Native window toolbar block',
            x: 980,
            y: 24,
            width: 260,
            height: 88,
          },
        ],
      },
      controllerCtx,
    );
    assertStructuredResult(nativeWindowFitCheck);
    assert.match(nativeWindowFitCheck.output, /ok: session viewport fit check passed\./);
    assert.match(
      nativeWindowFitCheck.output,
      /PASS surface=page viewport=1280x720 document=1280x720 regions=1/,
    );
    assert.match(
      nativeWindowFitCheck.output,
      /region native_window_toolbar label=Native window toolbar block bounds=980,24 260x88 fitsViewport=true fitsDocument=true/,
    );

    const relaunchResult = await host.tools.playwright_session_relaunch(
      {
        sessionId,
        reason: 'startup_changed',
        waitUntil: 'commit',
      },
      controllerCtx,
    );
    assertStructuredResult(relaunchResult);
    assert.match(relaunchResult.output, /ok: session browser runtime relaunched\./);
    assert.match(relaunchResult.output, /reason=startup_changed/);
    assert.match(relaunchResult.output, /waitUntil=commit/);
    assert.match(relaunchResult.output, /browserMode=native_window/);
    assert.match(
      relaunchResult.output,
      /boundary=use relaunch after startup\/process-ownership changes; use reload for renderer-only changes\./,
    );
    assert.equal(fakeEnv.trackers.launched, 2);
    assert.equal(fakeEnv.trackers.browserClosed, 1);
    assert.equal(fakeEnv.trackers.contextClosed, 2);
    assert.deepEqual(fakeEnv.trackers.newContextOptions.at(-1), { viewport: null });

    const relaunchStatus = await host.tools.playwright_session_status({ sessionId }, controllerCtx);
    assertStructuredResult(relaunchStatus);
    assert.match(relaunchStatus.output, /ok: Web Dev browser session status refreshed\./);
    assert.match(
      relaunchStatus.output,
      /state=ready \| role=controller \| runtime=playwright_browser_runtime \| browserMode=native_window/,
    );
    assert.match(relaunchStatus.output, /surface: page https:\/\/example\.test\/after-eval/);

    const relaunchScreenshot = await host.tools.playwright_session_screenshot(
      { sessionId, label: 'relaunched-proof', imageType: 'png' },
      controllerCtx,
    );
    assertStructuredResult(relaunchScreenshot);
    assert.match(relaunchScreenshot.output, /ok: session screenshot captured\./);
    const artifactEntriesAfterRelaunch = await fs.readdir(path.join(artifactsDirAbs, sessionId));
    assert.equal(artifactEntriesAfterRelaunch.length, 4);
    assert.ok(
      artifactEntriesAfterRelaunch.some((entry) => /relaunched-proof\.png$/.test(entry)),
      'expected relaunched-proof screenshot artifact',
    );

    const inventoryUpdated = await host.tools.playwright_session_inventory_upsert(
      {
        sessionId,
        item: {
          id: 'critical_flow',
          kind: 'feature',
          label: 'Primary browser flow',
          functional: 'covered',
          visual: 'covered',
          artifact: 'relaunched-proof.png',
          notes: 'Visual pass completed after relaunch/native_window verification.',
        },
      },
      controllerCtx,
    );
    assertStructuredResult(inventoryUpdated);
    assert.match(inventoryUpdated.output, /ok: session QA inventory item updated\./);
    assert.match(
      inventoryUpdated.output,
      /critical_flow \[feature\] functional=covered visual=covered Primary browser flow artifact=relaunched-proof\.png/,
    );
    assert.match(
      inventoryUpdated.output,
      /coverage snapshot: inventory=1 functional=1\/1 visual=1\/1 pendingFunctional=none pendingVisual=none/,
    );
    assert.match(inventoryUpdated.output, /- pending visual items: none/);

    const signoffReady = await host.tools.playwright_session_signoff_record(
      {
        sessionId,
        status: 'ready',
        functional: true,
        visual: true,
        viewport: true,
        exploratory: true,
        cleanupStatus: 'kept_alive',
        summary: 'Primary browser flow verified across desktop, native window, and relaunch.',
        negativeChecks: [
          'No clipped primary controls in native window mode.',
          'No unexpected console or network failures during smoke.',
        ],
        exclusions: ['Mobile-specific QA remains out of scope for this tranche.'],
      },
      controllerCtx,
    );
    assertStructuredResult(signoffReady);
    assert.match(signoffReady.output, /ok: session QA signoff recorded\./);
    assert.match(
      signoffReady.output,
      /decision gate: status=ready functional=pass visual=pass viewport=pass exploratory=pass cleanup=kept_alive/,
    );
    assert.match(
      signoffReady.output,
      /decision gate detail: status=ready functional=pass visual=pass viewport=pass exploratory=pass cleanup=kept_alive/,
    );
    assert.match(
      signoffReady.output,
      /signoff summary: Primary browser flow verified across desktop, native window, and relaunch\./,
    );
    assert.match(
      signoffReady.output,
      /negativeChecks: No clipped primary controls in native window mode\.; No unexpected console or network failures during smoke\./,
    );
    assert.match(
      signoffReady.output,
      /signoff exclusions: Mobile-specific QA remains out of scope for this tranche\./,
    );

    const signoffStatus = await host.tools.playwright_session_signoff_status(
      { sessionId },
      controllerCtx,
    );
    assertStructuredResult(signoffStatus);
    assert.match(signoffStatus.output, /ok: session QA signoff retrieved\./);
    assert.match(
      signoffStatus.output,
      /decision gate detail: status=ready functional=pass visual=pass viewport=pass exploratory=pass cleanup=kept_alive/,
    );
    assert.match(
      signoffStatus.output,
      /coverage snapshot: inventory=1 functional=1\/1 visual=1\/1 pendingFunctional=none pendingVisual=none/,
    );
    assert.match(signoffStatus.output, /- pending functional items: none/);
    assert.match(signoffStatus.output, /- pending visual items: none/);

    const persistedSessionUnknown: unknown = JSON.parse(
      await fs.readFile(path.join(sessionsCacheDirAbs, `${sessionId}.json`), 'utf-8'),
    );
    assertRecord(persistedSessionUnknown);
    const persistedQaUnknown = persistedSessionUnknown['qa'];
    assertRecord(persistedQaUnknown);
    const persistedInventoryUnknown = persistedQaUnknown['inventory'];
    assert.ok(Array.isArray(persistedInventoryUnknown));
    assert.equal(persistedInventoryUnknown.length, 1);
    const persistedInventoryItemUnknown = persistedInventoryUnknown[0];
    assertRecord(persistedInventoryItemUnknown);
    assert.equal(persistedInventoryItemUnknown['id'], 'critical_flow');
    assert.equal(persistedInventoryItemUnknown['visual'], 'covered');
    assert.equal(persistedInventoryItemUnknown['artifact'], 'relaunched-proof.png');
    const persistedSignoffUnknown = persistedQaUnknown['signoff'];
    assertRecord(persistedSignoffUnknown);
    assert.equal(persistedSignoffUnknown['status'], 'ready');
    assert.equal(persistedSignoffUnknown['cleanupStatus'], 'kept_alive');

    const electronCreated = await host.tools.playwright_session_new(
      {
        kind: 'electron',
        label: 'electron-smoke',
        entryUrl: '.',
      },
      controllerCtx,
    );
    assertStructuredResult(electronCreated);
    assert.match(electronCreated.output, /ok: created Web Dev electron session\./);
    assert.match(
      electronCreated.output,
      /state=ready \| role=controller \| runtime=playwright_electron_runtime/,
    );
    assert.match(electronCreated.output, /surface: appWindow electron:\/\/app\/\./);
    assert.equal(fakeEnv.trackers.electronLaunched, 1);

    const electronReminderState = requireReminderStateAdded(
      await reminderOwner.apply(requireSingleUpsertReminder(electronCreated), {
        dialogId: controllerCtx.dialogId,
        ownedReminders: [currentReminderState],
      }),
    );
    const electronMeta = electronReminderState.meta as Record<string, unknown>;
    const electronSessionId = String(electronMeta['sessionId']);

    const electronEval = await host.tools.playwright_session_eval(
      {
        sessionId: electronSessionId,
        surfaceHint: 'appWindow',
        code: [
          'await waitForSelector("#increment");',
          'await click("#increment");',
          'return {',
          '  title: await title(),',
          '  url: url(),',
          '  statusText: await textContent("#status"),',
          '  activeSurfaceRole: activeSurface?.role ?? null,',
          '  hasElectronApp: bindings.electronApp,',
          '  hasAppWindow: bindings.appWindow,',
          '};',
        ].join('\n'),
      },
      controllerCtx,
    );
    assertStructuredResult(electronEval);
    assert.match(electronEval.output, /ok: session eval completed\./);
    assert.match(
      electronEval.output,
      /state=ready \| role=controller \| runtime=playwright_electron_runtime/,
    );
    assert.match(electronEval.output, /result:/);
    assert.match(electronEval.output, /"url":"electron:\/\/app\/\."/);
    assert.match(electronEval.output, /"statusText":"Clicked 1"/);
    assert.match(electronEval.output, /"activeSurfaceRole":"appWindow"/);
    assert.match(electronEval.output, /"hasElectronApp":true/);
    assert.match(electronEval.output, /"hasAppWindow":true/);

    const electronConsole = await host.tools.playwright_session_console(
      { sessionId: electronSessionId, limit: 5 },
      controllerCtx,
    );
    assertStructuredResult(electronConsole);
    assert.match(electronConsole.output, /ok: session console evidence retrieved\./);
    assert.match(electronConsole.output, /Increment clicked/);

    const electronScreenshot = await host.tools.playwright_session_screenshot(
      { sessionId: electronSessionId, label: 'electron-proof', imageType: 'png' },
      controllerCtx,
    );
    assertStructuredResult(electronScreenshot);
    assert.match(electronScreenshot.output, /ok: session screenshot captured\./);
    const electronArtifactEntries = await fs.readdir(path.join(artifactsDirAbs, electronSessionId));
    assert.equal(electronArtifactEntries.length, 1);
    assert.ok(
      electronArtifactEntries.some((entry) => /electron-proof\.png$/.test(entry)),
      'expected electron-proof screenshot artifact',
    );

    const electronNormalizedScreenshot = await host.tools.playwright_session_screenshot_normalized(
      {
        sessionId: electronSessionId,
        label: 'electron-normalized',
        imageType: 'png',
        normalizationMode: 'css',
        clip: { x: 16, y: 16, width: 480, height: 240 },
        surfaceHint: 'appWindow',
      },
      controllerCtx,
    );
    assertStructuredResult(electronNormalizedScreenshot);
    assert.match(
      electronNormalizedScreenshot.output,
      /ok: normalized session screenshot captured\./,
    );
    assert.match(electronNormalizedScreenshot.output, /normalization=css/);
    assert.match(electronNormalizedScreenshot.output, /clip=16,16 480x240/);
    assert.deepEqual(fakeEnv.trackers.screenshotCalls.at(-1), {
      type: 'png',
      scale: 'css',
      clip: { x: 16, y: 16, width: 480, height: 240 },
    });
    const electronArtifactEntriesAfterNormalized = await fs.readdir(
      path.join(artifactsDirAbs, electronSessionId),
    );
    assert.equal(electronArtifactEntriesAfterNormalized.length, 2);
    assert.ok(
      electronArtifactEntriesAfterNormalized.some((entry) =>
        /electron-normalized\.png$/.test(entry),
      ),
      'expected electron-normalized screenshot artifact',
    );

    const electronFitCheck = await host.tools.playwright_session_viewport_fit_check(
      {
        sessionId: electronSessionId,
        surfaceHint: 'appWindow',
        requiredRegions: [
          {
            id: 'launched_window',
            label: 'Electron launched window content',
            x: 32,
            y: 32,
            width: 640,
            height: 320,
          },
        ],
      },
      controllerCtx,
    );
    assertStructuredResult(electronFitCheck);
    assert.match(electronFitCheck.output, /ok: session viewport fit check passed\./);
    assert.match(
      electronFitCheck.output,
      /PASS surface=appWindow viewport=1280x800 document=1280x800 regions=1/,
    );
    assert.match(
      electronFitCheck.output,
      /region launched_window label=Electron launched window content bounds=32,32 640x320 fitsViewport=true fitsDocument=true/,
    );

    const electronReload = await host.tools.playwright_session_reload(
      { sessionId: electronSessionId, waitUntil: 'domcontentloaded', surfaceHint: 'appWindow' },
      controllerCtx,
    );
    assertStructuredResult(electronReload);
    assert.match(electronReload.output, /ok: session app window reloaded\./);
    assert.match(electronReload.output, /runtime=playwright_electron_runtime/);
    assert.match(electronReload.output, /surfaceHint=appWindow/);
    assert.equal(fakeEnv.trackers.reloads, 2);

    const electronNetwork = await host.tools.playwright_session_network(
      { sessionId: electronSessionId, limit: 5 },
      controllerCtx,
    );
    assertStructuredResult(electronNetwork);
    assert.match(electronNetwork.output, /ok: session network evidence retrieved\./);
    assert.match(electronNetwork.output, /request GET electron:\/\/app\/\./);

    const electronRelaunch = await host.tools.playwright_session_relaunch(
      {
        sessionId: electronSessionId,
        reason: 'startup_changed',
        entryUrl: './main.js',
        waitUntil: 'commit',
      },
      controllerCtx,
    );
    assertStructuredResult(electronRelaunch);
    assert.match(electronRelaunch.output, /ok: session browser runtime relaunched\./);
    assert.match(electronRelaunch.output, /runtime=playwright_electron_runtime/);
    assert.match(electronRelaunch.output, /sessionKind=electron/);
    assert.match(electronRelaunch.output, /reason=startup_changed/);
    assert.match(electronRelaunch.output, /entryUrl=\.\/main\.js/);
    assert.match(
      electronRelaunch.output,
      /boundary=use relaunch after main-process, preload, startup, or process-ownership changes; use reload for renderer-only changes\./,
    );
    assert.equal(fakeEnv.trackers.electronLaunched, 2);
    assert.equal(fakeEnv.trackers.electronClosed, 1);
    assert.equal(fakeEnv.trackers.contextClosed, 3);

    const electronRelaunchStatus = await host.tools.playwright_session_status(
      { sessionId: electronSessionId },
      controllerCtx,
    );
    assertStructuredResult(electronRelaunchStatus);
    assert.match(electronRelaunchStatus.output, /runtime=playwright_electron_runtime/);
    assert.match(
      electronRelaunchStatus.output,
      /surface: appWindow electron:\/\/app\/\.\/main\.js/,
    );

    const electronClosed = await host.tools.playwright_session_close(
      { sessionId: electronSessionId },
      controllerCtx,
    );
    assertStructuredResult(electronClosed);
    assert.match(electronClosed.output, /ok: session closed\./);
    assert.equal(fakeEnv.trackers.electronClosed, 2);
    assert.equal(fakeEnv.trackers.contextClosed, 4);

    const dataUrlSession = await host.tools.playwright_session_new(
      {
        kind: 'web',
        label: 'data-url-smoke',
        entryUrl:
          "data:text/html,<html><head><title>Smoke</title></head><body><input id='name'/><button id='go' onclick=\"document.querySelector('#out').textContent=document.querySelector('#name').value\">Go</button><div id='out'></div></body></html>",
      },
      controllerCtx,
    );
    assertStructuredResult(dataUrlSession);
    assert.match(dataUrlSession.output, /ok: created Web Dev browser session\./);
    assert.match(dataUrlSession.output, /runtime=playwright_browser_runtime/);
    assert.match(dataUrlSession.output, /browserMode=desktop/);

    const dataUrlReminderState = requireReminderStateAdded(
      await reminderOwner.apply(requireSingleUpsertReminder(dataUrlSession), {
        dialogId: controllerCtx.dialogId,
        ownedReminders: [currentReminderState],
      }),
    );
    const dataUrlMeta = dataUrlReminderState.meta as Record<string, unknown>;
    const dataUrlSessionId = String(dataUrlMeta['sessionId']);

    const dataUrlStatus = await host.tools.playwright_session_status(
      { sessionId: dataUrlSessionId },
      controllerCtx,
    );
    assertStructuredResult(dataUrlStatus);
    assert.match(dataUrlStatus.output, /ok: Web Dev browser session status refreshed\./);
    assert.match(
      dataUrlStatus.output,
      /state=ready \| role=controller \| runtime=playwright_browser_runtime \| browserMode=desktop/,
    );
    assert.match(dataUrlStatus.output, /surface: page data:text\/html,.*\(Smoke\)/);

    const dataUrlEval = await host.tools.playwright_session_eval(
      {
        sessionId: dataUrlSessionId,
        surfaceHint: 'page',
        code: [
          "await fill('#name', 'dominds');",
          "await click('#go');",
          "return { title: await title(), url: url(), out: await textContent('#out') };",
        ].join('\n'),
      },
      controllerCtx,
    );
    assertStructuredResult(dataUrlEval);
    assert.match(dataUrlEval.output, /ok: session eval completed\./);
    assert.match(dataUrlEval.output, /result:/);
    assert.match(dataUrlEval.output, /"title":"Smoke"/);
    assert.match(dataUrlEval.output, /"out":"dominds"/);
    assert.match(dataUrlEval.output, /"url":"data:text\/html,/);

    const dataUrlClosed = await host.tools.playwright_session_close(
      { sessionId: dataUrlSessionId },
      controllerCtx,
    );
    assertStructuredResult(dataUrlClosed);
    assert.match(dataUrlClosed.output, /ok: session closed\./);
    assert.equal(fakeEnv.trackers.contextClosed, 5);
    assert.equal(fakeEnv.trackers.browserClosed, 2);

    const observerStatusBeforeAttach = await host.tools.playwright_session_status(
      { sessionId },
      observerCtx,
    );
    assertStructuredResult(observerStatusBeforeAttach);
    assert.match(
      observerStatusBeforeAttach.output,
      /state=ready \| role=not attached \| runtime=playwright_browser_runtime \| browserMode=native_window/,
    );
    assert.match(
      observerStatusBeforeAttach.output,
      /attachment: current dialog not attached; use playwright_session_attach\(\{ sessionId: ".+", role: "observer" \}\) to attach this dialog\./,
    );

    const attached = await host.tools.playwright_session_attach(
      {
        sessionId,
        role: 'observer',
      },
      observerCtx,
    );
    assertStructuredResult(attached);
    assert.match(attached.output, /ok: session attachment updated\./);
    assert.match(attached.output, /attachment: current dialog attached as observer/);
    assert.match(attached.output, /reminder sync: current=refreshed; other=1 updates\/1 dialogs/);
    const observerUpsert = requireSingleUpsertReminder(attached);
    const observerReminderState = requireReminderStateAdded(
      await reminderOwner.apply(observerUpsert, {
        dialogId: observerCtx.dialogId,
        ownedReminders: [],
      }),
    );
    assert.ok(Array.isArray(attached.dialogReminderRequests));
    assert.equal(attached.dialogReminderRequests?.length, 1);
    const controllerBatchAfterAttach = attached.dialogReminderRequests?.[0];
    assert.ok(
      controllerBatchAfterAttach,
      'expected controller reminder batch after observer attach',
    );
    assert.equal(controllerBatchAfterAttach?.target['dialogId'], controllerCtx.dialogId);

    const observerStatus = await host.tools.playwright_session_status({ sessionId }, observerCtx);
    assertStructuredResult(observerStatus);
    assert.match(observerStatus.output, /ok: Web Dev browser session status refreshed\./);
    assert.match(
      observerStatus.output,
      /state=ready \| role=observer \| runtime=playwright_browser_runtime \| browserMode=native_window/,
    );
    assert.match(observerStatus.output, /attachment: current dialog attached as observer/);
    assert.match(observerStatus.output, /surface: page https:\/\/example\.test\/after-eval/);
    assert.match(
      observerStatus.output,
      /coverage snapshot: inventory=1 functional=1\/1 visual=1\/1 pendingFunctional=none pendingVisual=none/,
    );
    assert.match(
      observerStatus.output,
      /decision gate: status=ready functional=pass visual=pass viewport=pass exploratory=pass cleanup=kept_alive/,
    );
    assert.match(
      observerStatus.output,
      /evidence: screenshots=4 console=[1-9]\d* network=[1-9]\d* viewportChecks=2/,
    );
    assert.match(
      observerStatus.output,
      /qa relation: coverage snapshot tracks exercised coverage; decision gate stays manual until signoff_record marks it pass\./,
    );

    const renderedReminder = await reminderOwner.renderReminder({
      dialogId: observerCtx.dialogId,
      reminder: observerReminderState,
      reminderNo: 1,
      workLanguage: 'en',
    });
    assert.match(
      renderedReminder.content,
      /state=ready \| role=observer \| runtime=playwright_browser_runtime \| browserMode=native_window/,
    );
    assert.match(renderedReminder.content, /attachment: current dialog attached as observer/);
    assert.match(renderedReminder.content, /surface: page https:\/\/example\.test\/after-eval/);
    assert.match(renderedReminder.content, /coverage snapshot:/);
    assert.match(
      renderedReminder.content,
      /- coverage snapshot: inventory=1 functional=1\/1 visual=1\/1 pendingFunctional=none pendingVisual=none/,
    );
    assert.match(renderedReminder.content, /decision gate:/);
    assert.match(
      renderedReminder.content,
      /- decision gate detail: status=ready functional=pass visual=pass viewport=pass exploratory=pass cleanup=kept_alive/,
    );
    assert.match(
      renderedReminder.content,
      /- qa relation: coverage snapshot tracks exercised coverage; decision gate stays manual until signoff_record marks it pass\./,
    );
    assert.match(renderedReminder.content, /latest screenshot:/);
    assert.match(renderedReminder.content, /latest viewport check:/);
    assert.match(renderedReminder.content, /recent console:/);
    assert.match(renderedReminder.content, /recent network:/);

    const detached = await host.tools.playwright_session_detach({ sessionId }, observerCtx);
    assertStructuredResult(detached);
    assert.match(detached.output, /ok: session detached\./);
    assert.match(detached.output, /reminder sync: current=removed; other=1 updates\/1 dialogs/);

    const staleObserverUpdate = await reminderOwner.updateReminder({
      dialogId: observerCtx.dialogId,
      reminder: observerReminderState,
    });
    assert.equal(staleObserverUpdate.treatment, 'drop');

    const stillAttachedControllerUpdate = await reminderOwner.updateReminder({
      dialogId: controllerCtx.dialogId,
      reminder: currentReminderState,
    });
    assert.equal(stillAttachedControllerUpdate.treatment, 'update');
    if (stillAttachedControllerUpdate.treatment === 'update') {
      assert.match(
        stillAttachedControllerUpdate.updatedContent,
        /https:\/\/example\.test\/after-eval/,
      );
      assert.match(
        stillAttachedControllerUpdate.updatedContent,
        /coverage snapshot: inventory=1 functional=1\/1 visual=1\/1 pendingFunctional=none pendingVisual=none/,
      );
    }

    const closed = await host.tools.playwright_session_close({ sessionId }, controllerCtx);
    assertStructuredResult(closed);
    assert.match(closed.output, /ok: session closed\./);
    assert.match(closed.output, /removedAttachments=1/);
    assert.equal(fakeEnv.trackers.contextClosed, 6);
    assert.equal(fakeEnv.trackers.browserClosed, 3);

    const closedControllerUpdate = await reminderOwner.updateReminder({
      dialogId: controllerCtx.dialogId,
      reminder: currentReminderState,
    });
    assert.equal(closedControllerUpdate.treatment, 'drop');
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

main()
  .then(() => {
    console.log('OK');
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
