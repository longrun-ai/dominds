#!/usr/bin/env node

/**
 * Create/new subcommand for dominds CLI
 *
 * Usage:
 *   dominds create <template> [directory] [--repo-url <url>]
 *   dominds new <template> [directory]    [--repo-url <url>]   # alias for create
 *
 * Notes:
 * - Template can be a short name (resolved via DOMINDS_TEMPLATE_BASE) or a git URL.
 * - rtws directory is `process.cwd()`. Use 'dominds -C <dir> create ...' to create under another base dir.
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

function getPackageVersion(): string {
  try {
    const packagePath = path.join(__dirname, '../package.json');
    const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as { version?: unknown };
    return typeof packageJson.version === 'string' && packageJson.version.trim()
      ? packageJson.version
      : 'unknown';
  } catch {
    return 'unknown';
  }
}

type TemplateSpec =
  | { kind: 'short-name'; name: string }
  | { kind: 'git-url'; url: string }
  | { kind: 'local-path'; absPath: string };

function looksLikeGitUrl(s: string): boolean {
  if (s.includes('://')) return true;
  if (s.startsWith('git@')) return true;
  // scp-like syntax: user@host:org/repo(.git)
  if (/^[a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+:/.test(s)) return true;
  return false;
}

function parseTemplateSpec(template: string, cwd: string): TemplateSpec {
  const trimmed = template.trim();
  if (!trimmed) {
    return { kind: 'short-name', name: '' };
  }

  if (looksLikeGitUrl(trimmed)) {
    return { kind: 'git-url', url: trimmed };
  }

  // Treat existing paths as local templates.
  const absCandidate = path.isAbsolute(trimmed) ? trimmed : path.resolve(cwd, trimmed);
  if (fs.existsSync(absCandidate)) {
    return { kind: 'local-path', absPath: absCandidate };
  }

  return { kind: 'short-name', name: trimmed };
}

function resolveTemplateRepoUrl(spec: TemplateSpec, env: NodeJS.ProcessEnv): string {
  switch (spec.kind) {
    case 'git-url':
      return spec.url;
    case 'local-path':
      return spec.absPath;
    case 'short-name': {
      const rawBase = env.DOMINDS_TEMPLATE_BASE;
      const base =
        typeof rawBase === 'string' && rawBase.trim() ? rawBase.trim().replace(/\/+$/g, '') : '';
      const baseOrDefault = base || 'https://github.com/longrun-ai';
      const name = spec.name.endsWith('.git') ? spec.name.slice(0, -'.git'.length) : spec.name;
      return `${baseOrDefault}/${name}.git`;
    }
    default: {
      const _exhaustive: never = spec;
      return _exhaustive;
    }
  }
}

function deriveTargetDirName(template: string): string {
  const trimmed = template.trim().replace(/\/+$/g, '');
  if (!trimmed) return 'dominds-rtws';

  // URL-like cases
  const lastSlash = trimmed.lastIndexOf('/');
  const lastColon = trimmed.lastIndexOf(':');
  const lastSep = Math.max(lastSlash, lastColon);
  const tail = lastSep >= 0 ? trimmed.slice(lastSep + 1) : trimmed;
  const withoutGit = tail.endsWith('.git') ? tail.slice(0, -'.git'.length) : tail;
  return withoutGit || 'dominds-rtws';
}

type ParsedArgs =
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'run'; template: string; directory?: string; repoUrl?: string };

function parseArgs(argv: ReadonlyArray<string>): ParsedArgs {
  let template: string | undefined;
  let directory: string | undefined;
  let repoUrl: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      return { kind: 'help' };
    }
    if (a === '--version' || a === '-v') {
      return { kind: 'version' };
    }
    if (a === '--repo-url') {
      const next = argv[i + 1];
      if (next == null || next.trim() === '') {
        throw new Error('--repo-url requires a value');
      }
      repoUrl = next;
      i++;
      continue;
    }
    if (a.startsWith('-')) {
      throw new Error(`Unknown option: ${a}`);
    }

    if (!template) {
      template = a;
      continue;
    }
    if (!directory) {
      directory = a;
      continue;
    }
    throw new Error(`Unexpected argument: ${a}`);
  }

  if (!template || template.trim() === '') {
    return { kind: 'help' };
  }

  return { kind: 'run', template, directory, repoUrl };
}

function printHelp(): void {
  console.log(`dominds v${getPackageVersion()}`);
  console.log('');
  console.log('Usage:');
  console.log('  dominds create <template> [directory] [--repo-url <url>]');
  console.log('  dominds new <template> [directory]    [--repo-url <url>]   # alias for create');
  console.log('');
  console.log(
    'Create a new dominds-powered rtws (runtime workspace) by cloning a template repository.',
  );
  console.log('');
  console.log('Template resolution:');
  console.log('  - If <template> looks like a git URL, it is used as-is.');
  console.log('  - Otherwise it resolves to: ${DOMINDS_TEMPLATE_BASE}/<template>.git');
  console.log('  - Default DOMINDS_TEMPLATE_BASE = https://github.com/longrun-ai');
  console.log('');
  console.log('Options:');
  console.log(
    '  --repo-url <url>     After cloning, set git origin to this URL (and keep template as remote).',
  );
  console.log('  -h, --help           Show this help message');
  console.log('  -v, --version        Show version information');
  console.log('');
  console.log('Examples:');
  console.log('  dominds create web-scaffold my-project');
  console.log(
    '  DOMINDS_TEMPLATE_BASE=https://github.com/myorg dominds create web-scaffold my-project',
  );
  console.log('  dominds create https://github.com/myorg/custom-template.git my-project');
  console.log(
    '  dominds create web-scaffold my-project --repo-url git@github.com:myorg/my-project.git',
  );
}

type SpawnOk = { kind: 'ok' };
type SpawnErr = { kind: 'error'; cmd: string; code: number | null; signal: NodeJS.Signals | null };
type SpawnResult = SpawnOk | SpawnErr;

async function run(cmd: string, args: ReadonlyArray<string>, cwd: string): Promise<SpawnResult> {
  const child = spawn(cmd, [...args], { cwd, stdio: 'inherit' });
  return await new Promise<SpawnResult>((resolve, reject) => {
    child.on('error', (err) => reject(err));
    child.on('close', (code, signal) => {
      if (code === 0) {
        resolve({ kind: 'ok' });
        return;
      }
      resolve({ kind: 'error', cmd: `${cmd} ${args.join(' ')}`, code, signal });
    });
  });
}

async function runGit(args: ReadonlyArray<string>, cwd: string): Promise<void> {
  const res = await run('git', args, cwd);
  if (res.kind === 'ok') return;
  const detail = res.signal ? `signal ${res.signal}` : `exit code ${String(res.code)}`;
  throw new Error(`git failed (${detail}): ${res.cmd}`);
}

async function main(): Promise<void> {
  try {
    const parsed = parseArgs(process.argv.slice(2));
    switch (parsed.kind) {
      case 'help':
        printHelp();
        return;
      case 'version':
        console.log(`dominds v${getPackageVersion()}`);
        return;
      case 'run': {
        const cwd = process.cwd();
        const spec = parseTemplateSpec(parsed.template, cwd);
        const templateRepoUrl = resolveTemplateRepoUrl(spec, process.env);

        const targetName = parsed.directory
          ? parsed.directory
          : deriveTargetDirName(parsed.template);
        const targetAbs = path.resolve(cwd, targetName);

        if (fs.existsSync(targetAbs)) {
          throw new Error(`Target directory already exists: ${targetAbs}`);
        }
        fs.mkdirSync(path.dirname(targetAbs), { recursive: true });

        console.log(`Creating rtws: ${targetAbs}`);
        console.log(`Template: ${templateRepoUrl}`);

        await runGit(['clone', '--depth', '1', templateRepoUrl, targetAbs], cwd);

        if (parsed.repoUrl) {
          // Keep the template remote for future pulls/inspection.
          try {
            await runGit(['-C', targetAbs, 'remote', 'add', 'template', templateRepoUrl], cwd);
          } catch {
            await runGit(['-C', targetAbs, 'remote', 'set-url', 'template', templateRepoUrl], cwd);
          }
          await runGit(['-C', targetAbs, 'remote', 'set-url', 'origin', parsed.repoUrl], cwd);
          console.log(`Set git origin to: ${parsed.repoUrl}`);
        }

        const mindsDir = path.join(targetAbs, '.minds');
        if (!fs.existsSync(mindsDir)) {
          console.warn(`Warning: template does not contain '.minds/' (${mindsDir})`);
        }

        console.log('Done.');
        return;
      }
      default: {
        const _exhaustive: never = parsed;
        return _exhaustive;
      }
    }
  } catch (err) {
    console.error('Error:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

export { main };

if (require.main === module) {
  main().catch((err) => {
    console.error('Unhandled error:', err);
    process.exit(1);
  });
}
