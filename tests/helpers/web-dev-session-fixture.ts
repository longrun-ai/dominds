import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { loadLocalAppEntry, type AppFactoryContext } from './app-entry';

export type ToolCtx = Readonly<{
  dialogId: string;
  rootDialogId: string;
  agentId: string;
  sessionSlug?: string;
  callerId: string;
}>;

export type ReminderRequest =
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

export type DialogReminderBatch = Readonly<{
  target: Readonly<Record<string, unknown>>;
  reminderRequests: ReadonlyArray<ReminderRequest>;
}>;

export type StructuredToolResult = Readonly<{
  output: string;
  reminderRequests?: ReadonlyArray<ReminderRequest>;
  dialogReminderRequests?: ReadonlyArray<DialogReminderBatch>;
}>;

export type ReminderState = Readonly<{
  content: string;
  meta?: unknown;
  echoback?: boolean;
}>;

export type ReminderApplyResult =
  | Readonly<{ treatment: 'noop' }>
  | Readonly<{ treatment: 'add'; reminder: ReminderState; position?: number }>
  | Readonly<{ treatment: 'update'; ownedIndex: number; reminder: ReminderState }>
  | Readonly<{ treatment: 'delete'; ownedIndex: number }>;

export type ReminderUpdateResult =
  | Readonly<{ treatment: 'keep' | 'drop' }>
  | Readonly<{ treatment: 'update'; updatedContent: string; updatedMeta?: unknown }>;

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
      reminderNo: number;
      workLanguage: 'zh' | 'en';
    }>,
  ) => Promise<Readonly<{ content: string }>>;
}>;

type ToolHandler = (
  args: Record<string, unknown>,
  ctx: ToolCtx,
) => Promise<string | StructuredToolResult>;

export type WebDevAppHost = Readonly<{
  tools: Readonly<Record<string, ToolHandler>>;
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
  electronLaunched: number;
  electronClosed: number;
  newContextOptions: unknown[];
  electronLaunchOptions: unknown[];
  screenshotCalls: unknown[];
};

export type FakePlaywrightEnvironment = Readonly<{
  playwright: FakePlaywrightModule;
  trackers: FakeTrackerState;
}>;

type WebDevAppFactoryContext = AppFactoryContext &
  Readonly<{
    playwrightLoader?: () => Promise<FakePlaywrightModule>;
  }>;

export type WebDevFixture = Readonly<{
  tempRoot: string;
  rtwsAppDirAbs: string;
  sessionsCacheDirAbs: string;
  artifactsDirAbs: string;
  legacySessionsDirAbs: string;
  fakeEnv: FakePlaywrightEnvironment;
  host: WebDevAppHost;
  reminderOwner: ReminderOwnerHandler;
  controllerCtx: ToolCtx;
  observerCtx: ToolCtx;
  cleanup: () => Promise<void>;
}>;

export async function pathExists(absPath: string): Promise<boolean> {
  try {
    await fs.access(absPath);
    return true;
  } catch {
    return false;
  }
}

export function assertStructuredResult(
  result: string | StructuredToolResult,
): asserts result is StructuredToolResult {
  assert.equal(typeof result, 'object');
  assert.notEqual(result, null);
  assert.equal(typeof result.output, 'string');
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
    electronLaunched: 0,
    electronClosed: 0,
    newContextOptions: [],
    electronLaunchOptions: [],
    screenshotCalls: [],
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

export async function createWebDevFixture(): Promise<WebDevFixture> {
  const repoRootAbs = path.resolve(__dirname, '..', '..', '..');
  const appId = '@longrun-ai/web-dev';
  const appIdPathParts = ['@longrun-ai', 'web-dev'];
  const packageRootAbs = path.join(repoRootAbs, 'dominds-apps', ...appIdPathParts);
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-web-dev-session-'));
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
  const { appFactory } = await loadLocalAppEntry({ packageRootAbs });
  const fakeEnv = createFakePlaywrightEnvironment();
  const webDevAppFactory = appFactory as unknown as (
    ctx: WebDevAppFactoryContext,
  ) => Promise<WebDevAppHost>;
  const host = await webDevAppFactory({
    appId,
    rtwsRootAbs: tempRoot,
    rtwsAppDirAbs,
    packageRootAbs,
    kernel: { host: '127.0.0.1', port: 0 },
    log: () => undefined,
    playwrightLoader: async () => fakeEnv.playwright,
  });
  const reminderOwner = host.reminderOwners?.['js_repl_session'];
  assert.ok(reminderOwner, 'expected js_repl_session reminder owner');
  if (!reminderOwner) {
    throw new Error('missing js_repl_session reminder owner');
  }
  return {
    tempRoot,
    rtwsAppDirAbs,
    sessionsCacheDirAbs,
    artifactsDirAbs,
    legacySessionsDirAbs,
    fakeEnv,
    host,
    reminderOwner,
    controllerCtx: {
      dialogId: 'dlg_controller',
      rootDialogId: 'root_demo',
      agentId: 'web_tester_from_app',
      sessionSlug: 'smoke',
      callerId: 'fullstack',
    },
    observerCtx: {
      dialogId: 'dlg_observer',
      rootDialogId: 'root_demo',
      agentId: 'web_developer_from_app',
      sessionSlug: 'fix-loop',
      callerId: 'fullstack',
    },
    cleanup: async () => {
      await fs.rm(tempRoot, { recursive: true, force: true });
    },
  };
}
