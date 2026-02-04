import { RootDialog } from './dialog';
import type { ChatMessage } from './llm/client';
import { driveDialogStream, emitSayingEvents } from './llm/driver';
import { log } from './log';
import { DialogPersistence } from './persistence';
import { getWorkLanguage } from './shared/runtime-language';
import type { LanguageCode } from './shared/types/language';
import { generateShortId } from './shared/utils/id';
import { formatAssignmentFromSupdialog } from './shared/utils/inter-dialog-format';
import { formatUnifiedTimestamp } from './shared/utils/time';
import { Team } from './team';

type ShowingByDoingCacheEntry = Readonly<{
  createdAt: string;
  workLanguage: LanguageCode;
  shell:
    | Readonly<{
        kind: 'specialist_tellask';
        specialistId: string;
        tellaskBody: string;
        responseText: string;
        snapshotText: string;
      }>
    | Readonly<{
        kind: 'direct_shell';
        directNoteMarkdown: string;
        snapshotText: string;
      }>;
  fbr: Readonly<{
    tellaskHead: string;
    tellaskBody: string;
    responderAgentId: string;
    responseText: string;
  }>;
  quickstartNote: string;
}>;

const cacheByTellaskerAgentId: Map<string, ShowingByDoingCacheEntry> = new Map();
const inflightByTellaskerAgentId: Map<string, Promise<ShowingByDoingCacheEntry>> = new Map();

export function scheduleShowingByDoingForNewDialog(
  dlg: RootDialog,
  options: { skipShowingByDoing: boolean },
): void {
  if (options.skipShowingByDoing) return;

  const tellaskerAgentId = dlg.agentId;
  const existing = cacheByTellaskerAgentId.get(tellaskerAgentId);
  if (existing) {
    dlg.setCoursePrefixMsgs(buildCoursePrefixMsgs(existing));
    void replayShowingByDoing(dlg, existing);
    return;
  }

  const inflight = inflightByTellaskerAgentId.get(tellaskerAgentId);
  if (inflight) {
    void inflight.then((entry) => replayShowingByDoing(dlg, entry));
    return;
  }

  const task = runShowingByDoingLive(dlg)
    .then((entry) => {
      cacheByTellaskerAgentId.set(tellaskerAgentId, entry);
      return entry;
    })
    .catch((err: unknown) => {
      log.warn('Showing-by-Doing live run failed; will retry on next dialog', err, {
        agentId: tellaskerAgentId,
      });
      throw err;
    })
    .finally(() => {
      inflightByTellaskerAgentId.delete(tellaskerAgentId);
    });
  inflightByTellaskerAgentId.set(tellaskerAgentId, task);
  void task;
}

function prefixTellaskBodyLines(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  return lines.map((line) => `!? ${line}`).join('\n');
}

function takeFirstNonEmptyLine(text: string): string | null {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function extractLastAssistantSaying(messages: Array<{ type: string; content?: string }>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.type === 'saying_msg' && typeof msg.content === 'string' && msg.content.trim()) {
      return msg.content;
    }
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.type === 'thinking_msg' && typeof msg.content === 'string' && msg.content.trim()) {
      return msg.content;
    }
  }
  return '';
}

function extractLastShellCmdResultText(messages: unknown[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (typeof msg !== 'object' || msg === null) continue;
    if (!('type' in msg) || !('name' in msg) || !('content' in msg)) continue;
    const type = (msg as { type: unknown }).type;
    const name = (msg as { name: unknown }).name;
    const content = (msg as { content: unknown }).content;
    if (type !== 'func_result_msg') continue;
    if (name !== 'shell_cmd') continue;
    if (typeof content !== 'string') continue;
    if (!content.trim()) continue;
    return content;
  }
  return null;
}

async function runUnameA(): Promise<string> {
  const { spawn } = await import('child_process');
  return await new Promise<string>((resolveUname) => {
    const child = spawn('uname', ['-a'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (buf: Buffer) => {
      out += buf.toString();
    });
    child.stderr.on('data', (buf: Buffer) => {
      err += buf.toString();
    });
    child.on('close', (code) => {
      const trimmedOut = out.trim();
      const trimmedErr = err.trim();
      if (code === 0 && trimmedOut) {
        resolveUname(trimmedOut);
        return;
      }
      const fallback = trimmedErr ? trimmedErr : `uname exited with code ${String(code)}`;
      resolveUname(fallback);
    });
    child.on('error', (e) => {
      resolveUname(e instanceof Error ? e.message : String(e));
    });
  });
}

function formatPreludeIntro(language: LanguageCode, reused: boolean): string {
  if (language === 'zh') {
    return reused
      ? [
          '## Prelude：做给祂看（复用缓存）',
          '',
          '这段序幕用于把“诉请 + 回传 + FBR”变成体感。',
          '本次对话复用了本进程内缓存：未重复执行命令。',
          '',
        ].join('\n')
      : [
          '## Prelude：做给祂看',
          '',
          '这段序幕用于把“诉请 + 回传 + FBR”变成体感。',
          '默认只执行一个低风险命令：`uname -a`。',
          '',
        ].join('\n');
  }
  return reused
    ? [
        '## Prelude: Showing-by-Doing (Reused)',
        '',
        'This prelude makes Tellask + return + FBR feel real.',
        'This dialog reused the in-process cache (no commands were re-run).',
        '',
      ].join('\n')
    : [
        '## Prelude: Showing-by-Doing',
        '',
        'This prelude makes Tellask + return + FBR feel real.',
        'It runs a single low-risk command: `uname -a`.',
        '',
      ].join('\n');
}

function formatShellTellaskBody(language: LanguageCode): string {
  if (language === 'zh') {
    return [
      '请执行 `uname -a` 获取当前运行环境的基本信息。',
      '',
      '要求：',
      '- 通过 shell 工具执行：uname -a',
      '- 原样返回输出（不要改写/解释）',
      '- 若命令不可用/失败：返回错误信息，并给出一个安全的替代命令',
      '',
      '输出格式：优先只给出原始输出，其次才是必要的简短说明。',
    ].join('\n');
  }
  return [
    'Please run `uname -a` to capture the basic runtime environment.',
    '',
    'Requirements:',
    '- Use shell tools to run exactly: uname -a',
    '- Return the raw output verbatim (no paraphrase)',
    '- If the command fails: include the error and suggest one safe alternative command',
    '',
    'Output format: prefer raw output only; keep any explanation minimal.',
  ].join('\n');
}

function formatFbrTellaskBody(language: LanguageCode, snapshotText: string): string {
  if (language === 'zh') {
    return [
      '你正在进行一次“扪心自问”（FBR）。你**没有任何工具**，不能调用工具、不能诉请队友，只能使用本文本推理。',
      '',
      '请基于下面环境信息回答：',
      '- 在这个环境里要注意些什么？',
      '- 优先利用哪些命令行工具，为什么？',
      '',
      '环境信息：',
      snapshotText,
    ].join('\n');
  }
  return [
    'You are doing Fresh Boots Reasoning (FBR). You have **no tools**: do not call tools, do not Tellask anyone.',
    '',
    'Based on the environment info below, answer:',
    '- What should we watch out for in this environment?',
    '- Which CLI tools should we prioritize, and why?',
    '',
    'Environment info:',
    snapshotText,
  ].join('\n');
}

function formatQuickstartNote(
  language: LanguageCode,
  unameLine: string | null,
  fbrResponse: string,
): string {
  const header =
    language === 'zh' ? '## 环境速记（Environment Quickstart）' : '## Environment Quickstart';
  const unameSectionLabel = language === 'zh' ? 'uname -a（摘要）' : '`uname -a` (summary)';
  const fbrLabel = language === 'zh' ? 'FBR 要点（摘要）' : 'FBR highlights (summary)';
  const unameBlock = unameLine
    ? ['```console', unameLine, '```'].join('\n')
    : language === 'zh'
      ? '_（未能提取单行摘要；详见上文输出）_'
      : '_(Failed to extract a single-line summary; see output above.)_';

  const fbrLines = fbrResponse.replace(/\r\n/g, '\n').split('\n');
  const fbrPreview = fbrLines.slice(0, 24).join('\n').trim();

  return [
    header,
    '',
    `${unameSectionLabel}:`,
    unameBlock,
    '',
    `${fbrLabel}:`,
    fbrPreview ? fbrPreview : language === 'zh' ? '_（无）_' : '_(empty)_',
    '',
  ].join('\n');
}

function buildCoursePrefixMsgs(entry: ShowingByDoingCacheEntry): ChatMessage[] {
  const language = entry.workLanguage;
  const header =
    language === 'zh'
      ? 'Prelude（做给祂看）上下文：本进程在对话创建时已真实跑通一次“诉请 + 回传 + `!?@self` FBR”。以下为压缩转录，作为每一程对话的开头上下文注入。'
      : 'Prelude (Showing-by-Doing) context: this process already ran a real Tellask + return + `!?@self` FBR at dialog creation. The condensed transcript below is injected at the start of each course.';

  const shellSnapshotLabel =
    language === 'zh'
      ? 'Shell 环境快照（来自 `uname -a`）'
      : 'Shell environment snapshot (`uname -a`)';
  const shellSnapshot = entry.shell.snapshotText.trim()
    ? entry.shell.snapshotText.trim()
    : language === 'zh'
      ? '（无）'
      : '(empty)';

  const fbrLabel = language === 'zh' ? 'FBR 输出（摘要）' : 'FBR output (summary)';
  const fbrLines = entry.fbr.responseText.replace(/\r\n/g, '\n').split('\n');
  const fbrPreview = fbrLines.slice(0, 28).join('\n').trim();

  const quickstart = entry.quickstartNote.trim();

  const out: ChatMessage[] = [
    { type: 'transient_guide_msg', role: 'assistant', content: header },
    {
      type: 'environment_msg',
      role: 'user',
      content: `${shellSnapshotLabel}:\n\n${shellSnapshot}`,
    },
    {
      type: 'transient_guide_msg',
      role: 'assistant',
      content: `${fbrLabel}:\n\n${fbrPreview ? fbrPreview : language === 'zh' ? '（无）' : '(empty)'}`,
    },
  ];

  if (quickstart) {
    out.push({ type: 'environment_msg', role: 'user', content: quickstart });
  }

  return out;
}

async function replayShowingByDoing(
  dlg: RootDialog,
  entry: ShowingByDoingCacheEntry,
): Promise<void> {
  const release = await dlg.acquire();
  try {
    const language = getWorkLanguage();
    dlg.setCoursePrefixMsgs(buildCoursePrefixMsgs(entry));
    await DialogPersistence.mutateDialogLatest(dlg.id, () => ({
      kind: 'patch',
      patch: { runState: { kind: 'proceeding' } },
    }));

    await dlg.notifyGeneratingStart();
    await emitSayingEvents(dlg, formatPreludeIntro(language, true));

    if (entry.shell.kind === 'specialist_tellask') {
      const shellCallContent = [
        `!?@${entry.shell.specialistId}`,
        ...prefixTellaskBodyLines(entry.shell.tellaskBody).split('\n'),
        '',
      ].join('\n');
      const shellCalls = await emitSayingEvents(dlg, shellCallContent);
      const shellCall = shellCalls.find((c) => c.validation.kind === 'valid');
      if (shellCall) {
        await dlg.receiveTeammateResponse(
          entry.shell.specialistId,
          shellCall.tellaskHead,
          'completed',
          undefined,
          {
            response: entry.shell.responseText,
            agentId: entry.shell.specialistId,
            callId: shellCall.callId,
            originMemberId: dlg.agentId,
          },
        );
      }
    } else {
      await emitSayingEvents(dlg, entry.shell.directNoteMarkdown);
    }

    const fbrCallContent = [
      '!?@self',
      ...prefixTellaskBodyLines(entry.fbr.tellaskBody).split('\n'),
      '',
    ].join('\n');
    const fbrCalls = await emitSayingEvents(dlg, fbrCallContent);
    const fbrCall = fbrCalls.find((c) => c.validation.kind === 'valid');
    if (fbrCall) {
      await dlg.receiveTeammateResponse(
        entry.fbr.responderAgentId,
        fbrCall.tellaskHead,
        'completed',
        undefined,
        {
          response: entry.fbr.responseText,
          agentId: entry.fbr.responderAgentId,
          callId: fbrCall.callId,
          originMemberId: dlg.agentId,
        },
      );
    }

    await emitSayingEvents(dlg, entry.quickstartNote);
  } catch (err) {
    log.warn('Showing-by-Doing replay failed (best-effort)', err, { dialogId: dlg.id.valueOf() });
  } finally {
    try {
      await dlg.notifyGeneratingFinish();
    } catch (_finishErr) {
      // best-effort
    }
    await DialogPersistence.mutateDialogLatest(dlg.id, () => ({
      kind: 'patch',
      patch: { runState: { kind: 'idle_waiting_user' } },
    }));
    release();
  }
}

async function runShowingByDoingLive(dlg: RootDialog): Promise<ShowingByDoingCacheEntry> {
  const release = await dlg.acquire();
  const createdAt = formatUnifiedTimestamp(new Date());
  const language = getWorkLanguage();
  try {
    await DialogPersistence.mutateDialogLatest(dlg.id, () => ({
      kind: 'patch',
      patch: { runState: { kind: 'proceeding' } },
    }));

    await dlg.notifyGeneratingStart();
    await emitSayingEvents(dlg, formatPreludeIntro(language, false));

    const team = await Team.load();
    const specialists = team.shellSpecialists;
    const specialistId =
      specialists.length > 0 && typeof specialists[0] === 'string' && specialists[0].trim() !== ''
        ? specialists[0]
        : null;

    const shellTellaskBody = formatShellTellaskBody(language);

    let shellResponseText = '';
    let snapshotText = '';
    let directNoteMarkdown = '';

    if (specialistId !== null) {
      const shellCallSaying = [
        `!?@${specialistId}`,
        ...prefixTellaskBodyLines(shellTellaskBody).split('\n'),
        '',
      ].join('\n');
      const calls = await emitSayingEvents(dlg, shellCallSaying);
      const call = calls.find((c) => c.validation.kind === 'valid');
      if (!call) {
        throw new Error('Failed to emit shell specialist tellask call');
      }

      const sub = await dlg.createSubDialog(specialistId, call.tellaskHead, call.body, {
        originMemberId: dlg.agentId,
        callerDialogId: dlg.id.selfId,
        callId: call.callId,
        collectiveTargets: [specialistId],
      });

      const initPrompt = formatAssignmentFromSupdialog({
        fromAgentId: dlg.agentId,
        toAgentId: sub.agentId,
        tellaskHead: call.tellaskHead,
        tellaskBody: call.body,
        language,
        collectiveTargets: [specialistId],
      });

      await driveDialogStream(
        sub,
        { content: initPrompt, msgId: generateShortId(), grammar: 'markdown' },
        true,
      );

      shellResponseText = extractLastAssistantSaying(sub.msgs);
      const toolResult = extractLastShellCmdResultText(sub.msgs);
      snapshotText = toolResult ? toolResult : shellResponseText;
      if (!snapshotText.trim()) {
        // Specialist produced no usable output (misconfigured tools, provider issues, etc.).
        // Fall back to a runtime-executed `uname -a` so we can still proceed to FBR.
        snapshotText = await runUnameA();
      }

      await dlg.receiveTeammateResponse(specialistId, call.tellaskHead, 'completed', sub.id, {
        response: shellResponseText,
        agentId: specialistId,
        callId: call.callId,
        originMemberId: dlg.agentId,
      });
    } else {
      // No shell specialist configured: run a minimal baseline command directly in the runtime.
      // Keep it safe and deterministic: no network, no writes.
      const unameOutput = await runUnameA();

      shellResponseText = unameOutput;
      snapshotText = unameOutput;
      const directNote =
        language === 'zh'
          ? [
              '未配置 `shell_specialists`，由 Dominds 运行时执行：`uname -a`',
              '',
              '```console',
              unameOutput,
              '```',
              '',
            ].join('\n')
          : [
              'No `shell_specialists` configured; Dominds runtime runs: `uname -a`',
              '',
              '```console',
              unameOutput,
              '```',
              '',
            ].join('\n');
      directNoteMarkdown = directNote;
      await emitSayingEvents(dlg, directNoteMarkdown);
    }

    const snapshotBody = formatFbrTellaskBody(language, snapshotText);
    const fbrSaying = ['!?@self', ...prefixTellaskBodyLines(snapshotBody).split('\n'), ''].join(
      '\n',
    );
    const fbrCalls = await emitSayingEvents(dlg, fbrSaying);
    const fbrCall = fbrCalls.find((c) => c.validation.kind === 'valid');
    if (!fbrCall) {
      throw new Error('Failed to emit FBR tellask call');
    }

    const fbrSub = await dlg.createSubDialog(dlg.agentId, fbrCall.tellaskHead, fbrCall.body, {
      originMemberId: dlg.agentId,
      callerDialogId: dlg.id.selfId,
      callId: fbrCall.callId,
      collectiveTargets: [dlg.agentId],
    });

    const fbrInitPrompt = formatAssignmentFromSupdialog({
      fromAgentId: dlg.agentId,
      toAgentId: fbrSub.agentId,
      tellaskHead: fbrCall.tellaskHead,
      tellaskBody: fbrCall.body,
      language,
      collectiveTargets: [dlg.agentId],
    });

    await driveDialogStream(
      fbrSub,
      { content: fbrInitPrompt, msgId: generateShortId(), grammar: 'markdown' },
      true,
    );

    const fbrResponseText = extractLastAssistantSaying(fbrSub.msgs);
    await dlg.receiveTeammateResponse(dlg.agentId, fbrCall.tellaskHead, 'completed', fbrSub.id, {
      response: fbrResponseText,
      agentId: dlg.agentId,
      callId: fbrCall.callId,
      originMemberId: dlg.agentId,
    });

    const unameLine = takeFirstNonEmptyLine(snapshotText);
    const quickstartNote = formatQuickstartNote(language, unameLine, fbrResponseText);
    await emitSayingEvents(dlg, quickstartNote);

    const entry: ShowingByDoingCacheEntry = {
      createdAt,
      workLanguage: language,
      shell:
        specialistId !== null
          ? {
              kind: 'specialist_tellask',
              specialistId,
              tellaskBody: shellTellaskBody,
              responseText: shellResponseText,
              snapshotText,
            }
          : {
              kind: 'direct_shell',
              directNoteMarkdown,
              snapshotText,
            },
      fbr: {
        tellaskHead: '@self',
        tellaskBody: snapshotBody,
        responderAgentId: dlg.agentId,
        responseText: fbrResponseText,
      },
      quickstartNote,
    };

    dlg.setCoursePrefixMsgs(buildCoursePrefixMsgs(entry));
    return entry;
  } catch (err) {
    log.warn('Showing-by-Doing live run failed (best-effort)', err, { dialogId: dlg.id.valueOf() });
    const msg =
      language === 'zh'
        ? '做给祂看序幕执行失败（已跳过）。你可以继续正常对话。'
        : 'Showing-by-Doing prelude failed (skipped). You can continue normally.';
    try {
      await emitSayingEvents(dlg, msg);
    } catch (_emitErr) {
      // best-effort
    }
    throw err;
  } finally {
    try {
      await dlg.notifyGeneratingFinish();
    } catch (_finishErr) {
      // best-effort
    }
    await DialogPersistence.mutateDialogLatest(dlg.id, () => ({
      kind: 'patch',
      patch: { runState: { kind: 'idle_waiting_user' } },
    }));
    release();
  }
}
