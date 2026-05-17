#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import type { Dialog } from '../../main/dialog';
import { setWorkLanguage } from '../../main/runtime/work-language';
import { Team } from '../../main/team';
import { readonlyShellTool, shellCmdTool } from '../../main/tools/os';
import { buildCapturedShellEnv } from '../../main/tools/shell-capture-env';

type EnvSnapshot = Readonly<{
  isTTY: boolean;
  NO_COLOR: string | null;
  FORCE_COLOR: string | null;
  TERM: string | null;
  CLICOLOR: string | null;
  CLICOLOR_FORCE: string | null;
  COLORTERM: string | null;
  NODE_DISABLE_COLORS: string | null;
  PY_COLORS: string | null;
  CARGO_TERM_COLOR: string | null;
  RUST_LOG_STYLE: string | null;
  YARN_ENABLE_COLORS: string | null;
  NPM_CONFIG_COLOR: string | null;
  NPM_CONFIG_PROGRESS: string | null;
  PNPM_CONFIG_COLOR: string | null;
  npm_config_color: string | null;
  npm_config_progress: string | null;
  pnpm_config_color: string | null;
}>;

const ANSI_ESCAPE_RE = /\x1B\[[0-?]*[ -/]*[@-~]/u;

const shellEnvProbeScript =
  'const e = process.env; console.log(JSON.stringify({ ' +
  'isTTY: process.stdout.isTTY === true, ' +
  'NO_COLOR: e.NO_COLOR ?? null, ' +
  'FORCE_COLOR: e.FORCE_COLOR ?? null, ' +
  'TERM: e.TERM ?? null, ' +
  'CLICOLOR: e.CLICOLOR ?? null, ' +
  'CLICOLOR_FORCE: e.CLICOLOR_FORCE ?? null, ' +
  'COLORTERM: e.COLORTERM ?? null, ' +
  'NODE_DISABLE_COLORS: e.NODE_DISABLE_COLORS ?? null, ' +
  'PY_COLORS: e.PY_COLORS ?? null, ' +
  'CARGO_TERM_COLOR: e.CARGO_TERM_COLOR ?? null, ' +
  'RUST_LOG_STYLE: e.RUST_LOG_STYLE ?? null, ' +
  'YARN_ENABLE_COLORS: e.YARN_ENABLE_COLORS ?? null, ' +
  'NPM_CONFIG_COLOR: e.NPM_CONFIG_COLOR ?? null, ' +
  'NPM_CONFIG_PROGRESS: e.NPM_CONFIG_PROGRESS ?? null, ' +
  'PNPM_CONFIG_COLOR: e.PNPM_CONFIG_COLOR ?? null, ' +
  'npm_config_color: e.npm_config_color ?? null, ' +
  'npm_config_progress: e.npm_config_progress ?? null, ' +
  'pnpm_config_color: e.pnpm_config_color ?? null, ' +
  '}));';

function requireNullableStringField(
  raw: Readonly<Record<string, unknown>>,
  key: keyof EnvSnapshot,
): string | null {
  const value = raw[key];
  assert.ok(value === null || typeof value === 'string', `Expected ${key} to be string|null`);
  return value;
}

function extractJsonObject(text: string): EnvSnapshot {
  const match = /\{[^\n]*"isTTY"[^\n]*\}/u.exec(text);
  assert.ok(match, `Expected JSON env snapshot in output:\n${text}`);
  const parsed: unknown = JSON.parse(match[0]);
  assert.equal(typeof parsed, 'object');
  assert.notEqual(parsed, null);
  const raw = parsed as Readonly<Record<string, unknown>>;
  assert.equal(typeof raw.isTTY, 'boolean');
  return {
    isTTY: raw.isTTY,
    NO_COLOR: requireNullableStringField(raw, 'NO_COLOR'),
    FORCE_COLOR: requireNullableStringField(raw, 'FORCE_COLOR'),
    TERM: requireNullableStringField(raw, 'TERM'),
    CLICOLOR: requireNullableStringField(raw, 'CLICOLOR'),
    CLICOLOR_FORCE: requireNullableStringField(raw, 'CLICOLOR_FORCE'),
    COLORTERM: requireNullableStringField(raw, 'COLORTERM'),
    NODE_DISABLE_COLORS: requireNullableStringField(raw, 'NODE_DISABLE_COLORS'),
    PY_COLORS: requireNullableStringField(raw, 'PY_COLORS'),
    CARGO_TERM_COLOR: requireNullableStringField(raw, 'CARGO_TERM_COLOR'),
    RUST_LOG_STYLE: requireNullableStringField(raw, 'RUST_LOG_STYLE'),
    YARN_ENABLE_COLORS: requireNullableStringField(raw, 'YARN_ENABLE_COLORS'),
    NPM_CONFIG_COLOR: requireNullableStringField(raw, 'NPM_CONFIG_COLOR'),
    NPM_CONFIG_PROGRESS: requireNullableStringField(raw, 'NPM_CONFIG_PROGRESS'),
    PNPM_CONFIG_COLOR: requireNullableStringField(raw, 'PNPM_CONFIG_COLOR'),
    npm_config_color: requireNullableStringField(raw, 'npm_config_color'),
    npm_config_progress: requireNullableStringField(raw, 'npm_config_progress'),
    pnpm_config_color: requireNullableStringField(raw, 'pnpm_config_color'),
  };
}

async function main(): Promise<void> {
  setWorkLanguage('en');

  const sourceEnv: NodeJS.ProcessEnv = {
    PATH: '/tmp/example-path',
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
  const capturedEnv = buildCapturedShellEnv(sourceEnv);
  assert.equal(sourceEnv.force_color, '1');
  assert.equal(sourceEnv.Term_Program, 'ExampleTerminal');
  assert.equal(capturedEnv.PATH, '/tmp/example-path');
  assert.equal(capturedEnv.force_color, undefined);
  assert.equal(capturedEnv.Term_Program, undefined);
  assert.equal(capturedEnv.colorterm, undefined);
  assert.equal(capturedEnv.No_Color, undefined);
  assert.equal(capturedEnv.CliColor, undefined);
  assert.equal(capturedEnv.Node_Disable_Colors, undefined);
  assert.equal(capturedEnv.Py_Colors, undefined);
  assert.equal(capturedEnv.Cargo_Term_Color, undefined);
  assert.equal(capturedEnv.Rust_Log_Style, undefined);
  assert.equal(capturedEnv.Yarn_Enable_Colors, undefined);
  assert.equal(capturedEnv.Npm_Config_Progress, undefined);
  assert.equal(capturedEnv.NO_COLOR, '1');
  assert.equal(capturedEnv.CLICOLOR, '0');
  assert.equal(capturedEnv.TERM, 'dumb');
  assert.equal(capturedEnv.NODE_DISABLE_COLORS, '1');
  assert.equal(capturedEnv.PY_COLORS, '0');
  assert.equal(capturedEnv.CARGO_TERM_COLOR, 'never');
  assert.equal(capturedEnv.RUST_LOG_STYLE, 'never');
  assert.equal(capturedEnv.YARN_ENABLE_COLORS, '0');
  assert.equal(capturedEnv.NPM_CONFIG_COLOR, 'false');
  assert.equal(capturedEnv.npm_config_color, 'false');

  const originalEnv = {
    FORCE_COLOR: process.env.FORCE_COLOR,
    CLICOLOR: process.env.CLICOLOR,
    CLICOLOR_FORCE: process.env.CLICOLOR_FORCE,
    COLORTERM: process.env.COLORTERM,
    TERM: process.env.TERM,
    NODE_DISABLE_COLORS: process.env.NODE_DISABLE_COLORS,
    PY_COLORS: process.env.PY_COLORS,
    CARGO_TERM_COLOR: process.env.CARGO_TERM_COLOR,
    RUST_LOG_STYLE: process.env.RUST_LOG_STYLE,
    YARN_ENABLE_COLORS: process.env.YARN_ENABLE_COLORS,
    NPM_CONFIG_COLOR: process.env.NPM_CONFIG_COLOR,
    NPM_CONFIG_PROGRESS: process.env.NPM_CONFIG_PROGRESS,
    PNPM_CONFIG_COLOR: process.env.PNPM_CONFIG_COLOR,
    npm_config_color: process.env.npm_config_color,
    npm_config_progress: process.env.npm_config_progress,
    pnpm_config_color: process.env.pnpm_config_color,
  };

  process.env.FORCE_COLOR = '3';
  process.env.CLICOLOR = '1';
  process.env.CLICOLOR_FORCE = '1';
  process.env.COLORTERM = 'truecolor';
  process.env.TERM = 'xterm-256color';
  process.env.NODE_DISABLE_COLORS = '0';
  process.env.PY_COLORS = '1';
  process.env.CARGO_TERM_COLOR = 'always';
  process.env.RUST_LOG_STYLE = 'always';
  process.env.YARN_ENABLE_COLORS = '1';
  process.env.NPM_CONFIG_COLOR = 'always';
  process.env.NPM_CONFIG_PROGRESS = 'true';
  process.env.PNPM_CONFIG_COLOR = 'always';
  process.env.npm_config_color = 'always';
  process.env.npm_config_progress = 'true';
  process.env.pnpm_config_color = 'always';

  try {
    const caller = new Team.Member({
      id: 'ops',
      name: 'Ops',
      write_dirs: ['**/*'],
      no_write_dirs: [],
    });
    const dlg = {} as unknown as Dialog;

    const shellOutput = (
      await shellCmdTool.call(dlg, caller, {
        command: `node -e ${JSON.stringify(shellEnvProbeScript)}`,
        timeoutSeconds: 5,
      })
    ).content;
    const snapshot = extractJsonObject(shellOutput);
    assert.equal(snapshot.isTTY, false);
    assert.equal(snapshot.NO_COLOR, '1');
    assert.equal(snapshot.FORCE_COLOR, null);
    assert.equal(snapshot.TERM, 'dumb');
    assert.equal(snapshot.CLICOLOR, '0');
    assert.equal(snapshot.CLICOLOR_FORCE, null);
    assert.equal(snapshot.COLORTERM, null);
    assert.equal(snapshot.NODE_DISABLE_COLORS, '1');
    assert.equal(snapshot.PY_COLORS, '0');
    assert.equal(snapshot.CARGO_TERM_COLOR, 'never');
    assert.equal(snapshot.RUST_LOG_STYLE, 'never');
    assert.equal(snapshot.YARN_ENABLE_COLORS, '0');
    assert.equal(snapshot.NPM_CONFIG_COLOR, 'false');
    assert.equal(snapshot.NPM_CONFIG_PROGRESS, 'false');
    assert.equal(snapshot.PNPM_CONFIG_COLOR, 'false');
    assert.equal(snapshot.npm_config_color, 'false');
    assert.equal(snapshot.npm_config_progress, 'false');
    assert.equal(snapshot.pnpm_config_color, 'false');
    assert.doesNotMatch(shellOutput, ANSI_ESCAPE_RE);

    const readonlyOutput = (
      await readonlyShellTool.call(dlg, caller, {
        command:
          'echo "NO_COLOR=$NO_COLOR FORCE_COLOR=${FORCE_COLOR-unset} TERM=$TERM CLICOLOR=$CLICOLOR CLICOLOR_FORCE=${CLICOLOR_FORCE-unset} COLORTERM=${COLORTERM-unset} NODE_DISABLE_COLORS=$NODE_DISABLE_COLORS PY_COLORS=$PY_COLORS CARGO_TERM_COLOR=$CARGO_TERM_COLOR RUST_LOG_STYLE=$RUST_LOG_STYLE YARN_ENABLE_COLORS=$YARN_ENABLE_COLORS NPM_CONFIG_COLOR=${NPM_CONFIG_COLOR-unset} NPM_CONFIG_PROGRESS=${NPM_CONFIG_PROGRESS-unset} PNPM_CONFIG_COLOR=${PNPM_CONFIG_COLOR-unset} npm_config_color=$npm_config_color npm_config_progress=$npm_config_progress pnpm_config_color=$pnpm_config_color"',
        timeout_ms: 2_000,
      })
    ).content;
    assert.match(readonlyOutput, /NO_COLOR=1/);
    assert.match(readonlyOutput, /FORCE_COLOR=unset/);
    assert.match(readonlyOutput, /TERM=dumb/);
    assert.match(readonlyOutput, /CLICOLOR=0/);
    assert.match(readonlyOutput, /CLICOLOR_FORCE=unset/);
    assert.match(readonlyOutput, /COLORTERM=unset/);
    assert.match(readonlyOutput, /NODE_DISABLE_COLORS=1/);
    assert.match(readonlyOutput, /PY_COLORS=0/);
    assert.match(readonlyOutput, /CARGO_TERM_COLOR=never/);
    assert.match(readonlyOutput, /RUST_LOG_STYLE=never/);
    assert.match(readonlyOutput, /YARN_ENABLE_COLORS=0/);
    assert.match(readonlyOutput, /NPM_CONFIG_COLOR=false/);
    assert.match(readonlyOutput, /NPM_CONFIG_PROGRESS=false/);
    assert.match(readonlyOutput, /PNPM_CONFIG_COLOR=false/);
    assert.match(readonlyOutput, /npm_config_color=false/);
    assert.match(readonlyOutput, /npm_config_progress=false/);
    assert.match(readonlyOutput, /pnpm_config_color=false/);
    assert.doesNotMatch(readonlyOutput, ANSI_ESCAPE_RE);
  } finally {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
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
