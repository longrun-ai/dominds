import { spawnSync } from 'node:child_process';

function buildPnpmCommand(args) {
  if (process.env.npm_execpath) {
    return {
      command: process.execPath,
      args: [process.env.npm_execpath, ...args],
    };
  }
  return {
    command: process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    args,
  };
}

const commandSpec = buildPnpmCommand(process.argv.slice(2));
const result = spawnSync(commandSpec.command, commandSpec.args, {
  stdio: 'inherit',
  shell: false,
});

if (result.error) {
  throw result.error;
}
process.exit(result.status ?? 1);
