import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, '..');
const distDir = path.join(rootDir, 'dist');

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

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    stdio: 'inherit',
    shell: false,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function runPnpm(args) {
  const commandSpec = buildPnpmCommand(args);
  run(commandSpec.command, commandSpec.args);
}

async function copyTree(source, target) {
  await fs.rm(target, { recursive: true, force: true });
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.cp(source, target, { recursive: true });
}

async function makeExecutableIfSupported(relativePath) {
  if (process.platform === 'win32') {
    return;
  }
  await fs.chmod(path.join(rootDir, relativePath), 0o755);
}

runPnpm(['-C', 'tests', 'run', 'manual-size-guard']);
await fs.rm(distDir, { recursive: true, force: true });
runPnpm(['-r', '--filter', './packages/*', '--filter', './codex-auth', 'run', 'build']);
runPnpm(['exec', 'tsc', '-p', 'main/tsconfig.json', '--rootDir', 'main']);

await fs.mkdir(path.join(distDir, 'llm'), { recursive: true });
await fs.copyFile(
  path.join(rootDir, 'main/llm/defaults.yaml'),
  path.join(distDir, 'llm/defaults.yaml'),
);
await copyTree(path.join(rootDir, 'main/minds/builtin'), path.join(distDir, 'minds/builtin'));
await copyTree(path.join(rootDir, 'main/tools/prompts'), path.join(distDir, 'tools/prompts'));
await copyTree(path.join(rootDir, 'snippets'), path.join(distDir, 'snippets'));
await copyTree(path.join(rootDir, 'docs'), path.join(distDir, 'docs'));

await Promise.all([
  makeExecutableIfSupported('dist/cli.js'),
  makeExecutableIfSupported('dist/cli-runner.js'),
  makeExecutableIfSupported('dist/server-debug.js'),
]);

const cliDir = path.join(distDir, 'cli');
const cliEntries = await fs.readdir(cliDir, { withFileTypes: true });
await Promise.all(
  cliEntries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
    .map((entry) => makeExecutableIfSupported(path.join('dist', 'cli', entry.name))),
);
