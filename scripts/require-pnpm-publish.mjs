import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

function readCurrentPackageName() {
  const packageJsonAbs = path.join(process.cwd(), 'package.json');
  const packageJson = JSON.parse(readFileSync(packageJsonAbs, 'utf8'));
  if (typeof packageJson.name !== 'string') {
    throw new Error(`Current package.json must declare a string name: ${packageJsonAbs}`);
  }
  return packageJson.name;
}

function findWorkspaceRoot(startAbs) {
  let currentAbs = startAbs;
  while (true) {
    if (existsSync(path.join(currentAbs, 'pnpm-workspace.yaml'))) {
      return currentAbs;
    }
    const parentAbs = path.dirname(currentAbs);
    if (parentAbs === currentAbs) {
      throw new Error(`Could not find pnpm-workspace.yaml above ${startAbs}.`);
    }
    currentAbs = parentAbs;
  }
}

function buildSuggestedCommand() {
  const workspaceRootAbs = findWorkspaceRoot(process.cwd());
  return `pnpm -C ${workspaceRootAbs} run release:publish-public`;
}

function requirePnpmPublish(packageName) {
  const userAgent = process.env.npm_config_user_agent ?? '';
  const fromManagedFlow = process.env.DOMINDS_PUBLIC_PUBLISH_FLOW === '1';
  const suggestedCommand = buildSuggestedCommand();
  if (userAgent.includes('pnpm/')) {
    if (fromManagedFlow) {
      return;
    }
    throw new Error(
      `Publishing ${packageName} must go through the managed public release flow.\n` +
        `Use: ${suggestedCommand}\n` +
        `Preview only: ${suggestedCommand}:dry-run`,
    );
  }
  throw new Error(
    `Publishing ${packageName} must use the managed pnpm release flow, not npm publish.\n` +
      `Use: ${suggestedCommand}\n` +
      `Preview only: ${suggestedCommand}:dry-run`,
  );
}

requirePnpmPublish(readCurrentPackageName());
