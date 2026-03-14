import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';

import {
  assertStructuredResult,
  createWebDevFixture,
  requireReminderStateAdded,
  requireSingleUpsertReminder,
  sessionIdFromReminder,
} from './helpers/web-dev-session-fixture';

async function main(): Promise<void> {
  const fixture = await createWebDevFixture();
  try {
    const created = await fixture.host.tools.playwright_session_new(
      {
        kind: 'web',
        label: 'runtime-transitions',
        entryUrl: 'https://example.test/initial',
      },
      fixture.controllerCtx,
    );
    assertStructuredResult(created);
    const controllerReminder = requireReminderStateAdded(
      await fixture.reminderOwner.apply(requireSingleUpsertReminder(created), {
        dialogId: fixture.controllerCtx.dialogId,
        ownedReminders: [],
      }),
    );
    const sessionId = sessionIdFromReminder(controllerReminder);

    const modeResult = await fixture.host.tools.playwright_session_mode(
      { sessionId, browserMode: 'native_window', waitUntil: 'networkidle' },
      fixture.controllerCtx,
    );
    assertStructuredResult(modeResult);
    assert.match(modeResult.output, /ok: session browser mode switched\./);
    assert.match(modeResult.output, /previousMode=desktop/);
    assert.match(modeResult.output, /browserMode=native_window/);
    assert.equal(fixture.fakeEnv.trackers.contextClosed, 1);
    assert.deepEqual(fixture.fakeEnv.trackers.newContextOptions.at(-1), { viewport: null });

    const normalizedScreenshot = await fixture.host.tools.playwright_session_screenshot_normalized(
      {
        sessionId,
        label: 'native-window-normalized',
        imageType: 'png',
        normalizationMode: 'device',
        clip: { x: 40, y: 32, width: 640, height: 360 },
      },
      fixture.controllerCtx,
    );
    assertStructuredResult(normalizedScreenshot);
    assert.match(normalizedScreenshot.output, /ok: normalized session screenshot captured\./);
    assert.deepEqual(fixture.fakeEnv.trackers.screenshotCalls.at(-1), {
      type: 'png',
      scale: 'device',
      clip: { x: 40, y: 32, width: 640, height: 360 },
    });

    const fitCheck = await fixture.host.tools.playwright_session_viewport_fit_check(
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
      fixture.controllerCtx,
    );
    assertStructuredResult(fitCheck);
    assert.match(fitCheck.output, /ok: session viewport fit check passed\./);
    assert.match(
      fitCheck.output,
      /PASS surface=page viewport=1280x720 document=1280x720 regions=1/,
    );

    const relaunch = await fixture.host.tools.playwright_session_relaunch(
      {
        sessionId,
        reason: 'startup_changed',
        waitUntil: 'commit',
      },
      fixture.controllerCtx,
    );
    assertStructuredResult(relaunch);
    assert.match(relaunch.output, /ok: session browser runtime relaunched\./);
    assert.match(
      relaunch.output,
      /boundary=use relaunch after startup\/process-ownership changes; use reload for renderer-only changes\./,
    );
    assert.equal(fixture.fakeEnv.trackers.launched, 2);
    assert.equal(fixture.fakeEnv.trackers.browserClosed, 1);

    const webArtifacts = await fs.readdir(path.join(fixture.artifactsDirAbs, sessionId));
    assert.ok(webArtifacts.some((entry) => /native-window-normalized\.png$/.test(entry)));

    const electronCreated = await fixture.host.tools.playwright_session_new(
      {
        kind: 'electron',
        label: 'electron-contract',
        entryUrl: '.',
      },
      fixture.controllerCtx,
    );
    assertStructuredResult(electronCreated);
    assert.match(electronCreated.output, /ok: created Web Dev electron session\./);
    const electronReminder = requireReminderStateAdded(
      await fixture.reminderOwner.apply(requireSingleUpsertReminder(electronCreated), {
        dialogId: fixture.controllerCtx.dialogId,
        ownedReminders: [controllerReminder],
      }),
    );
    const electronSessionId = sessionIdFromReminder(electronReminder);

    const electronEval = await fixture.host.tools.playwright_session_eval(
      {
        sessionId: electronSessionId,
        surfaceHint: 'appWindow',
        code: [
          'await waitForSelector("#increment");',
          'await click("#increment");',
          'return {',
          '  url: url(),',
          '  statusText: await textContent("#status"),',
          '  activeSurfaceRole: activeSurface?.role ?? null,',
          '  hasElectronApp: bindings.electronApp,',
          '  hasAppWindow: bindings.appWindow,',
          '};',
        ].join('\n'),
      },
      fixture.controllerCtx,
    );
    assertStructuredResult(electronEval);
    assert.match(electronEval.output, /runtime=playwright_electron_runtime/);
    assert.match(electronEval.output, /"activeSurfaceRole":"appWindow"/);
    assert.match(electronEval.output, /"hasElectronApp":true/);

    const electronReload = await fixture.host.tools.playwright_session_reload(
      { sessionId: electronSessionId, waitUntil: 'domcontentloaded', surfaceHint: 'appWindow' },
      fixture.controllerCtx,
    );
    assertStructuredResult(electronReload);
    assert.match(electronReload.output, /ok: session app window reloaded\./);

    const electronRelaunch = await fixture.host.tools.playwright_session_relaunch(
      {
        sessionId: electronSessionId,
        reason: 'startup_changed',
        entryUrl: './main.js',
        waitUntil: 'commit',
      },
      fixture.controllerCtx,
    );
    assertStructuredResult(electronRelaunch);
    assert.match(electronRelaunch.output, /sessionKind=electron/);
    assert.match(electronRelaunch.output, /entryUrl=\.\/main\.js/);
    assert.equal(fixture.fakeEnv.trackers.electronLaunched, 2);

    const electronClosed = await fixture.host.tools.playwright_session_close(
      { sessionId: electronSessionId },
      fixture.controllerCtx,
    );
    assertStructuredResult(electronClosed);
    assert.match(electronClosed.output, /ok: session closed\./);
  } finally {
    await fixture.cleanup();
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
