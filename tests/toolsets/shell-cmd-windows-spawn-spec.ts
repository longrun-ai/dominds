#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import {
  detectReadonlyShellForbiddenHiddenDirAccessForTests,
  detectWindowsShellUsageWarningForTests,
  formatShellExecutionErrorForTests,
  readonlyShellTool,
  resolveReadonlyShellSpawnSpecForTests,
  resolveShellCmdSpawnSpecForTests,
  validateReadonlyShellCommandForTests,
} from '../../main/tools/os';
import { semanticEvidenceCollector } from '../helpers/semantic-evidence';

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

// Supplied command/argv/platform decisions above and below are machine contracts.
// Warning and error meaning is reviewed from the complete actual formatter output.
const evidence = semanticEvidenceCollector('dominds-shell-windows-guidance-');
for (const language of ['en', 'zh'] as const) {
  for (const [id, input] of [
    ['nested-cmd', 'cmd /c "if exist D:/AiWorks/chatgpt-workstation/dist/app.exe echo yes"'],
    ['nested-powershell-double', 'powershell -Command "Write-Host test"'],
    ['nested-powershell-single', "powershell -Command 'Write-Host test'"],
  ]) {
    const warning = detectWindowsShellUsageWarningForTests(input!, undefined, language, 'win32');
    assert.equal(typeof warning, 'string');
    evidence.record({
      id: id + '-' + language,
      scenario:
        'A supplied Windows command explicitly nests another shell under the default cmd.exe.',
      businessValue:
        'An agent can avoid accidental quoting layers while selecting the intended shell.',
      context: {
        language,
        command: input!,
        selectedShell: 'default cmd.exe',
        platformInput: 'win32',
        scope:
          'Actual pure formatter with supplied platform; no native Windows process was executed.',
      },
      reviewQuestions: [
        'Does the actual warning accurately explain the nested-shell choice and give usable guidance?',
      ],
      actualText: warning!,
    });
  }
  assert.equal(
    detectWindowsShellUsageWarningForTests(
      'if exist D:/AiWorks/app.exe echo yes',
      undefined,
      language,
      'win32',
    ),
    undefined,
  );
  for (const [id, rawError] of [
    ['missing-pid', 'cmd_runner failed to spawn daemon command: missing pid'],
    ['enoent', 'spawn pwsh ENOENT'],
  ]) {
    const actualText = formatShellExecutionErrorForTests('pwsh', rawError!, language, 'win32');
    evidence.record({
      id: 'pwsh-' + id + '-' + language,
      scenario: 'The selected pwsh shell failed to start; only the supplied raw error is known.',
      businessValue:
        'An agent can investigate the actual spawn failure without an invented causal diagnosis.',
      context: {
        language,
        selectedShell: 'pwsh',
        platformInput: 'win32',
        rawError: rawError!,
        installationState: 'Unknown; no executable lookup or PowerShell process was attempted.',
        scope: 'Actual error formatter; no Windows host, native shell or installation detection.',
      },
      reviewQuestions: [
        'Does the diagnostic preserve the observed failure, distinguish pwsh from powershell.exe where useful, and avoid claiming an unverified installation cause?',
      ],
      actualText,
    });
  }
  for (const [id, readonlyCommand] of [
    ['cmd', 'cmd /c "echo readonly-data-7c31"'],
    ['powershell', 'powershell -Command "Write-Host readonly-data-7c31"'],
  ]) {
    const warning = detectWindowsShellUsageWarningForTests(
      readonlyCommand!,
      undefined,
      language,
      'win32',
    );
    const validation = validateReadonlyShellCommandForTests(readonlyCommand!, 'win32');
    assert.equal(typeof warning, 'string');
    assert.equal(validation.ok, false);
    evidence.record({
      id: 'readonly-nested-' + id + '-' + language,
      scenario:
        'A readonly_shell caller submits a nested shell prefix; its actual Windows validator refuses it.',
      businessValue:
        'Recovery advice must respect the capabilities of the tool that the agent actually has.',
      context: {
        language,
        tool: 'readonly_shell',
        command: readonlyCommand!,
        platformInput: 'win32',
        actualToolSchema: JSON.stringify(readonlyShellTool.parameters),
        selectedShell: 'Fixed cmd.exe; readonly_shell has no shell argument.',
        scope:
          'Actual shared warning formatter, public tool schema and Windows validation component; no native Windows process or full tool invocation.',
      },
      reviewQuestions: [
        'Given the actual schema and refusal, is the warning executable advice for a readonly_shell caller, without proposing an unsupported shell argument or a refused nested prefix?',
      ],
      actualText: JSON.stringify({ warning, validation }, null, 2),
    });
  }
  const raw = 'cmd_runner failed to spawn daemon command: missing pid';
  assert.equal(formatShellExecutionErrorForTests('powershell.exe', raw, language, 'win32'), raw);
}

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

void evidence
  .write()
  .then(() =>
    console.log(
      'Windows spawn/policy component contracts: PASS; native Windows execution unexecuted.',
    ),
  )
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
