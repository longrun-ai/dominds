import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';

import {
  assertStructuredResult,
  createWebDevFixture,
  pathExists,
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
        label: 'browser-smoke',
        entryUrl: 'https://example.test/initial',
      },
      fixture.controllerCtx,
    );
    assertStructuredResult(created);
    assert.match(created.output, /ok: created Web Dev browser session\./);
    assert.match(
      created.output,
      /state=ready \| role=controller \| runtime=playwright_browser_runtime \| browserMode=desktop/,
    );
    assert.match(created.output, /surface: page https:\/\/example\.test\/initial/);

    const controllerReminder = requireReminderStateAdded(
      await fixture.reminderOwner.apply(requireSingleUpsertReminder(created), {
        dialogId: fixture.controllerCtx.dialogId,
        ownedReminders: [],
      }),
    );
    const sessionId = sessionIdFromReminder(controllerReminder);
    assert.equal(
      await pathExists(path.join(fixture.sessionsCacheDirAbs, `${sessionId}.json`)),
      true,
    );
    assert.equal(await pathExists(fixture.legacySessionsDirAbs), false);

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
    assert.match(evalResult.output, /ok: session eval completed\./);
    assert.match(evalResult.output, /"url":"https:\/\/example\.test\/after-eval"/);
    assert.match(evalResult.output, /"remembered":"Clicked 1"/);

    const screenshotResult = await fixture.host.tools.playwright_session_screenshot(
      { sessionId, label: 'after-eval-proof', imageType: 'png' },
      fixture.controllerCtx,
    );
    assertStructuredResult(screenshotResult);
    assert.match(screenshotResult.output, /ok: session screenshot captured\./);
    const artifacts = await fs.readdir(path.join(fixture.artifactsDirAbs, sessionId));
    assert.equal(artifacts.length, 1);
    assert.ok(artifacts.some((entry) => /after-eval-proof\.png$/.test(entry)));

    const closed = await fixture.host.tools.playwright_session_close(
      { sessionId },
      fixture.controllerCtx,
    );
    assertStructuredResult(closed);
    assert.match(closed.output, /ok: session closed\./);

    const controllerReminderUpdate = await fixture.reminderOwner.updateReminder({
      dialogId: fixture.controllerCtx.dialogId,
      reminder: controllerReminder,
    });
    assert.equal(controllerReminderUpdate.treatment, 'drop');
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
