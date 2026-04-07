#!/usr/bin/env tsx

import { pathToFileURL } from 'node:url';

import {
  clearInstalledGlobalDialogEventBroadcaster,
  installRecordingGlobalDialogEventBroadcaster,
} from '../main/bootstrap/global-dialog-event-broadcaster';

async function main(): Promise<void> {
  const [scriptAbs, ...scriptArgs] = process.argv.slice(2);
  if (!scriptAbs) {
    throw new Error('tests rtws runner requires a target script path');
  }

  process.argv = [process.argv[0] ?? 'node', scriptAbs, ...scriptArgs];
  installRecordingGlobalDialogEventBroadcaster({
    label: 'tests-rtws-runner',
  });
  process.on('exit', () => {
    clearInstalledGlobalDialogEventBroadcaster();
  });

  await import(pathToFileURL(scriptAbs).href);
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(`tests rtws runner failed:\n${message}`);
  process.exit(1);
});
