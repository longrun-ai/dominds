import assert from 'node:assert/strict';
import { readonlyShellTool, shellCmdTool } from '../../main/tools/os';
import { buildCapturedShellEnv } from '../../main/tools/shell-capture-env';
import { fixtureJson, withShellDialog, writeNodeProgram } from '../helpers/shell-fixture';

const expected = {
  NO_COLOR: '1',
  FORCE_COLOR: null,
  TERM: 'dumb',
  CLICOLOR: '0',
  CLICOLOR_FORCE: null,
  COLORTERM: null,
  NODE_DISABLE_COLORS: '1',
  PY_COLORS: '0',
  CARGO_TERM_COLOR: 'never',
  RUST_LOG_STYLE: 'never',
  YARN_ENABLE_COLORS: '0',
  NPM_CONFIG_COLOR: 'false',
  NPM_CONFIG_PROGRESS: 'false',
  PNPM_CONFIG_COLOR: 'false',
  npm_config_color: 'false',
  npm_config_progress: 'false',
  pnpm_config_color: 'false',
};
const ansi = /\x1B\[[0-?]*[ -/]*[@-~]/u; // Terminal control bytes, not natural-language meaning.
async function main() {
  const source: NodeJS.ProcessEnv = {
    PATH: '/fixture/path',
    OTHER_DATA: 'preserved-data',
    force_color: '1',
    Term_Program: 'ExampleTerminal',
    colorterm: 'truecolor',
    No_Color: '0',
    CliColor: '1',
    Node_Disable_Colors: '0',
    Py_Colors: '1',
    Cargo_Term_Color: 'always',
    Rust_Log_Style: 'always',
    Yarn_Enable_Colors: '1',
    npm_config_color: 'always',
    Npm_Config_Progress: 'true',
  };
  const original = { ...source };
  const captured = buildCapturedShellEnv(source);
  assert.deepEqual(source, original);
  assert.equal(captured.PATH, source.PATH);
  assert.equal(captured.OTHER_DATA, source.OTHER_DATA);
  for (const key of Object.keys(source)) {
    if (!(key in expected) && key !== 'PATH' && key !== 'OTHER_DATA')
      assert.equal(captured[key], undefined, 'Mixed-case terminal aliases must be removed');
  }
  for (const [key, value] of Object.entries(expected))
    assert.equal(captured[key] ?? null, value, key);

  // Change only the known colour/progress variables; never dump the ambient environment.
  const previous = Object.fromEntries(Object.keys(expected).map((key) => [key, process.env[key]]));
  try {
    for (const key of Object.keys(expected)) process.env[key] = 'always';
    await withShellDialog('en', async (dialog, caller) => {
      const probe = 'capture-env-data:178a';
      const command = await writeNodeProgram(
        'capture-env',
        'const keys = ' +
          JSON.stringify(Object.keys(expected)) +
          ';' +
          'console.log(JSON.stringify({probe:' +
          JSON.stringify(probe) +
          ',isTTY:process.stdout.isTTY===true,...Object.fromEntries(keys.map(k=>[k,process.env[k]??null]))}));',
      );
      const result = await shellCmdTool.call(dialog, caller, { command, timeoutSeconds: 5 });
      assert.equal(result.outcome, 'success');
      assert.deepEqual(fixtureJson(result.content, probe), { probe, isTTY: false, ...expected });
      assert.doesNotMatch(result.content, ansi);
      if (process.platform === 'win32') {
        console.log(
          'UNEXECUTED: POSIX readonly-shell environment expansion on Windows; no readonly TTY claim.',
        );
        return;
      }
      const values = Object.keys(expected)
        .map((key) => key + '=${' + key + '-unset}')
        .join(' ');
      const readonly = await readonlyShellTool.call(dialog, caller, {
        command: 'echo "probe=capture-readonly-data ' + values + '"',
        timeout_ms: 2_000,
      });
      assert.equal(readonly.outcome, 'success');
      const records = readonly.content
        .split(/\r?\n/)
        .filter((line) => line.startsWith('probe=capture-readonly-data '));
      assert.equal(records.length, 1);
      const fields = Object.fromEntries(records[0]!.split(' ').map((field) => field.split('=')));
      assert.deepEqual(fields, {
        probe: 'capture-readonly-data',
        ...Object.fromEntries(
          Object.entries(expected).map(([key, value]) => [key, value ?? 'unset']),
        ),
      });
      assert.doesNotMatch(readonly.content, ansi);
      // readonly_shell's allowlist does not execute a Node TTY probe; only its env data is measured.
    });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  console.log('Captured environment data and control-byte policy: PASS');
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
