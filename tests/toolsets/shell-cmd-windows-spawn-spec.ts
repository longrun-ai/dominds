#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import {
  resolveReadonlyShellSpawnSpecForTests,
  resolveShellCmdSpawnSpecForTests,
} from '../../main/tools/os';

const command = 'Test-Path D:/AiWorks/chatgpt-workstation/dist/app.exe';

const cmdSpec = resolveShellCmdSpawnSpecForTests(command, undefined, 'win32');
assert.equal(cmdSpec.command, 'cmd.exe');
assert.deepEqual(cmdSpec.args, ['/d', '/c', command]);
assert.equal(cmdSpec.windowsVerbatimArguments, true);

const explicitCmdSpec = resolveShellCmdSpawnSpecForTests(command, 'cmd.exe', 'win32');
assert.equal(explicitCmdSpec.command, 'cmd.exe');
assert.deepEqual(explicitCmdSpec.args, ['/d', '/c', command]);
assert.equal(explicitCmdSpec.windowsVerbatimArguments, true);

const quotedPath = resolveShellCmdSpawnSpecForTests(
  'if exist "D:\\AiWorks\\chatgpt-workstation\\dist\\app.exe" echo yes',
  undefined,
  'win32',
);
assert.equal(quotedPath.command, 'cmd.exe');
assert.deepEqual(quotedPath.args, [
  '/d',
  '/c',
  'if exist "D:\\AiWorks\\chatgpt-workstation\\dist\\app.exe" echo yes',
]);
assert.equal(quotedPath.windowsVerbatimArguments, true);

const quotedIfExist = resolveShellCmdSpawnSpecForTests(
  "if exist 'D:\\AiWorks\\chatgpt-workstation\\dist\\app.exe' echo yes",
  undefined,
  'win32',
);
assert.equal(quotedIfExist.command, 'cmd.exe');
assert.deepEqual(quotedIfExist.args, [
  '/d',
  '/c',
  'if exist "D:\\AiWorks\\chatgpt-workstation\\dist\\app.exe" echo yes',
]);
assert.equal(quotedIfExist.windowsVerbatimArguments, true);

const nestedCmd = resolveShellCmdSpawnSpecForTests(
  'cmd /c "if exist \\"D:\\AiWorks\\chatgpt-workstation\\dist\\app.exe\\" echo yes"',
  undefined,
  'win32',
);
assert.equal(nestedCmd.command, 'cmd.exe');
assert.deepEqual(nestedCmd.args, [
  '/d',
  '/c',
  'if exist "D:\\AiWorks\\chatgpt-workstation\\dist\\app.exe" echo yes',
]);
assert.equal(nestedCmd.windowsVerbatimArguments, true);

const powershellSpec = resolveShellCmdSpawnSpecForTests(
  'powershell -Command "Write-Host test"',
  undefined,
  'win32',
);
assert.equal(powershellSpec.command, 'powershell');
assert.deepEqual(powershellSpec.args.slice(0, 3), ['-NoLogo', '-NoProfile', '-EncodedCommand']);
assert.equal(
  Buffer.from(powershellSpec.args[3] ?? '', 'base64').toString('utf16le'),
  'Write-Host test',
);

const powershellQuotedSpec = resolveShellCmdSpawnSpecForTests(
  "powershell.exe -Command 'Write-Host test'",
  undefined,
  'win32',
);
assert.equal(powershellQuotedSpec.command, 'powershell.exe');
assert.deepEqual(powershellQuotedSpec.args.slice(0, 3), [
  '-NoLogo',
  '-NoProfile',
  '-EncodedCommand',
]);
assert.equal(
  Buffer.from(powershellQuotedSpec.args[3] ?? '', 'base64').toString('utf16le'),
  'Write-Host test',
);

const powershellSpecExplicit = resolveShellCmdSpawnSpecForTests(command, 'powershell.exe', 'win32');
assert.equal(powershellSpecExplicit.command, 'powershell.exe');
assert.deepEqual(powershellSpecExplicit.args.slice(0, 3), [
  '-NoLogo',
  '-NoProfile',
  '-EncodedCommand',
]);
assert.equal(
  Buffer.from(powershellSpecExplicit.args[3] ?? '', 'base64').toString('utf16le'),
  command,
);

const pwshSpec = resolveShellCmdSpawnSpecForTests(command, 'pwsh', 'win32');
assert.equal(pwshSpec.command, 'pwsh');
assert.deepEqual(pwshSpec.args.slice(0, 3), ['-NoLogo', '-NoProfile', '-EncodedCommand']);
assert.equal(Buffer.from(pwshSpec.args[3] ?? '', 'base64').toString('utf16le'), command);

const readonlyShellSpec = resolveReadonlyShellSpawnSpecForTests(command, 'win32');
assert.equal(readonlyShellSpec.command, 'cmd.exe');
assert.deepEqual(readonlyShellSpec.args, ['/d', '/c', command]);
assert.equal(readonlyShellSpec.windowsVerbatimArguments, true);

console.log('OK');
