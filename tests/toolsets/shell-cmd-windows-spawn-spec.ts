#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import {
  detectReadonlyShellForbiddenHiddenDirAccessForTests,
  detectWindowsShellUsageWarningForTests,
  formatShellExecutionErrorForTests,
  resolveReadonlyShellSpawnSpecForTests,
  resolveShellCmdSpawnSpecForTests,
  validateReadonlyShellCommandForTests,
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

const pwshMissingMessage = formatShellExecutionErrorForTests(
  'pwsh',
  'cmd_runner failed to spawn daemon command: missing pid',
  'zh',
  'win32',
);
assert.match(pwshMissingMessage, /指定的 shell 为 pwsh \(PowerShell 7\+\)/);
assert.match(pwshMissingMessage, /系统未找到 pwsh 可执行文件/);
assert.match(pwshMissingMessage, /powershell\.exe 是 Windows PowerShell 5\.1/);
assert.equal(
  formatShellExecutionErrorForTests(
    'powershell.exe',
    'cmd_runner failed to spawn daemon command: missing pid',
    'zh',
    'win32',
  ),
  'cmd_runner failed to spawn daemon command: missing pid',
);

const readonlyShellSpec = resolveReadonlyShellSpawnSpecForTests(command, 'win32');
assert.equal(readonlyShellSpec.command, 'cmd.exe');
assert.deepEqual(readonlyShellSpec.args, ['/d', '/c', command]);
assert.equal(readonlyShellSpec.windowsVerbatimArguments, true);

assert.deepEqual(validateReadonlyShellCommandForTests('DIR .', 'win32'), { ok: true });
assert.deepEqual(validateReadonlyShellCommandForTests('DIR\t.', 'win32'), { ok: true });
assert.deepEqual(validateReadonlyShellCommandForTests('git status\t--porcelain', 'linux'), {
  ok: true,
});
assert.deepEqual(validateReadonlyShellCommandForTests('PY --version', 'win32'), { ok: true });
assert.deepEqual(
  validateReadonlyShellCommandForTests('GIT -C dominds STATUS --porcelain', 'win32'),
  {
    ok: true,
  },
);
assert.equal(validateReadonlyShellCommandForTests('git -C C:tmp status', 'win32').ok, false);
assert.equal(validateReadonlyShellCommandForTests('cd C:tmp && dir .', 'win32').ok, false);
assert.equal(validateReadonlyShellCommandForTests('dir .', 'linux').ok, false);
assert.equal(validateReadonlyShellCommandForTests('type package.json', 'linux').ok, false);
assert.equal(validateReadonlyShellCommandForTests('cat package.json > out.txt', 'win32').ok, false);
assert.equal(validateReadonlyShellCommandForTests('echo $(whoami)', 'linux').ok, false);
assert.equal(
  validateReadonlyShellCommandForTests('awk \'BEGIN{system("pwd")}\'', 'linux').ok,
  false,
);
assert.equal(
  validateReadonlyShellCommandForTests("awk -i inplace '{print}' file.txt", 'linux').ok,
  false,
);
assert.equal(validateReadonlyShellCommandForTests('sed -i s/a/b/ file.txt', 'linux').ok, false);
assert.equal(
  validateReadonlyShellCommandForTests('sed --in-place=.bak s/a/b/ file.txt', 'linux').ok,
  false,
);
assert.equal(
  validateReadonlyShellCommandForTests("sed -n 'w out.txt' file.txt", 'linux').ok,
  false,
);
assert.equal(
  validateReadonlyShellCommandForTests("sed -n 's/a/b/w out.txt' file.txt", 'linux').ok,
  false,
);
assert.equal(validateReadonlyShellCommandForTests('find . -delete', 'linux').ok, false);
assert.equal(validateReadonlyShellCommandForTests('find . -fprint0 out.txt', 'linux').ok, false);
assert.equal(
  validateReadonlyShellCommandForTests('git diff --output=patch.txt', 'linux').ok,
  false,
);
assert.equal(
  validateReadonlyShellCommandForTests('git -C dominds diff --output=patch.txt', 'linux').ok,
  false,
);
assert.equal(validateReadonlyShellCommandForTests('git diff --ext-diff', 'linux').ok, false);
assert.equal(
  validateReadonlyShellCommandForTests('git -c diff.external=cat diff', 'linux').ok,
  false,
);
assert.equal(
  validateReadonlyShellCommandForTests('git -C dominds diff --textconv', 'linux').ok,
  false,
);
assert.equal(validateReadonlyShellCommandForTests('sort -o out.txt in.txt', 'linux').ok, false);
assert.equal(validateReadonlyShellCommandForTests('sort -oout.txt in.txt', 'linux').ok, false);
assert.equal(validateReadonlyShellCommandForTests('rg --pre cat pattern', 'linux').ok, false);
assert.equal(validateReadonlyShellCommandForTests('date -s 2026-01-01', 'linux').ok, false);
assert.equal(validateReadonlyShellCommandForTests('date -s2026-01-01', 'linux').ok, false);
assert.equal(validateReadonlyShellCommandForTests("echo 'safe & still-data'", 'linux').ok, true);
assert.equal(validateReadonlyShellCommandForTests('echo "safe & still-data"', 'win32').ok, true);
assert.equal(validateReadonlyShellCommandForTests('echo %COMSPEC%', 'win32').ok, false);
assert.equal(validateReadonlyShellCommandForTests('echo "%COMSPEC%"', 'win32').ok, false);
assert.equal(validateReadonlyShellCommandForTests('echo "\\%COMSPEC%"', 'win32').ok, false);
assert.equal(
  validateReadonlyShellCommandForTests("echo 'safe & type .MINDS/team.yaml'", 'win32').ok,
  false,
);
assert.equal(
  validateReadonlyShellCommandForTests('echo safe \\& type .MINDS/team.yaml', 'win32').ok,
  false,
);
assert.equal(
  detectReadonlyShellForbiddenHiddenDirAccessForTests(
    '/tmp/rtws',
    'git status -- .MINDS/team.yaml',
    'win32',
  ),
  '.minds',
);
assert.equal(
  detectReadonlyShellForbiddenHiddenDirAccessForTests(
    '/tmp/rtws',
    'git -C child status -- .MINDS/team.yaml',
    'win32',
  ),
  null,
);
assert.equal(
  detectReadonlyShellForbiddenHiddenDirAccessForTests(
    '/tmp/rtws',
    'git diff -- :(glob).MINDS/**',
    'win32',
  ),
  '.minds',
);
assert.equal(
  detectReadonlyShellForbiddenHiddenDirAccessForTests(
    '/tmp/rtws',
    'git diff -- :/.MINDS/team.yaml',
    'win32',
  ),
  '.minds',
);
assert.equal(
  detectReadonlyShellForbiddenHiddenDirAccessForTests(
    '/tmp/rtws',
    'find -L .MINDS -maxdepth 1',
    'win32',
  ),
  '.minds',
);
assert.equal(
  detectReadonlyShellForbiddenHiddenDirAccessForTests(
    '/tmp/rtws',
    'jq -f .MINDS/filter.jq data.json',
    'win32',
  ),
  '.minds',
);
assert.equal(
  detectReadonlyShellForbiddenHiddenDirAccessForTests(
    '/tmp/rtws',
    'jq --slurpfile cfg .MINDS/config.json . data.json',
    'win32',
  ),
  '.minds',
);
assert.equal(
  detectReadonlyShellForbiddenHiddenDirAccessForTests('/tmp/rtws', 'rg --files .MINDS', 'win32'),
  '.minds',
);
assert.equal(
  detectReadonlyShellForbiddenHiddenDirAccessForTests(
    '/tmp/rtws',
    'rg --hidden -g .MINDS/** pattern',
    'win32',
  ),
  '.minds',
);
assert.equal(
  detectReadonlyShellForbiddenHiddenDirAccessForTests(
    '/tmp/rtws',
    'rg --hidden -g.MINDS/** pattern',
    'win32',
  ),
  '.minds',
);
assert.equal(
  detectReadonlyShellForbiddenHiddenDirAccessForTests(
    '/tmp/rtws',
    'rg -f.MINDS/patterns.txt',
    'win32',
  ),
  '.minds',
);
assert.equal(
  detectReadonlyShellForbiddenHiddenDirAccessForTests('/tmp/rtws', 'where /r .MINDS *', 'win32'),
  '.minds',
);
assert.equal(
  detectReadonlyShellForbiddenHiddenDirAccessForTests(
    '/tmp/rtws',
    'findstr /g:.MINDS/patterns.txt data.txt',
    'win32',
  ),
  '.minds',
);
assert.equal(
  detectReadonlyShellForbiddenHiddenDirAccessForTests(
    '/tmp/rtws',
    'findstr /d:.MINDS pattern file.txt',
    'win32',
  ),
  '.minds',
);
assert.equal(
  detectReadonlyShellForbiddenHiddenDirAccessForTests(
    '/tmp/rtws',
    'findstr /d:src;.MINDS pattern file.txt',
    'win32',
  ),
  '.minds',
);
assert.equal(
  detectReadonlyShellForbiddenHiddenDirAccessForTests(
    '/tmp/rtws',
    "awk '{print}' .MINDS/team.yaml",
    'win32',
  ),
  '.minds',
);
assert.equal(
  detectReadonlyShellForbiddenHiddenDirAccessForTests(
    '/tmp/rtws',
    'awk -f .MINDS/script.awk data.txt',
    'win32',
  ),
  '.minds',
);
assert.equal(
  detectReadonlyShellForbiddenHiddenDirAccessForTests(
    '/tmp/rtws',
    'awk -f.MINDS/script.awk data.txt',
    'win32',
  ),
  '.minds',
);
assert.equal(
  detectReadonlyShellForbiddenHiddenDirAccessForTests(
    '/tmp/rtws',
    'cut -f1 .MINDS/team.yaml',
    'win32',
  ),
  '.minds',
);
assert.equal(
  detectReadonlyShellForbiddenHiddenDirAccessForTests(
    '/tmp/rtws',
    'sha256sum .MINDS/team.yaml',
    'win32',
  ),
  '.minds',
);
assert.equal(
  detectReadonlyShellForbiddenHiddenDirAccessForTests(
    '/tmp/rtws',
    'ECHO ok && TYPE .MINDS/team.yaml',
    'win32',
  ),
  '.minds',
);

console.log('OK');
