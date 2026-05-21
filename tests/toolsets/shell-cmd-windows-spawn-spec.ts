#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import {
  detectWindowsShellUsageWarningForTests,
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
  "if exist 'D:\\AiWorks\\chatgpt-workstation\\dist\\app.exe' echo yes",
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
  'cmd /c "if exist \\"D:\\AiWorks\\chatgpt-workstation\\dist\\app.exe\\" echo yes"',
]);
assert.equal(nestedCmd.windowsVerbatimArguments, true);

const powershellSpec = resolveShellCmdSpawnSpecForTests(
  'powershell -Command "Write-Host test"',
  undefined,
  'win32',
);
assert.equal(powershellSpec.command, 'cmd.exe');
assert.deepEqual(powershellSpec.args, ['/d', '/c', 'powershell -Command "Write-Host test"']);
assert.equal(powershellSpec.windowsVerbatimArguments, true);

const powershellSingleQuotedSpec = resolveShellCmdSpawnSpecForTests(
  "powershell -Command 'Write-Host test'",
  undefined,
  'win32',
);
assert.equal(powershellSingleQuotedSpec.command, 'cmd.exe');
assert.deepEqual(powershellSingleQuotedSpec.args, [
  '/d',
  '/c',
  "powershell -Command 'Write-Host test'",
]);
assert.equal(powershellSingleQuotedSpec.windowsVerbatimArguments, true);

const powershellQuotedSpec = resolveShellCmdSpawnSpecForTests(
  "powershell.exe -Command 'Write-Host test'",
  undefined,
  'win32',
);
assert.equal(powershellQuotedSpec.command, 'cmd.exe');
assert.deepEqual(powershellQuotedSpec.args, [
  '/d',
  '/c',
  "powershell.exe -Command 'Write-Host test'",
]);
assert.equal(powershellQuotedSpec.windowsVerbatimArguments, true);

const powershellSpecExplicit = resolveShellCmdSpawnSpecForTests(command, 'powershell.exe', 'win32');
assert.equal(powershellSpecExplicit.command, 'powershell.exe');
assert.deepEqual(powershellSpecExplicit.args, ['-NoLogo', '-NoProfile', '-Command', command]);

const powershellNativeCommandSpec = resolveShellCmdSpawnSpecForTests(
  'Write-Host test',
  'powershell.exe',
  'win32',
);
assert.equal(powershellNativeCommandSpec.command, 'powershell.exe');
assert.deepEqual(powershellNativeCommandSpec.args, [
  '-NoLogo',
  '-NoProfile',
  '-Command',
  'Write-Host test',
]);

const pwshSpec = resolveShellCmdSpawnSpecForTests(command, 'pwsh', 'win32');
assert.equal(pwshSpec.command, 'pwsh');
assert.deepEqual(pwshSpec.args, ['-NoLogo', '-NoProfile', '-Command', command]);

assert.match(
  detectWindowsShellUsageWarningForTests(
    'cmd /c "if exist D:/AiWorks/chatgpt-workstation/dist/app.exe echo yes"',
    undefined,
    'en',
    'win32',
  ) ?? '',
  /Nested shell syntax detected: cmd \/c/,
);
assert.match(
  detectWindowsShellUsageWarningForTests(
    'powershell -Command "Write-Host test"',
    undefined,
    'en',
    'win32',
  ) ?? '',
  /Nested shell syntax detected: powershell -Command/,
);
assert.match(
  detectWindowsShellUsageWarningForTests(
    "powershell -Command 'Write-Host test'",
    undefined,
    'en',
    'win32',
  ) ?? '',
  /Nested shell syntax detected: powershell -Command/,
);
assert.equal(
  detectWindowsShellUsageWarningForTests(
    'if exist D:/AiWorks/app.exe echo yes',
    undefined,
    'en',
    'win32',
  ),
  undefined,
);

const readonlyShellSpec = resolveReadonlyShellSpawnSpecForTests(command, 'win32');
assert.equal(readonlyShellSpec.command, 'cmd.exe');
assert.deepEqual(readonlyShellSpec.args, ['/d', '/c', command]);
assert.equal(readonlyShellSpec.windowsVerbatimArguments, true);

console.log('OK');
