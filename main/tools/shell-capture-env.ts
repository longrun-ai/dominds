const TERMINAL_COLOR_ENV_KEYS = [
  'FORCE_COLOR',
  'CLICOLOR_FORCE',
  'COLORTERM',
  'TERM_PROGRAM',
  'TERM_PROGRAM_VERSION',
  'WT_SESSION',
  'VTE_VERSION',
  'ANSICON',
  'ConEmuANSI',
] as const;

const TERMINAL_COLOR_ENV_UPPERCASE_KEYS = new Set<string>(
  TERMINAL_COLOR_ENV_KEYS.map((key) => key.toUpperCase()),
);

const CAPTURED_SHELL_ENV_ASSIGNMENTS = {
  NO_COLOR: '1',
  CLICOLOR: '0',
  TERM: 'dumb',
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
} as const;

const CAPTURED_SHELL_ENV_ASSIGNMENT_UPPERCASE_KEYS = new Set<string>(
  Object.keys(CAPTURED_SHELL_ENV_ASSIGNMENTS).map((key) => key.toUpperCase()),
);

export function buildCapturedShellEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source };

  for (const key of Object.keys(env)) {
    const uppercaseKey = key.toUpperCase();
    if (
      TERMINAL_COLOR_ENV_UPPERCASE_KEYS.has(uppercaseKey) ||
      CAPTURED_SHELL_ENV_ASSIGNMENT_UPPERCASE_KEYS.has(uppercaseKey)
    ) {
      delete env[key];
    }
  }

  Object.assign(env, CAPTURED_SHELL_ENV_ASSIGNMENTS);

  return env;
}
