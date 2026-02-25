import { execFile } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { promisify } from 'util';

import { parseDomindsAppInstallJson, type DomindsAppInstallJsonV1 } from './app-json';

const execFileAsync = promisify(execFile);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

async function readPackageJson(packageRootAbs: string): Promise<unknown> {
  const raw = await fs.readFile(path.resolve(packageRootAbs, 'package.json'), 'utf-8');
  return JSON.parse(raw) as unknown;
}

async function resolveLocalBinScriptAbs(packageRootAbs: string): Promise<string> {
  const pkg = await readPackageJson(packageRootAbs);
  if (!isRecord(pkg)) throw new Error(`Invalid package.json: expected object (${packageRootAbs})`);
  const bin = pkg['bin'];
  if (typeof bin === 'string') {
    return path.resolve(packageRootAbs, bin);
  }
  if (isRecord(bin)) {
    const entries = Object.entries(bin)
      .filter(([, v]) => typeof v === 'string' && (v as string).trim() !== '')
      .map(([k, v]) => ({ key: k, rel: v as string }));
    if (entries.length === 0)
      throw new Error(`Invalid package.json: bin has no entries (${packageRootAbs})`);
    // Prefer an entry matching package name segment when possible.
    const name = asString(pkg['name']);
    const preferredKey = name ? (name.split('/').pop() ?? name) : null;
    const found = preferredKey ? entries.find((e) => e.key === preferredKey) : undefined;
    return path.resolve(packageRootAbs, (found ?? entries[0]).rel);
  }
  throw new Error(`Invalid package.json: bin must be string|object (${packageRootAbs})`);
}

function parseAppJsonFromStdout(stdout: string, where: string): DomindsAppInstallJsonV1 {
  const trimmed = stdout.trim();
  if (trimmed === '') {
    throw new Error(`App did not print JSON to stdout (${where})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch (err: unknown) {
    throw new Error(
      `Failed to parse app JSON from stdout (${where}): ${err instanceof Error ? err.message : String(err)}\nstdout=${trimmed}`,
    );
  }
  const res = parseDomindsAppInstallJson(parsed);
  if (!res.ok) throw new Error(`Invalid app JSON (${where}): ${res.errorText}`);
  return res.json;
}

export async function runDomindsAppJsonViaNpx(params: {
  spec: string;
  cwdAbs: string;
}): Promise<DomindsAppInstallJsonV1> {
  const { stdout, stderr } = await execFileAsync('npx', ['-y', params.spec, '--json'], {
    cwd: params.cwdAbs,
    env: process.env,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (stderr.trim() !== '') {
    // Loud: stderr indicates non-JSON noise that would break parsing determinism.
    throw new Error(
      `App printed to stderr during --json handshake (spec=${params.spec}):\n${stderr}`,
    );
  }
  return parseAppJsonFromStdout(stdout, `npx ${params.spec} --json`);
}

export async function runDomindsAppJsonViaLocalPackage(params: {
  packageRootAbs: string;
}): Promise<DomindsAppInstallJsonV1> {
  const scriptAbs = await resolveLocalBinScriptAbs(params.packageRootAbs);
  const { stdout, stderr } = await execFileAsync(process.execPath, [scriptAbs, '--json'], {
    cwd: params.packageRootAbs,
    env: process.env,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (stderr.trim() !== '') {
    throw new Error(
      `Local app printed to stderr during --json handshake (path=${params.packageRootAbs}):\n${stderr}`,
    );
  }
  return parseAppJsonFromStdout(stdout, `local ${params.packageRootAbs} --json`);
}
