import { RootDialog } from './dialog';
import { computeIdleRunState, setDialogRunState } from './dialog-run-state';
import type { ChatMessage } from './llm/client';
import { driveDialogStream, emitSayingEvents } from './llm/driver';
import { log } from './log';
import { getWorkLanguage } from './shared/runtime-language';
import type { LanguageCode } from './shared/types/language';
import type { DialogRunState } from './shared/types/run-state';
import { generateShortId } from './shared/utils/id';
import { formatAssignmentFromSupdialog } from './shared/utils/inter-dialog-format';
import { formatUnifiedTimestamp } from './shared/utils/time';
import { Team } from './team';

type ShowingByDoingCacheEntry = Readonly<{
  createdAt: string;
  workLanguage: LanguageCode;
  shellPolicy: 'specialist_only' | 'no_specialist' | 'self_is_specialist';
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

const BASELINE_ENV_SNAPSHOT_CMD = 'uname -a';

const cacheByTellaskerAgentId: Map<string, ShowingByDoingCacheEntry> = new Map();
const inflightByTellaskerAgentId: Map<string, Promise<ShowingByDoingCacheEntry>> = new Map();

export type ShowingByDoingCacheStatus = Readonly<
  { hasCache: false } | { hasCache: true; createdAt: string; ageSeconds: number }
>;

async function emitSayingEventsAndPersist(
  dlg: RootDialog,
  content: string,
): Promise<Awaited<ReturnType<typeof emitSayingEvents>>> {
  const calls = await emitSayingEvents(dlg, content);
  const genseq = dlg.activeGenSeqOrUndefined;
  if (
    dlg.generationStarted &&
    typeof genseq === 'number' &&
    Number.isFinite(genseq) &&
    genseq > 0 &&
    content.trim()
  ) {
    try {
      await dlg.persistAgentMessage(content, genseq, 'saying_msg');
    } catch (err: unknown) {
      log.warn('Failed to persist Showing-by-Doing synthetic saying content (best-effort)', err, {
        dialogId: dlg.id.valueOf(),
        genseq,
      });
    }
  }
  return calls;
}

function parseUnifiedTimestamp(value: string): Date | null {
  const m = value.trim().match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);
  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day) ||
    !Number.isFinite(hour) ||
    !Number.isFinite(minute) ||
    !Number.isFinite(second)
  ) {
    return null;
  }
  return new Date(year, month - 1, day, hour, minute, second);
}

export function getShowingByDoingCacheStatus(agentId: string): ShowingByDoingCacheStatus {
  const entry = cacheByTellaskerAgentId.get(agentId);
  if (!entry) return { hasCache: false };
  const createdAt = entry.createdAt;
  const parsed = parseUnifiedTimestamp(createdAt);
  const ageSeconds =
    parsed === null ? 0 : Math.max(0, Math.floor((Date.now() - parsed.getTime()) / 1000));
  return { hasCache: true, createdAt, ageSeconds };
}

export function scheduleShowingByDoingForNewDialog(
  dlg: RootDialog,
  options: { mode: 'do' | 'reuse' | 'skip' },
): void {
  if (options.mode === 'skip') return;

  const tellaskerAgentId = dlg.agentId;
  const existing = cacheByTellaskerAgentId.get(tellaskerAgentId);
  if (options.mode === 'reuse' && existing) {
    dlg.setCoursePrefixMsgs(buildCoursePrefixMsgs(existing));
    void replayShowingByDoing(dlg, existing);
    return;
  }

  const inflight = inflightByTellaskerAgentId.get(tellaskerAgentId);
  if (inflight) {
    void inflight.then((entry) => {
      if (options.mode === 'reuse') {
        dlg.setCoursePrefixMsgs(buildCoursePrefixMsgs(entry));
        return replayShowingByDoing(dlg, entry);
      }
      // mode === 'do': wait for in-flight then run again for this dialog.
      return runShowingByDoingLive(dlg).then((next) => {
        cacheByTellaskerAgentId.set(tellaskerAgentId, next);
      });
    });
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

function formatPreludeIntro(
  language: LanguageCode,
  reused: boolean,
  shellPolicy: ShowingByDoingCacheEntry['shellPolicy'],
): string {
  const shellPolicyLinesZh: string[] =
    shellPolicy === 'specialist_only'
      ? [
          '规则：此智能体**不执行任何 shell 命令**。所有 shell 命令必须通过 `shell_specialist` 执行并回传。',
          '下面将诉请 shell 专家仅执行一个低风险命令：`uname -a`。',
        ]
      : shellPolicy === 'self_is_specialist'
        ? [
            '本次对话主理人属于 `shell_specialists`，将略去 shell 诉请环节。',
            '由 Dominds 运行时执行一个基线命令：`uname -a`，随后进入 `!?@self` FBR。',
          ]
        : [
            '本团队未配置 `shell_specialist`。',
            '规则：此智能体必须**不执行任何 shell 命令**（不能“自己跑一下看看”）。',
            '后续只能通过文件读写等非 shell 工具推进；同时要结合环境快照留意系统相关注意事项。',
            '由 Dominds 运行时仅执行一个基线命令：`uname -a`，随后进入 `!?@self` FBR。',
          ];

  const shellPolicyLinesEn: string[] =
    shellPolicy === 'specialist_only'
      ? [
          'Rule: this agent must **not run any shell commands**. All shell commands must be executed by a `shell_specialist` and returned.',
          'Next, we Tellask the shell specialist to run one low-risk command only: `uname -a`.',
        ]
      : shellPolicy === 'self_is_specialist'
        ? [
            'The dialog owner is a member of `shell_specialists`, so we skip the shell Tellask step.',
            'Dominds runtime runs one baseline command: `uname -a`, then we enter `!?@self` FBR.',
          ]
        : [
            'This team has no configured `shell_specialist`.',
            'Rule: this agent must **not run any shell commands** (no “just try it locally”).',
            'We can only proceed with non-shell tools like file read/write; still, we must watch out for environment-specific constraints.',
            'Dominds runtime runs one baseline command only: `uname -a`, then we enter `!?@self` FBR.',
          ];

  if (language === 'zh') {
    return reused
      ? [
          '## Prelude：做给祂看（复用缓存）',
          '',
          '这段序幕用于把“诉请 + 回传 + FBR”变成体感。',
          '本次对话复用了本进程内缓存：未重复执行命令。',
          '',
          ...shellPolicyLinesZh,
          '',
        ].join('\n')
      : [
          '## Prelude：做给祂看',
          '',
          '这段序幕用于把“诉请 + 回传 + FBR”变成体感。',
          '',
          ...shellPolicyLinesZh,
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
        ...shellPolicyLinesEn,
        '',
      ].join('\n')
    : [
        '## Prelude: Showing-by-Doing',
        '',
        'This prelude makes Tellask + return + FBR feel real.',
        '',
        ...shellPolicyLinesEn,
        '',
      ].join('\n');
}

function formatShellTellaskBody(language: LanguageCode): string {
  if (language === 'zh') {
    return [
      '你是 shell 专家：请代我执行 `uname -a` 获取当前运行环境的基本信息。',
      '',
      '背景规则：对话主理人不得执行任何 shell 命令；所有 shell 命令必须通过你执行并回传。',
      '请不要建议我“自己在本地跑一下”。',
      '',
      '要求：',
      '- 通过 shell 工具执行：uname -a（只执行这一条）',
      '- 原样返回输出（不要改写/解释）',
      '- 若命令不可用/失败：返回错误信息，并给出一个安全的替代命令',
      '',
      '输出格式：优先只给出原始输出，其次才是必要的简短说明。',
    ].join('\n');
  }
  return [
    'You are the shell specialist: please run `uname -a` on my behalf to capture the basic runtime environment.',
    '',
    'Rule: the dialog owner must not run any shell commands; all shell commands must be executed by you and returned.',
    'Do not suggest that I “just run it locally”.',
    '',
    'Requirements:',
    '- Use shell tools to run exactly: uname -a (and only this command)',
    '- Return the raw output verbatim (no paraphrase)',
    '- If the command fails: include the error and suggest one safe alternative command',
    '',
    'Output format: prefer raw output only; keep any explanation minimal.',
  ].join('\n');
}

function formatFbrTellaskBody(
  language: LanguageCode,
  snapshotCmd: string,
  snapshotText: string,
  shellPolicy: ShowingByDoingCacheEntry['shellPolicy'],
): string {
  const shellPolicyTailZh =
    shellPolicy === 'specialist_only'
      ? [
          '',
          '约束提醒：后续如需任何 shell 命令，必须诉请 `shell_specialist` 执行并回传；此智能体不应自行执行。',
        ].join('\n')
      : shellPolicy === 'no_specialist'
        ? [
            '',
            '约束提醒：本团队无 `shell_specialist`，因此后续**不能执行任意 shell 命令**；只能通过文件读写等非 shell 工具推进。',
          ].join('\n')
        : '';

  const shellPolicyTailEn =
    shellPolicy === 'specialist_only'
      ? [
          '',
          'Constraint: if we need any shell command later, we must Tellask a `shell_specialist` to run it and return; this agent must not run it directly.',
        ].join('\n')
      : shellPolicy === 'no_specialist'
        ? [
            '',
            'Constraint: this team has no `shell_specialist`, so we must **not run arbitrary shell commands**; proceed only with non-shell tools like file read/write.',
          ].join('\n')
        : '';

  if (language === 'zh') {
    return [
      '你正在进行一次“扪心自问”（FBR）。你**没有任何工具**，不能调用工具、不能诉请队友，只能使用本文本推理。',
      '',
      '请基于下面环境信息回答：',
      '- 在这个环境里要注意些什么？',
      '- 优先利用哪些命令行工具，为什么？',
      '',
      `环境信息（来自命令：\`${snapshotCmd}\`）：`,
      snapshotText,
      shellPolicyTailZh,
    ].join('\n');
  }
  return [
    'You are doing Fresh Boots Reasoning (FBR). You have **no tools**: do not call tools, do not Tellask anyone.',
    '',
    'Based on the environment info below, answer:',
    '- What should we watch out for in this environment?',
    '- Which CLI tools should we prioritize, and why?',
    '',
    `Environment info (from \`${snapshotCmd}\`):`,
    snapshotText,
    shellPolicyTailEn,
  ].join('\n');
}

function formatQuickstartNote(
  language: LanguageCode,
  unameLine: string | null,
  fbrResponse: string,
  shellPolicy: ShowingByDoingCacheEntry['shellPolicy'],
): string {
  const header =
    language === 'zh' ? '## 环境速记（Environment Quickstart）' : '## Environment Quickstart';
  const policyNote =
    shellPolicy === 'specialist_only'
      ? language === 'zh'
        ? '规则：所有 shell 命令必须通过 `shell_specialist` 执行并回传。'
        : 'Rule: all shell commands must be executed by a `shell_specialist` and returned.'
      : shellPolicy === 'no_specialist'
        ? language === 'zh'
          ? '规则：无 `shell_specialist`；后续不得执行任意 shell 命令，只能用文件读写等非 shell 工具。'
          : 'Rule: no `shell_specialist`; do not run arbitrary shell commands—use non-shell tools like file read/write.'
        : '';
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
    policyNote ? `${policyNote}\n` : '',
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
  const header = (() => {
    if (language === 'zh') {
      if (entry.shellPolicy === 'specialist_only') {
        return 'Prelude（做给祂看）上下文：本进程在对话创建时已真实跑通一次“诉请（shell 专家）+ 回传 + `!?@self` FBR”。以下为压缩转录，作为每一程对话的开头上下文注入。';
      }
      if (entry.shellPolicy === 'no_specialist') {
        return 'Prelude（做给祂看）上下文：本进程在对话创建时已获取环境快照并完成一次 `!?@self` FBR（无 shell 专家；不得执行任意 shell 命令）。以下为压缩转录，作为每一程对话的开头上下文注入。';
      }
      return 'Prelude（做给祂看）上下文：本进程在对话创建时已获取环境快照并完成一次 `!?@self` FBR。以下为压缩转录，作为每一程对话的开头上下文注入。';
    }

    if (entry.shellPolicy === 'specialist_only') {
      return 'Prelude (Showing-by-Doing) context: this process already ran a real Tellask (shell specialist) + return + `!?@self` FBR at dialog creation. The condensed transcript below is injected at the start of each course.';
    }
    if (entry.shellPolicy === 'no_specialist') {
      return 'Prelude (Showing-by-Doing) context: this process captured an environment snapshot and ran `!?@self` FBR at dialog creation (no shell specialist; do not run arbitrary shell commands). The condensed transcript below is injected at the start of each course.';
    }
    return 'Prelude (Showing-by-Doing) context: this process captured an environment snapshot and ran `!?@self` FBR at dialog creation. The condensed transcript below is injected at the start of each course.';
  })();

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
    await setDialogRunState(dlg.id, { kind: 'proceeding' });

    // Phase 1: shell ask (and optional prelude intro)
    let shellCallId: string | null = null;
    let shellTellaskHead: string | null = null;
    try {
      await dlg.notifyGeneratingStart();
      await emitSayingEventsAndPersist(dlg, formatPreludeIntro(language, true, entry.shellPolicy));

      if (entry.shell.kind === 'specialist_tellask') {
        const shellCallContent = [
          `!?@${entry.shell.specialistId}`,
          ...prefixTellaskBodyLines(entry.shell.tellaskBody).split('\n'),
          '',
        ].join('\n');
        const shellCalls = await emitSayingEventsAndPersist(dlg, shellCallContent);
        const shellCall = shellCalls.find((c) => c.validation.kind === 'valid');
        if (shellCall) {
          shellCallId = shellCall.callId;
          shellTellaskHead = shellCall.tellaskHead;
        }
      } else {
        await emitSayingEventsAndPersist(dlg, entry.shell.directNoteMarkdown);
      }
    } finally {
      try {
        await dlg.notifyGeneratingFinish();
      } catch (_finishErr) {
        // best-effort
      }
    }

    // Phase 2: shell response (separate bubble)
    if (entry.shell.kind === 'specialist_tellask' && shellCallId && shellTellaskHead) {
      await dlg.receiveTeammateResponse(
        entry.shell.specialistId,
        shellTellaskHead,
        'completed',
        undefined,
        {
          response: entry.shell.responseText,
          agentId: entry.shell.specialistId,
          callId: shellCallId,
          originMemberId: dlg.agentId,
        },
      );
    }

    // Phase 3: FBR ask (call bubble)
    let fbrCallId: string | null = null;
    let fbrTellaskHead: string | null = null;
    try {
      await dlg.notifyGeneratingStart();
      const fbrCallContent = [
        '!?@self',
        ...prefixTellaskBodyLines(entry.fbr.tellaskBody).split('\n'),
        '',
      ].join('\n');
      const fbrCalls = await emitSayingEventsAndPersist(dlg, fbrCallContent);
      const fbrCall = fbrCalls.find((c) => c.validation.kind === 'valid');
      if (fbrCall) {
        fbrCallId = fbrCall.callId;
        fbrTellaskHead = fbrCall.tellaskHead;
      }
    } finally {
      try {
        await dlg.notifyGeneratingFinish();
      } catch (_finishErr) {
        // best-effort
      }
    }

    // Phase 4: FBR response (separate bubble)
    if (fbrCallId && fbrTellaskHead) {
      await dlg.receiveTeammateResponse(
        entry.fbr.responderAgentId,
        fbrTellaskHead,
        'completed',
        undefined,
        {
          response: entry.fbr.responseText,
          agentId: entry.fbr.responderAgentId,
          callId: fbrCallId,
          originMemberId: dlg.agentId,
        },
      );
    }

    // Phase 5: summary bubble
    try {
      await dlg.notifyGeneratingStart();
      await emitSayingEventsAndPersist(dlg, entry.quickstartNote);
    } finally {
      try {
        await dlg.notifyGeneratingFinish();
      } catch (_finishErr) {
        // best-effort
      }
    }
  } catch (err) {
    log.warn('Showing-by-Doing replay failed (best-effort)', err, { dialogId: dlg.id.valueOf() });
  } finally {
    let nextIdle: DialogRunState = { kind: 'idle_waiting_user' };
    try {
      nextIdle = await computeIdleRunState(dlg);
    } catch (err: unknown) {
      log.warn('Failed to compute idle runState after Showing-by-Doing replay; falling back', err, {
        dialogId: dlg.id.valueOf(),
      });
    }
    await setDialogRunState(dlg.id, nextIdle);
    release();
  }
}

async function runShowingByDoingLive(dlg: RootDialog): Promise<ShowingByDoingCacheEntry> {
  const release = await dlg.acquire();
  const createdAt = formatUnifiedTimestamp(new Date());
  const language = getWorkLanguage();
  try {
    await setDialogRunState(dlg.id, { kind: 'proceeding' });

    const team = await Team.load();
    const specialists = team.shellSpecialists
      .filter((s): s is string => typeof s === 'string')
      .map((s) => s.trim())
      .filter((s) => s !== '');
    const selfIsShellSpecialist = specialists.includes(dlg.agentId);
    const specialistId = specialists.find((s) => s !== dlg.agentId) ?? null;
    const shellPolicy: ShowingByDoingCacheEntry['shellPolicy'] =
      specialists.length < 1
        ? 'no_specialist'
        : selfIsShellSpecialist
          ? 'self_is_specialist'
          : 'specialist_only';

    const shellTellaskBody = formatShellTellaskBody(language);

    let shellResponseText = '';
    let snapshotText = '';
    let directNoteMarkdown = '';
    let shellCallId: string | null = null;
    let shellTellaskHead: string | null = null;
    let shellTellaskBodyForSubdialog: string | null = null;

    // Phase 1: shell ask (and optional prelude intro)
    try {
      await dlg.notifyGeneratingStart();
      await emitSayingEventsAndPersist(dlg, formatPreludeIntro(language, false, shellPolicy));

      if (shellPolicy === 'specialist_only' && specialistId !== null) {
        const shellCallSaying = [
          `!?@${specialistId}`,
          ...prefixTellaskBodyLines(shellTellaskBody).split('\n'),
          '',
        ].join('\n');
        const calls = await emitSayingEventsAndPersist(dlg, shellCallSaying);
        const call = calls.find((c) => c.validation.kind === 'valid');
        if (!call) {
          throw new Error('Failed to emit shell specialist tellask call');
        }
        shellCallId = call.callId;
        shellTellaskHead = call.tellaskHead;
        shellTellaskBodyForSubdialog = call.body;
      } else {
        // Either no shell specialist is configured, or the dialog owner is itself a shell specialist.
        // In both cases we skip the shell Tellask step and let the runtime capture a baseline snapshot.
        // Keep it safe and deterministic: no network, no writes.
        const unameOutput = await runUnameA();
        shellResponseText = unameOutput;
        snapshotText = unameOutput;
        const directNote = (() => {
          if (shellPolicy === 'self_is_specialist') {
            return language === 'zh'
              ? [
                  '由 Dominds 运行时执行：`uname -a`',
                  '',
                  '```console',
                  unameOutput,
                  '```',
                  '',
                ].join('\n')
              : ['Dominds runtime ran: `uname -a`', '', '```console', unameOutput, '```', ''].join(
                  '\n',
                );
          }
          return language === 'zh'
            ? [
                '未配置 `shell_specialist`：由 Dominds 运行时仅执行基线命令 `uname -a` 以获取环境快照。',
                '约束：后续**不得执行任意 shell 命令**；只能通过文件读写等非 shell 工具推进。',
                '',
                '```console',
                unameOutput,
                '```',
                '',
              ].join('\n')
            : [
                'No `shell_specialist` configured: Dominds runtime ran only the baseline command `uname -a` to capture an environment snapshot.',
                'Constraint: do **not** run arbitrary shell commands; proceed only with non-shell tools like file read/write.',
                '',
                '```console',
                unameOutput,
                '```',
                '',
              ].join('\n');
        })();
        directNoteMarkdown = directNote;
        await emitSayingEventsAndPersist(dlg, directNoteMarkdown);
      }
    } finally {
      try {
        await dlg.notifyGeneratingFinish();
      } catch (_finishErr) {
        // best-effort
      }
    }

    // Phase 2: shell response (separate bubble)
    if (
      shellPolicy === 'specialist_only' &&
      specialistId !== null &&
      shellCallId &&
      shellTellaskHead
    ) {
      const tellaskBody = shellTellaskBodyForSubdialog ?? shellTellaskBody;
      const sub = await dlg.createSubDialog(specialistId, shellTellaskHead, tellaskBody, {
        originMemberId: dlg.agentId,
        callerDialogId: dlg.id.selfId,
        callId: shellCallId,
        collectiveTargets: [specialistId],
      });

      const initPrompt = formatAssignmentFromSupdialog({
        fromAgentId: dlg.agentId,
        toAgentId: sub.agentId,
        tellaskHead: shellTellaskHead,
        tellaskBody,
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

      await dlg.receiveTeammateResponse(specialistId, shellTellaskHead, 'completed', sub.id, {
        response: shellResponseText,
        agentId: specialistId,
        callId: shellCallId,
        originMemberId: dlg.agentId,
      });
    }

    const snapshotBody = formatFbrTellaskBody(
      language,
      BASELINE_ENV_SNAPSHOT_CMD,
      snapshotText,
      shellPolicy,
    );
    let fbrCallId: string | null = null;
    let fbrTellaskHead: string | null = null;

    // Phase 3: FBR ask (call bubble)
    try {
      await dlg.notifyGeneratingStart();
      const fbrSaying = ['!?@self', ...prefixTellaskBodyLines(snapshotBody).split('\n'), ''].join(
        '\n',
      );
      const fbrCalls = await emitSayingEventsAndPersist(dlg, fbrSaying);
      const fbrCall = fbrCalls.find((c) => c.validation.kind === 'valid');
      if (!fbrCall) {
        throw new Error('Failed to emit FBR tellask call');
      }
      fbrCallId = fbrCall.callId;
      fbrTellaskHead = fbrCall.tellaskHead;
    } finally {
      try {
        await dlg.notifyGeneratingFinish();
      } catch (_finishErr) {
        // best-effort
      }
    }

    // Phase 4: FBR response (separate bubble)
    if (!fbrCallId || !fbrTellaskHead) {
      throw new Error('Missing FBR callId/tellaskHead');
    }

    const fbrSub = await dlg.createSubDialog(dlg.agentId, fbrTellaskHead, snapshotBody, {
      originMemberId: dlg.agentId,
      callerDialogId: dlg.id.selfId,
      callId: fbrCallId,
      collectiveTargets: [dlg.agentId],
    });

    const fbrInitPrompt = formatAssignmentFromSupdialog({
      fromAgentId: dlg.agentId,
      toAgentId: fbrSub.agentId,
      tellaskHead: fbrTellaskHead,
      tellaskBody: snapshotBody,
      language,
      collectiveTargets: [dlg.agentId],
    });

    await driveDialogStream(
      fbrSub,
      { content: fbrInitPrompt, msgId: generateShortId(), grammar: 'markdown' },
      true,
    );

    const fbrResponseText = extractLastAssistantSaying(fbrSub.msgs);
    await dlg.receiveTeammateResponse(dlg.agentId, fbrTellaskHead, 'completed', fbrSub.id, {
      response: fbrResponseText,
      agentId: dlg.agentId,
      callId: fbrCallId,
      originMemberId: dlg.agentId,
    });

    const unameLine = takeFirstNonEmptyLine(snapshotText);
    const quickstartNote = formatQuickstartNote(language, unameLine, fbrResponseText, shellPolicy);
    // Phase 5: summary bubble
    try {
      await dlg.notifyGeneratingStart();
      await emitSayingEventsAndPersist(dlg, quickstartNote);
    } finally {
      try {
        await dlg.notifyGeneratingFinish();
      } catch (_finishErr) {
        // best-effort
      }
    }

    const entry: ShowingByDoingCacheEntry = {
      createdAt,
      workLanguage: language,
      shellPolicy,
      shell:
        shellPolicy === 'specialist_only' && specialistId !== null
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
      await dlg.notifyGeneratingStart();
      await emitSayingEventsAndPersist(dlg, msg);
      await dlg.notifyGeneratingFinish();
    } catch (_emitErr) {
      // best-effort
    }
    throw err;
  } finally {
    let nextIdle: DialogRunState = { kind: 'idle_waiting_user' };
    try {
      nextIdle = await computeIdleRunState(dlg);
    } catch (err: unknown) {
      log.warn(
        'Failed to compute idle runState after Showing-by-Doing live run; falling back',
        err,
        {
          dialogId: dlg.id.valueOf(),
        },
      );
    }
    await setDialogRunState(dlg.id, nextIdle);
    release();
  }
}
