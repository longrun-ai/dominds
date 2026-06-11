import assert from 'node:assert/strict';
import { normalizeSetupEnvValueInput } from '../webapp/src/utils/setupEnvInput';

function run(): void {
  assert.equal(
    normalizeSetupEnvValueInput(String.raw`"C:\Users\Administrator\.codex-JulianBrooks922012"`),
    String.raw`C:\Users\Administrator\.codex-JulianBrooks922012`,
  );

  assert.equal(
    normalizeSetupEnvValueInput(String.raw`"C:\\Users\\Administrator\\.codex-JulianBrooks922012"`),
    String.raw`C:\Users\Administrator\.codex-JulianBrooks922012`,
  );

  assert.equal(
    normalizeSetupEnvValueInput(String.raw`"\\server\share\codex home"`),
    String.raw`\\server\share\codex home`,
  );

  assert.equal(
    normalizeSetupEnvValueInput(String.raw`"\\\\server\\share\\codex home"`),
    String.raw`\\server\share\codex home`,
  );

  assert.equal(
    normalizeSetupEnvValueInput(String.raw`"sk-proj-example\not-a-path"`),
    String.raw`sk-proj-example\not-a-path`,
  );

  assert.equal(normalizeSetupEnvValueInput("'sk-proj-example'"), 'sk-proj-example');

  assert.equal(normalizeSetupEnvValueInput('"line-one\nline-two"'), '"line-one\nline-two"');

  assert.equal(normalizeSetupEnvValueInput(String.raw`"unterminated`), String.raw`"unterminated`);

  assert.equal(
    normalizeSetupEnvValueInput(String.raw`C:\Users\Administrator\.codex`),
    String.raw`C:\Users\Administrator\.codex`,
  );

  console.log('setup-env-input tests: ok');
}

run();
