import { spawn } from 'child_process';
import path from 'path';

type CmdResult =
  | Readonly<{ kind: 'ok'; stdout: string }>
  | Readonly<{ kind: 'error'; errorText: string; stdout: string; stderr: string }>;

function getNpxBin(): string {
  return process.platform === 'win32' ? 'npx.cmd' : 'npx';
}

async function runCapture(cmd: string, args: readonly string[]): Promise<CmdResult> {
  return await new Promise((resolve) => {
    const p = spawn(cmd, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    p.stdout.on('data', (b: Buffer) => stdoutChunks.push(b));
    p.stderr.on('data', (b: Buffer) => stderrChunks.push(b));
    p.on('close', (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
      const stderr = Buffer.concat(stderrChunks).toString('utf-8');
      if (code === 0) {
        resolve({ kind: 'ok', stdout });
        return;
      }
      resolve({
        kind: 'error',
        errorText: `Command failed (exit=${code ?? 'unknown'}): ${cmd} ${args.join(' ')}`,
        stdout,
        stderr,
      });
    });
    p.on('error', (err) => {
      resolve({
        kind: 'error',
        errorText: `Failed to spawn '${cmd}': ${err instanceof Error ? err.message : String(err)}`,
        stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
        stderr: Buffer.concat(stderrChunks).toString('utf-8'),
      });
    });
  });
}

export function inferNpmPackageNameFromSpec(spec: string): string | null {
  const s = spec.trim();
  if (s === '') return null;
  if (s.includes('://')) return null;
  if (s.startsWith('git+')) return null;
  if (s.includes(' ')) return null;

  // Reject paths/URLs (for now).
  if (s.includes('/') && !s.startsWith('@')) return null;

  if (s.startsWith('@')) {
    // @scope/name or @scope/name@version
    const slash = s.indexOf('/');
    if (slash <= 1) return null;
    const at = s.lastIndexOf('@');
    if (at > 0 && at > slash) {
      return s.slice(0, at);
    }
    return s;
  }

  const at = s.lastIndexOf('@');
  if (at > 0) {
    return s.slice(0, at);
  }
  return s;
}

export async function resolveNpxPackageRoot(params: {
  spec: string;
}): Promise<
  | Readonly<{ kind: 'ok'; packageName: string; packageRootAbs: string }>
  | Readonly<{ kind: 'error'; errorText: string }>
> {
  const packageName = inferNpmPackageNameFromSpec(params.spec);
  if (!packageName) {
    return {
      kind: 'error',
      errorText:
        `Unsupported npx spec: '${params.spec}'. ` +
        `For now only npm package specs are supported (e.g. 'name', 'name@1.2.3', '@scope/name@1.2.3'). ` +
        `Use 'dominds install --local <path>' for local development packages.`,
    };
  }

  const script = [
    "const path=require('path');",
    `const p=require.resolve(${JSON.stringify(`${packageName}/package.json`)});`,
    'console.log(path.dirname(p));',
  ].join('');

  const result = await runCapture(getNpxBin(), ['-y', '-p', params.spec, 'node', '-e', script]);
  if (result.kind === 'error') {
    const detail = [result.errorText, result.stderr.trim(), result.stdout.trim()]
      .filter((s) => s !== '')
      .join('\n');
    return { kind: 'error', errorText: detail };
  }

  const out = result.stdout.trim();
  if (out === '') {
    return { kind: 'error', errorText: `npx returned empty output for spec '${params.spec}'` };
  }
  const packageRootAbs = path.resolve(out);
  return { kind: 'ok', packageName, packageRootAbs };
}
