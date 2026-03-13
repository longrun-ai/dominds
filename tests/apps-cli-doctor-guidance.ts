import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

async function writeText(filePathAbs: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePathAbs), { recursive: true });
  await fs.writeFile(filePathAbs, content, 'utf-8');
}

async function runNode(params: {
  cwd: string;
  args: ReadonlyArray<string>;
}): Promise<Readonly<{ exitCode: number; stdout: string; stderr: string }>> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, params.args, {
      cwd: params.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (exitCode) => {
      resolve({ exitCode: exitCode ?? -1, stdout, stderr });
    });
  });
}

async function main(): Promise<void> {
  const repoRoot = path.resolve(__dirname, '..');
  const cliEntry = path.join(repoRoot, 'main', 'cli.ts');
  const tsxCli = path.join(__dirname, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-apps-cli-doctor-guidance-'));

  try {
    await writeText(
      path.join(tmpRoot, '.minds', 'app.yaml'),
      ['apiVersion: dominds.io/v1alpha1', 'kind: DomindsApp', 'id: rtws_root', ''].join('\n'),
    );

    const help = await runNode({
      cwd: repoRoot,
      args: [tsxCli, cliEntry, 'help'],
    });
    assert.equal(help.exitCode, 0, `expected help exit 0, got ${help.exitCode}: ${help.stderr}`);
    assert.match(
      help.stdout,
      /doctor \[options\]\s+Read-only diagnosis across manifest\/lock\/configuration\/resolution\/handshake/,
    );
    assert.match(help.stdout, /dominds doctor @longrun-ai\/web-dev/);

    const unknownAppId = '@longrun-ai/missing-app';
    const update = await runNode({
      cwd: tmpRoot,
      args: [tsxCli, cliEntry, 'update', unknownAppId],
    });
    assert.equal(update.exitCode, 1, `expected update exit 1, got ${update.exitCode}`);
    assert.match(
      update.stderr,
      new RegExp(`dominds doctor ${unknownAppId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    );
    assert.match(update.stderr, /Diagnosis first:/);
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
