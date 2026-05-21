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

const explicitCmdSpec = resolveShellCmdSpawnSpecForTests(command, 'cmd.exe', 'win32');
assert.equal(explicitCmdSpec.command, 'cmd.exe');
assert.deepEqual(explicitCmdSpec.args, ['/d', '/c', command]);

const powershellSpec = resolveShellCmdSpawnSpecForTests(command, 'powershell.exe', 'win32');
assert.equal(powershellSpec.command, 'powershell.exe');
assert.deepEqual(powershellSpec.args.slice(0, 3), ['-NoLogo', '-NoProfile', '-EncodedCommand']);
assert.equal(Buffer.from(powershellSpec.args[3] ?? '', 'base64').toString('utf16le'), command);

const pwshSpec = resolveShellCmdSpawnSpecForTests(command, 'pwsh', 'win32');
assert.equal(pwshSpec.command, 'pwsh');
assert.deepEqual(pwshSpec.args.slice(0, 3), ['-NoLogo', '-NoProfile', '-EncodedCommand']);
assert.equal(Buffer.from(pwshSpec.args[3] ?? '', 'base64').toString('utf16le'), command);

const readonlyShellSpec = resolveReadonlyShellSpawnSpecForTests(command, 'win32');
assert.equal(readonlyShellSpec.command, 'cmd.exe');
assert.deepEqual(readonlyShellSpec.args, ['/d', '/c', command]);

console.log('OK');
