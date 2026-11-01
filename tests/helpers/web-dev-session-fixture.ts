import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';

import type {
  DomindsAppDialogReminderRequestBatch,
  DomindsAppHostReminderUpdateResult,
  DomindsAppHostToolResult,
  DomindsAppReminderApplyRequest,
  DomindsAppReminderApplyResult,
  DomindsAppReminderState,
} from '@longrun-ai/kernel/app-json';

import { loadLocalAppEntry, type AppFactoryContext } from './app-entry';
import { WebDevFixtureSetupError, webDevPackageRoot } from './external-web-dev';

export type ToolCtx = Readonly<{
  dialogId: string;
  mainDialogId: string;
  agentId: string;
  sessionSlug?: string;
  callerId: string;
}>;

export type ReminderRequest = DomindsAppReminderApplyRequest;
export type DialogReminderBatch = DomindsAppDialogReminderRequestBatch;
export type StructuredToolResult = DomindsAppHostToolResult;
export type ReminderState = DomindsAppReminderState;
export type ReminderApplyResult = DomindsAppReminderApplyResult;
export type ReminderUpdateResult = DomindsAppHostReminderUpdateResult;

export type ReminderOwnerHandler = Readonly<{
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
      reminderId: string;
      workLanguage: 'zh' | 'en';
    }>,
  ) => Promise<Readonly<{ content: string }>>;
}>;

type ToolHandler = (args: Record<string, unknown>, ctx: ToolCtx) => Promise<StructuredToolResult>;

export type WebDevAppHost = Readonly<{
  tools: Readonly<Record<string, ToolHandler>>;
  reminderOwners?: Readonly<Record<string, ReminderOwnerHandler>>;
  shutdown: () => Promise<void>;
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
  goto: (url: string, options?: unknown) => Promise<void>;
  reload: (options?: unknown) => Promise<void>;
  waitForLoadState: (state?: unknown) => Promise<void>;
  evaluate: <T>(fn: () => T) => Promise<T>;
  click: (selector: string) => Promise<void>;
  fill: (selector: string, value: string) => Promise<void>;
  textContent: (selector: string) => Promise<string | null>;
  title: () => Promise<string>;
  url: () => string;
  content: () => Promise<string>;
  waitForSelector: (selector: string) => Promise<Readonly<{ selector: string }>>;
  locator: (selector: string) => Readonly<{ selector: string }>;
  screenshot: (options?: unknown) => Promise<Buffer>;
  isClosed: () => boolean;
  close: () => Promise<void>;
};

type FakeBrowserContext = {
  newPage: () => Promise<FakePage>;
  pages: () => Promise<ReadonlyArray<FakePage>>;
  close: () => Promise<void>;
};

type FakeBrowser = {
  newContext: (options?: unknown) => Promise<FakeBrowserContext>;
  close: () => Promise<void>;
};

type FakeBrowserType = {
  launch: (options?: unknown) => Promise<FakeBrowser>;
};

export type FakeElectronApplication = {
  firstWindow: () => Promise<FakePage>;
  windows: () => Promise<ReadonlyArray<FakePage>>;
  context: () => Promise<FakeBrowserContext>;
  close: () => Promise<void>;
};

type FakePlaywrightModule = Readonly<{
  chromium: FakeBrowserType;
  _electron: Readonly<{
    launch: (options?: unknown) => Promise<FakeElectronApplication>;
  }>;
  devices: Readonly<Record<string, Record<string, unknown>>>;
}>;

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

type FakeTrackerState = {
  launched: number;
  browserClosed: number;
  contextClosed: number;
  reloads: number;
  failViewportMeasurement: boolean;
  electronLaunched: number;
  electronClosed: number;
  newContextOptions: unknown[];
  electronLaunchOptions: unknown[];
  screenshotCalls: unknown[];
  screenshotBodies: Buffer[];
  navigations: string[];
  fills: Array<{ selector: string; value: string }>;
  clicks: string[];
};

export type FakePlaywrightEnvironment = Readonly<{
  playwright: FakePlaywrightModule;
  trackers: FakeTrackerState;
}>;

export type WebDevAppFactoryContext = AppFactoryContext &
  Readonly<{
    playwrightLoader?: () => Promise<FakePlaywrightModule>;
  }>;

export type WebDevFixture = Readonly<{
  tempRoot: string;
  rtwsAppDirAbs: string;
  sessionsCacheDirAbs: string;
  artifactsDirAbs: string;
  fakeEnv: FakePlaywrightEnvironment;
  host: WebDevAppHost;
  reminderOwner: ReminderOwnerHandler;
  controllerCtx: ToolCtx;
  observerCtx: ToolCtx;
  cleanup: (options?: { preserve?: boolean }) => Promise<void>;
}>;

export type WebDevFixturePaths = Readonly<{
  tempRoot: string;
  packageRootAbs: string;
  rtwsAppDirAbs: string;
  sessionsCacheDirAbs: string;
  artifactsDirAbs: string;
}>;

export type WebDevFixtureOptions = Readonly<{
  prepareRtws?: (paths: WebDevFixturePaths) => Promise<void>;
}>;

export async function pathExists(absPath: string): Promise<boolean> {
  try {
    await fs.access(absPath);
    return true;
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')
      return false;
    throw error;
  }
}

export function assertSuccessfulResult(
  result: StructuredToolResult,
): asserts result is StructuredToolResult {
  assert.equal(typeof result, 'object');
  assert.notEqual(result, null);
  assert.equal(typeof result.output.content, 'string');
  assert.equal(result.output.outcome, 'success');
}

export function assertRecord(value: unknown): asserts value is Record<string, unknown> {
  assert.equal(typeof value, 'object');
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
}

export function requireSingleUpsertReminder(result: StructuredToolResult): ReminderRequest {
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

export function requireReminderStateAdded(result: ReminderApplyResult): ReminderState {
  assert.equal(result.treatment, 'add');
  return result.reminder;
}

export function sessionIdFromReminder(reminder: ReminderState): string {
  assertRecord(reminder.meta);
  const sessionId = reminder.meta['sessionId'];
  assert.equal(typeof sessionId, 'string');
  if (typeof sessionId !== 'string') {
    throw new Error('expected reminder.meta.sessionId to be a string');
  }
  return sessionId;
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

export function createFakePlaywrightEnvironment(): FakePlaywrightEnvironment {
  const trackers: FakeTrackerState = {
    launched: 0,
    browserClosed: 0,
    contextClosed: 0,
    reloads: 0,
    failViewportMeasurement: false,
    electronLaunched: 0,
    electronClosed: 0,
    newContextOptions: [],
    electronLaunchOptions: [],
    screenshotCalls: [],
    screenshotBodies: [],
    navigations: [],
    fills: [],
    clicks: [],
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
        trackers.navigations.push(url);
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
      evaluate: async <T>(fn: () => T): Promise<T> => {
        if (trackers.failViewportMeasurement) throw new Error('viewport evaluate failed');
        const documentElement = {
          clientWidth: 1280,
          clientHeight: 720,
          scrollWidth: 1280,
          scrollHeight: 720,
        };
        const document = {
          documentElement,
          body: { ...documentElement },
          scrollingElement: documentElement,
        };
        const window = {
          innerWidth: 1280,
          innerHeight: 720,
          outerWidth: 1280,
          outerHeight: 800,
          devicePixelRatio: 1,
          scrollX: 0,
          scrollY: 0,
          document,
        };
        // Execute the supplied browser callback against controlled browser globals.
        // No private output-variable name determines which fixture response is returned.
        try {
          return (await runInNewContext('(' + Function.prototype.toString.call(fn) + ')()', {
            window,
            document,
            innerWidth: window.innerWidth,
            innerHeight: window.innerHeight,
            devicePixelRatio: 1,
            scrollX: 0,
            scrollY: 0,
          })) as T;
        } catch (error) {
          throw new WebDevFixtureSetupError('adapter-contract', error);
        }
      },
      click: async (selector) => {
        trackers.clicks.push(selector);
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
        if (selector !== '#go')
          throw new WebDevFixtureSetupError(
            'adapter-contract',
            new Error('Unsupported controlled click selector: ' + selector),
          );
        currentState.statusText = currentState.searchValue;
        currentState.html = buildRenderedHtml(currentState);
        await emit('console', {
          type: async () => 'info',
          text: async () => `Submitted ${currentState.searchValue}`,
        } satisfies FakeConsoleMessage);
      },
      fill: async (selector, value) => {
        trackers.fills.push({ selector, value });
        if (selector !== '#search' && selector !== '#name') {
          throw new WebDevFixtureSetupError(
            'adapter-contract',
            new Error('Unsupported controlled fill selector: ' + selector),
          );
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
          throw new WebDevFixtureSetupError(
            'adapter-contract',
            new Error('Unsupported controlled wait selector: ' + selector),
          );
        }
        return { selector };
      },
      locator: (selector) => ({ selector }),
      screenshot: async (options) => {
        trackers.screenshotCalls.push(options ?? null);
        const body = Buffer.from(
          `fake-screenshot:${currentState.url}:${JSON.stringify(options ?? null)}`,
        );
        trackers.screenshotBodies.push(Buffer.from(body));
        return body;
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

export async function createWebDevFixture(
  options: WebDevFixtureOptions = {},
): Promise<WebDevFixture> {
  const appId = '@longrun-ai/web-dev';
  const appIdPathParts = ['@longrun-ai', 'web-dev'];
  const packageRootAbs = webDevPackageRoot();
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-web-dev-session-'));
  const rtwsAppDirAbs = path.join(tempRoot, '.apps', ...appIdPathParts);
  const sessionsCacheDirAbs = path.join(
    tempRoot,
    '.cache',
    ...appIdPathParts,
    'playwright',
    'sessions',
  );
  const artifactsDirAbs = path.join(
    tempRoot,
    '.cache',
    ...appIdPathParts,
    'playwright',
    'artifacts',
  );
  const fixturePaths: WebDevFixturePaths = {
    tempRoot,
    packageRootAbs,
    rtwsAppDirAbs,
    sessionsCacheDirAbs,
    artifactsDirAbs,
  };
  let entry: Awaited<ReturnType<typeof loadLocalAppEntry>>;
  let stage: 'prepare' | 'load-entry' = 'prepare';
  try {
    await options.prepareRtws?.(fixturePaths);
    stage = 'load-entry';
    entry = await loadLocalAppEntry({ packageRootAbs });
    assert.equal(entry.installJson.appId, appId);
  } catch (error) {
    console.error('External Web Dev fixture retained before factory invocation: ' + tempRoot);
    throw new WebDevFixtureSetupError(stage, error);
  }
  const fakeEnv = createFakePlaywrightEnvironment();
  let host: WebDevAppHost;
  try {
    const webDevAppFactory = entry.appFactory as unknown as (
      ctx: WebDevAppFactoryContext,
    ) => Promise<WebDevAppHost>;
    host = await webDevAppFactory({
      appId,
      rtwsRootAbs: tempRoot,
      rtwsAppDirAbs,
      packageRootAbs,
      kernel: { scheme: 'http', host: '127.0.0.1', port: 0 },
      log: () => undefined,
      playwrightLoader: async () => fakeEnv.playwright,
    });
  } catch (error) {
    console.error('External Web Dev fixture retained after factory rejection: ' + tempRoot);
    throw error;
  }
  let reminderOwner: ReminderOwnerHandler;
  try {
    assertRecord(host);
    assertRecord(host.tools);
    assert.equal(typeof host.shutdown, 'function');
    for (const handler of Object.values(host.tools)) assert.equal(typeof handler, 'function');
    const owner = host.reminderOwners?.['playwright_session'];
    assertRecord(owner);
    for (const method of ['apply', 'updateReminder', 'renderReminder'] as const)
      assert.equal(typeof owner[method], 'function');
    reminderOwner = owner;
  } catch (error) {
    try {
      if (typeof host === 'object' && host !== null && typeof host.shutdown === 'function')
        await host.shutdown();
    } finally {
      console.error('External Web Dev fixture retained after host-contract failure: ' + tempRoot);
      throw new WebDevFixtureSetupError('host-contract', error);
    }
  }
  return {
    tempRoot,
    rtwsAppDirAbs,
    sessionsCacheDirAbs,
    artifactsDirAbs,
    fakeEnv,
    host,
    reminderOwner,
    controllerCtx: {
      dialogId: 'dlg_controller',
      mainDialogId: 'root_demo',
      agentId: 'web_tester_from_app',
      sessionSlug: 'smoke',
      callerId: 'fullstack',
    },
    observerCtx: {
      dialogId: 'dlg_observer',
      mainDialogId: 'root_demo',
      agentId: 'web_developer_from_app',
      sessionSlug: 'fix-loop',
      callerId: 'fullstack',
    },
    cleanup: async (options = {}) => {
      await host.shutdown();
      if (options.preserve)
        console.error('External Web Dev fixture retained after scenario failure: ' + tempRoot);
      else await fs.rm(tempRoot, { recursive: true, force: true });
    },
  };
}
