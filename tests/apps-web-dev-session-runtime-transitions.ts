import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {
  rejectWebDevAction,
  runExternalWebDevScenario,
  webDevComponentIdentity,
} from './helpers/external-web-dev';
import { semanticEvidenceCollector } from './helpers/semantic-evidence';

import {
  assertRecord,
  assertSuccessfulResult,
  createWebDevFixture,
  requireReminderStateAdded,
  requireSingleUpsertReminder,
  sessionIdFromReminder,
} from './helpers/web-dev-session-fixture';

const evidence = semanticEvidenceCollector(
  'dominds-external-apps-web-dev-session-runtime-transitions-',
);
const observations: Array<{ stage: string; text: string; outcome?: string }> = [];
function observe(stage: string, text: string, outcome?: string): void {
  observations.push({ stage, text, ...(outcome ? { outcome } : {}) });
}

async function main(): Promise<void> {
  const fixture = await createWebDevFixture();
  let completed = false;
  try {
    const created = await fixture.host.tools.playwright_session_new(
      {
        kind: 'web',
        label: 'runtime-transitions',
        entryUrl: 'https://example.test/initial',
      },
      fixture.controllerCtx,
    );
    assertSuccessfulResult(created);
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
    assertSuccessfulResult(modeResult);
    observe('modeResult', modeResult.output.content, modeResult.output.outcome);

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
    assertSuccessfulResult(normalizedScreenshot);
    observe(
      'normalizedScreenshot',
      normalizedScreenshot.output.content,
      normalizedScreenshot.output.outcome,
    );
    const capturedScreenshotBytes = fixture.fakeEnv.trackers.screenshotBodies.at(-1);
    assert.ok(capturedScreenshotBytes);
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
    assertSuccessfulResult(fitCheck);
    observe('fitCheck', fitCheck.output.content, fitCheck.output.outcome);
    const measuredSession: unknown = JSON.parse(
      await fs.readFile(path.join(fixture.sessionsCacheDirAbs, sessionId + '.json'), 'utf8'),
    );
    assertRecord(measuredSession);
    assertRecord(measuredSession['evidence']);
    const viewportChecks = measuredSession['evidence']['viewportChecks'];
    assert.ok(Array.isArray(viewportChecks));
    const measuredCheck: unknown = viewportChecks.at(-1);
    assertRecord(measuredCheck);
    assert.equal(measuredCheck['pass'], true);
    assert.deepEqual(measuredCheck['issues'], []);
    assertRecord(measuredCheck['metrics']);
    assert.equal(measuredCheck['metrics']['viewportWidth'], 1280);
    assert.equal(measuredCheck['metrics']['viewportHeight'], 720);

    fixture.fakeEnv.trackers.failViewportMeasurement = true;
    const measurementFailure = await rejectWebDevAction(
      async () =>
        await fixture.host.tools.playwright_session_viewport_fit_check(
          { sessionId },
          fixture.controllerCtx,
        ),
    );
    observe('measurementFailure', measurementFailure.message);
    fixture.fakeEnv.trackers.failViewportMeasurement = false;

    const relaunch = await fixture.host.tools.playwright_session_relaunch(
      {
        sessionId,
        reason: 'startup_changed',
        waitUntil: 'commit',
      },
      fixture.controllerCtx,
    );
    assertSuccessfulResult(relaunch);
    observe('relaunch', relaunch.output.content, relaunch.output.outcome);

    assert.equal(fixture.fakeEnv.trackers.launched, 2);
    assert.equal(fixture.fakeEnv.trackers.browserClosed, 1);

    const webArtifacts = await fs.readdir(path.join(fixture.artifactsDirAbs, sessionId));
    const capturedArtifact = webArtifacts.find((entry) =>
      /native-window-normalized\.png$/.test(entry),
    );
    assert.ok(capturedArtifact);
    assert.deepEqual(
      await fs.readFile(path.join(fixture.artifactsDirAbs, sessionId, capturedArtifact)),
      capturedScreenshotBytes,
      'Artifact bytes preserve the controlled provider payload, not real image validation',
    );

    const electronCreated = await fixture.host.tools.playwright_session_new(
      {
        kind: 'electron',
        label: 'electron-contract',
        entryUrl: '.',
      },
      fixture.controllerCtx,
    );
    assertSuccessfulResult(electronCreated);
    observe('electronCreated', electronCreated.output.content, electronCreated.output.outcome);
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
    assertSuccessfulResult(electronEval);
    observe('electronEval', electronEval.output.content, electronEval.output.outcome);

    const electronReload = await fixture.host.tools.playwright_session_reload(
      { sessionId: electronSessionId, waitUntil: 'domcontentloaded', surfaceHint: 'appWindow' },
      fixture.controllerCtx,
    );
    assertSuccessfulResult(electronReload);
    observe('electronReload', electronReload.output.content, electronReload.output.outcome);

    const electronRelaunch = await fixture.host.tools.playwright_session_relaunch(
      {
        sessionId: electronSessionId,
        reason: 'startup_changed',
        entryUrl: './main.js',
        waitUntil: 'commit',
      },
      fixture.controllerCtx,
    );
    assertSuccessfulResult(electronRelaunch);
    observe('electronRelaunch', electronRelaunch.output.content, electronRelaunch.output.outcome);

    assert.equal(fixture.fakeEnv.trackers.electronLaunched, 2);

    const electronClosed = await fixture.host.tools.playwright_session_close(
      { sessionId: electronSessionId },
      fixture.controllerCtx,
    );
    assertSuccessfulResult(electronClosed);
    observe('electronClosed', electronClosed.output.content, electronClosed.output.outcome);
    completed = true;
  } finally {
    await fixture.cleanup({ preserve: !completed });
  }
}

runExternalWebDevScenario(async () => {
  await main();
  const identity = webDevComponentIdentity();
  evidence.record({
    id: 'runtime-transition-guidance',
    scenario:
      'The selected external component switches mode, captures with supplied screenshot parameters, measures a controlled viewport, handles measurement failure, and routes browser/Electron reload and relaunch.',
    businessValue:
      'Make resource-transition and recovery guidance agree with actual adapter calls and recorded data, while distinguishing the controlled boundary from a running real browser or Electron window.',
    context: {
      ...{
        controlledViewport: '1280x720',
        normalizedClip: '40,32,640,360',
        electronRelaunchEntry: './main.js',
        actualBrowserExecuted: false,
        boundary:
          'Real selected component; controlled Playwright/Electron provider, no real browser/visual QA acceptance.',
      },
      componentRoot: identity.root,
      componentPackageJsonSha256: identity.packageJsonSha256,
    },
    reviewQuestions: [
      'Do actual mode/relaunch/reload receipts explain the correct process versus renderer boundary and requested surface?',
      'Does viewport guidance agree with the controlled metrics and actual success or failure?',
      'Do Electron-related receipts preserve the requested entry/surface while avoiding claims of real window, screenshot or visual QA validation?',
    ],
    actualText: JSON.stringify(observations, null, 2),
  });
  await evidence.write();
  console.log(
    'Selected external Web Dev machine workflow completed; semantic acceptance is separate.',
  );
});
