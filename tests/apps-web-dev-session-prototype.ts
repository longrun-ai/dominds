import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

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
  goto: (url: string) => Promise<void>;
  click: (selector: string) => Promise<void>;
  fill: (selector: string, value: string) => Promise<void>;
  textContent: (selector: string) => Promise<string | null>;
  title: () => Promise<string>;
  url: () => string;
  content: () => Promise<string>;
  waitForSelector: (selector: string) => Promise<Readonly<{ selector: string }>>;
  locator: (selector: string) => Readonly<{ selector: string }>;
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
  devices: Readonly<Record<string, Record<string, unknown>>>;
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

type HostModule = Readonly<{
  createDomindsAppHost: (ctx: HostFactoryContext) => Promise<AppHost>;
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
  };

  function createFakePage(): FakePage {
    let currentState = createPageState('about:blank');
    let pageClosed = false;

    return {
      goto: async (url) => {
        currentState = createPageState(url);
        currentState.html = buildRenderedHtml(currentState);
      },
      click: async (selector) => {
        if (selector === '#increment') {
          currentState.statusText = 'Clicked 1';
          currentState.title = 'After Click';
          currentState.html = buildRenderedHtml(currentState);
          return;
        }
        assert.equal(selector, '#go');
        currentState.statusText = currentState.searchValue;
        currentState.html = buildRenderedHtml(currentState);
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
      newContext: async () => createFakeBrowserContext(),
      close: async () => {
        trackers.browserClosed += 1;
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
    devices: {
      'iPhone 13': { viewport: { width: 390, height: 844 } },
    },
  };

  return { playwright, trackers };
}

async function main(): Promise<void> {
  const repoRootAbs = path.resolve(__dirname, '..', '..');
  const packageRootAbs = path.join(repoRootAbs, 'dominds-apps', 'web-dev');
  const hostModuleAbs = path.join(packageRootAbs, 'src', 'app-host.js');
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-web-dev-session-prototype-'));
  const rtwsAppDirAbs = path.join(tempRoot, '.apps', 'web_dev');
  const sessionsCacheDirAbs = path.join(tempRoot, '.cache', 'web-dev', 'js-repl', 'sessions');
  const legacySessionsDirAbs = path.join(rtwsAppDirAbs, 'state', 'js-repl', 'sessions');

  try {
    const hostModuleUnknown = await import(pathToFileURL(hostModuleAbs).href);
    const hostModule = hostModuleUnknown as HostModule;
    const fakeEnv = createFakePlaywrightEnvironment();

    const host = await hostModule.createDomindsAppHost({
      appId: 'web_dev',
      rtwsRootAbs: tempRoot,
      rtwsAppDirAbs,
      packageRootAbs,
      kernel: { host: '127.0.0.1', port: 0 },
      log: () => undefined,
      playwrightLoader: async () => fakeEnv.playwright,
    });

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
    assert.match(created.output, /runtime=playwright_browser_runtime/);
    assert.match(created.output, /surfaces=page:https:\/\/example\.test\/initial/);
    assert.match(created.output, /viewerRole=controller/);
    assert.equal(fakeEnv.trackers.launched, 1);

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
    assert.match(evalResult.output, /result: .*"url":"https:\/\/example\.test\/after-eval"/);
    assert.match(evalResult.output, /result: .*"statusText":"Clicked 1"/);
    assert.match(evalResult.output, /result: .*"searchValue":"alpha"/);
    assert.match(evalResult.output, /result: .*"remembered":"Clicked 1"/);
    assert.match(evalResult.output, /result: .*"activeSurfaceRole":"page"/);
    assert.match(evalResult.output, /surfaces=page:https:\/\/example\.test\/after-eval/);

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
    assert.match(dataUrlStatus.output, /runtime=playwright_browser_runtime/);
    assert.match(dataUrlStatus.output, /\(Smoke\)/);

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
    assert.match(dataUrlEval.output, /result: .*"title":"Smoke"/);
    assert.match(dataUrlEval.output, /result: .*"out":"dominds"/);
    assert.match(dataUrlEval.output, /result: .*"url":"data:text\/html,/);

    const dataUrlClosed = await host.tools.playwright_session_close(
      { sessionId: dataUrlSessionId },
      controllerCtx,
    );
    assertStructuredResult(dataUrlClosed);
    assert.match(dataUrlClosed.output, /ok: session closed\./);
    assert.equal(fakeEnv.trackers.contextClosed, 1);
    assert.equal(fakeEnv.trackers.browserClosed, 1);

    const attached = await host.tools.playwright_session_attach(
      {
        sessionId,
        role: 'observer',
        target: {
          rootDialogId: observerCtx.rootDialogId,
          agentId: observerCtx.agentId,
          sessionSlug: observerCtx.sessionSlug,
        },
      },
      controllerCtx,
    );
    assertStructuredResult(attached);
    assert.match(attached.output, /ok: session attachment updated\./);
    assert.ok(Array.isArray(attached.dialogReminderRequests));
    assert.equal(attached.dialogReminderRequests?.length, 1);
    const observerBatch = attached.dialogReminderRequests?.[0];
    assert.ok(observerBatch, 'expected observer reminder batch');
    assert.equal(observerBatch?.target['agentId'], observerCtx.agentId);
    assert.equal(observerBatch?.target['sessionSlug'], observerCtx.sessionSlug);
    const observerUpsert = observerBatch?.reminderRequests[0];
    assert.ok(observerUpsert, 'expected observer reminder request');
    assert.equal(observerUpsert?.kind, 'upsert');
    const observerReminderState = requireReminderStateAdded(
      await reminderOwner.apply(observerUpsert as ReminderRequest, {
        dialogId: observerCtx.dialogId,
        ownedReminders: [],
      }),
    );

    const observerStatus = await host.tools.playwright_session_status({ sessionId }, observerCtx);
    assertStructuredResult(observerStatus);
    assert.match(observerStatus.output, /ok: Web Dev browser session status refreshed\./);
    assert.match(observerStatus.output, /viewerRole=observer/);
    assert.match(observerStatus.output, /surfaces=page:https:\/\/example\.test\/after-eval/);
    assert.match(observerStatus.output, /ui note: the reminder panel is the source of truth/);

    const renderedReminder = await reminderOwner.renderReminder({
      dialogId: observerCtx.dialogId,
      reminder: observerReminderState,
      reminderNo: 1,
      workLanguage: 'en',
    });
    assert.match(renderedReminder.content, /attached as: observer/);
    assert.match(renderedReminder.content, /runtime: playwright_browser_runtime/);

    const detached = await host.tools.playwright_session_detach(
      {
        sessionId,
        target: {
          rootDialogId: observerCtx.rootDialogId,
          agentId: observerCtx.agentId,
          sessionSlug: observerCtx.sessionSlug,
        },
      },
      controllerCtx,
    );
    assertStructuredResult(detached);
    assert.match(detached.output, /ok: session detached\./);
    assert.match(detached.output, /1 reminder update\(s\) queued for 1 other dialog\(s\)/);

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
    }

    const closed = await host.tools.playwright_session_close({ sessionId }, controllerCtx);
    assertStructuredResult(closed);
    assert.match(closed.output, /ok: session closed\./);
    assert.match(closed.output, /removedAttachments=1/);
    assert.equal(fakeEnv.trackers.contextClosed, 2);
    assert.equal(fakeEnv.trackers.browserClosed, 2);

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
