/**
 * Module: agent-priming
 *
 * Best-effort Agent Priming prelude generation for new dialogs.
 */
import type { Dialog } from './dialog';
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

type AgentPrimingCacheEntry = Readonly<{
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
    selfTeaser: string;
    responderAgentId: string;
    effort: number;
    responses: ReadonlyArray<string>;
  }>;
  primingNote: string;
}>;

const BASELINE_ENV_SNAPSHOT_CMD = 'uname -a';

const cacheByAgentId: Map<string, AgentPrimingCacheEntry> = new Map();
const inflightByAgentId: Map<string, Promise<AgentPrimingCacheEntry | null>> = new Map();

export type AgentPrimingCacheStatus = Readonly<
  { hasCache: false } | { hasCache: true; createdAt: string; ageSeconds: number }
>;

export type AgentPrimingMode = 'do' | 'reuse' | 'skip';

async function emitSayingEventsAndPersist(
  dlg: Dialog,
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
      log.warn('Failed to persist Agent Priming synthetic saying content (best-effort)', err, {
        dialogId: dlg.id.valueOf(),
        genseq,
      });
    }
  }
  return calls;
}

async function emitUiOnlyMarkdownEventsAndPersist(dlg: Dialog, content: string): Promise<void> {
  const trimmed = content.trim();
  if (!trimmed) return;

  await dlg.markdownStart();
  await dlg.markdownChunk(content);
  await dlg.markdownFinish();

  const genseq = dlg.activeGenSeqOrUndefined;
  if (
    dlg.generationStarted &&
    typeof genseq === 'number' &&
    Number.isFinite(genseq) &&
    genseq > 0
  ) {
    try {
      await dlg.persistUiOnlyMarkdown(content, genseq);
    } catch (err: unknown) {
      log.warn('Failed to persist UI-only markdown (best-effort)', err, {
        dialogId: dlg.id.valueOf(),
        genseq,
      });
    }
  }
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

export function getAgentPrimingCacheStatus(agentId: string): AgentPrimingCacheStatus {
  const entry = cacheByAgentId.get(agentId);
  if (!entry) return { hasCache: false };
  const createdAt = entry.createdAt;
  const parsed = parseUnifiedTimestamp(createdAt);
  const ageSeconds =
    parsed === null ? 0 : Math.max(0, Math.floor((Date.now() - parsed.getTime()) / 1000));
  return { hasCache: true, createdAt, ageSeconds };
}

export function resolveInheritedSubdialogAgentPrimingMode(
  requestedMode: AgentPrimingMode,
  agentId: string,
): AgentPrimingMode {
  if (requestedMode === 'skip') return 'skip';
  if (requestedMode === 'reuse') return 'reuse';
  const hasCache = cacheByAgentId.has(agentId);
  // "do" without cache means "show it once now"; subdialogs may still reuse once cache appears.
  return hasCache ? 'do' : 'reuse';
}

export function scheduleAgentPrimingForNewDialog(
  dlg: Dialog,
  options: { mode: AgentPrimingMode },
): Promise<void> {
  if (options.mode === 'skip') return Promise.resolve();

  const agentId = dlg.agentId;
  const existing = cacheByAgentId.get(agentId);
  if (options.mode === 'reuse' && existing) {
    dlg.setCoursePrefixMsgs(buildCoursePrefixMsgs(existing));
    return replayAgentPriming(dlg, existing);
  }

  const inflight = inflightByAgentId.get(agentId);
  if (inflight) {
    return inflight.then((entry) => {
      if (options.mode === 'reuse' && entry) {
        dlg.setCoursePrefixMsgs(buildCoursePrefixMsgs(entry));
        return replayAgentPriming(dlg, entry);
      }
      // mode === 'do': wait for in-flight then run again for this dialog.
      if (options.mode === 'do') {
        return runAgentPrimingLive(dlg).then((next) => {
          cacheByAgentId.set(agentId, next);
        });
      }
      return Promise.resolve();
    });
  }

  const task = runAgentPrimingLive(dlg)
    .then((entry) => {
      cacheByAgentId.set(agentId, entry);
      return entry;
    })
    .catch((err: unknown) => {
      // Best-effort: avoid unhandled rejections; the dialog itself is already marked interrupted.
      log.warn('Agent Priming live run failed; will retry on next dialog', err, { agentId });
      return null;
    })
    .finally(() => {
      inflightByAgentId.delete(agentId);
    });
  inflightByAgentId.set(agentId, task);
  return task.then(() => undefined);
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
  shellPolicy: AgentPrimingCacheEntry['shellPolicy'],
  shellSpecialistId: string | null,
): string {
  const shellSpecialistMention =
    shellSpecialistId && shellSpecialistId.trim()
      ? `@${shellSpecialistId.trim()}`
      : '@<shell specialist>';
  const shellPolicyLinesZh: string[] =
    shellPolicy === 'specialist_only'
      ? [
          '规则：此智能体**不执行任何 shell 命令**。所有 shell 命令必须由 shell 专员执行并回传。',
          `下面将诉请 shell 专员（${shellSpecialistMention}）仅执行一个低风险命令：\`uname -a\`。`,
        ]
      : shellPolicy === 'self_is_specialist'
        ? [
            '本次对话主理人属于 `shell_specialists`，将略去 shell 诉请环节。',
            '由 Dominds 运行时执行一个基线命令：`uname -a`，随后进入 `!?@self` FBR。',
          ]
        : [
            '本团队未配置 shell 专员。',
            '规则：此智能体必须**不执行任何 shell 命令**（不能“自己跑一下看看”）。',
            '后续只能通过文件读写等非 shell 工具推进；同时要结合环境快照留意系统相关注意事项。',
            '由 Dominds 运行时仅执行一个基线命令：`uname -a`，随后进入 `!?@self` FBR。',
          ];

  const shellPolicyLinesEn: string[] =
    shellPolicy === 'specialist_only'
      ? [
          'Rule: this agent must **not run any shell commands**. All shell commands must be executed by the shell specialist and returned.',
          `Next, we Tellask the shell specialist (${shellSpecialistMention}) to run one low-risk command only: \`uname -a\`.`,
        ]
      : shellPolicy === 'self_is_specialist'
        ? [
            'The dialog owner is a member of `shell_specialists`, so we skip the shell Tellask step.',
            'Dominds runtime runs one baseline command: `uname -a`, then we enter `!?@self` FBR.',
          ]
        : [
            'This team has no configured shell specialist.',
            'Rule: this agent must **not run any shell commands** (no “just try it locally”).',
            'We can only proceed with non-shell tools like file read/write; still, we must watch out for environment-specific constraints.',
            'Dominds runtime runs one baseline command only: `uname -a`, then we enter `!?@self` FBR.',
          ];

  if (language === 'zh') {
    return reused
      ? [
          '## Prelude：智能体启动（复用缓存）',
          '',
          '这段序幕用于把“诉请 + 回传 + FBR + 综合提炼”变成体感（引导祂做给自己看）。',
          '本次对话复用了本进程内缓存：未重复执行命令。',
          '',
          ...shellPolicyLinesZh,
          '',
        ].join('\n')
      : [
          '## Prelude：智能体启动',
          '',
          '这段序幕用于把“诉请 + 回传 + FBR + 综合提炼”变成体感（引导祂做给自己看）。',
          '',
          ...shellPolicyLinesZh,
          '',
        ].join('\n');
  }
  return reused
    ? [
        '## Prelude: Agent Priming (Reused)',
        '',
        'This prelude makes Tellask + return + FBR + distillation feel real (guiding the agent to show it to itself).',
        'This dialog reused the in-process cache (no commands were re-run).',
        '',
        ...shellPolicyLinesEn,
        '',
      ].join('\n')
    : [
        '## Prelude: Agent Priming',
        '',
        'This prelude makes Tellask + return + FBR + distillation feel real (guiding the agent to show it to itself).',
        '',
        ...shellPolicyLinesEn,
        '',
      ].join('\n');
}

function formatShellTellaskBody(language: LanguageCode, shellSpecialistId: string | null): string {
  const shellSpecialistMention =
    shellSpecialistId && shellSpecialistId.trim() ? `@${shellSpecialistId.trim()}` : undefined;
  if (language === 'zh') {
    return [
      `你是 shell 专员${shellSpecialistMention ? `（${shellSpecialistMention}）` : ''}：请代我执行 \`uname -a\` 获取当前运行环境的基本信息。`,
      '',
      '背景规则：对话主理人不得执行任何 shell 命令；所有 shell 命令必须通过你执行并回传。',
      '请不要建议我“自己在本地跑一下”。',
      '收到回传后，我将基于该环境信息做一次 `!?@self` 扪心自问（FBR），并最终形成一条可复用的“智能体启动（Agent Priming）”笔记。',
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
    `You are the shell specialist${shellSpecialistMention ? ` (${shellSpecialistMention})` : ''}: please run \`uname -a\` on my behalf to capture the basic runtime environment.`,
    '',
    'Rule: the dialog owner must not run any shell commands; all shell commands must be executed by you and returned.',
    'Do not suggest that I “just run it locally”.',
    'After I receive your output, I will run `!?@self` Fresh Boots Reasoning (FBR) on this environment, then produce a reusable “Agent Priming” note.',
    '',
    'Requirements:',
    '- Use shell tools to run exactly: uname -a (and only this command)',
    '- Return the raw output verbatim (no paraphrase)',
    '- If the command fails: include the error and suggest one safe alternative command',
    '',
    'Output format: prefer raw output only; keep any explanation minimal.',
  ].join('\n');
}

function formatFbrSelfTeaser(language: LanguageCode): string {
  if (language === 'zh') {
    return '（我会在收到全部 FBR 支线反馈后进行综合提炼，并在主线对话中输出一条可复用的“智能体启动（Agent Priming）”笔记。）';
  }
  return '(After I receive all FBR sideline feedback, I will distill it into a reusable “Agent Priming” note.)';
}

function formatFbrTellaskBody(
  language: LanguageCode,
  snapshotText: string,
  options: { fbrEffort: number },
): string {
  const effortLineZh =
    options.fbrEffort >= 1
      ? '运行时提示：运行时会生成多份“初心自我”独立推理草稿，供上游对话综合提炼（这些草稿之间没有稳定映射关系，不要把它们当作固定身份）。请给出你这一份独立分析。'
      : '运行时提示：本成员已禁用 FBR。';
  const effortLineEn =
    options.fbrEffort >= 1
      ? 'Runtime note: the runtime will generate multiple independent “fresh boots” drafts for the upstream dialog to distill (no stable mapping—do not treat them as fixed identities). Please produce your own independent analysis.'
      : 'Runtime note: FBR is disabled for this member.';

  const tellaskBackHintZh = (() => {
    return [
      '提示：如果你还想知道更多系统细节，可在本 FBR 支线对话中用 `!?@tellasker` 回问诉请者（上游对话）。',
      '（当前这次 FBR 请不要真的发起任何诉请；只需说明你会回问什么。）',
    ].join('\n');
  })();

  const tellaskBackHintEn = (() => {
    return [
      'Hint: if you want more system details, ask back in this FBR sideline dialog via `!?@tellasker` (to the upstream tellasker dialog).',
      '(In this FBR run, do not actually emit any tellasks; just state what you would ask back.)',
    ].join('\n');
  })();

  if (language === 'zh') {
    return [
      effortLineZh,
      '',
      tellaskBackHintZh,
      '',
      '请基于下面环境信息回答：',
      '- 在这个环境里要注意些什么？',
      '- 哪些关键上下文仍然缺失？',
      '',
      '环境信息（当前 Dominds 运行时环境快照）：',
      snapshotText,
    ].join('\n');
  }
  return [
    effortLineEn,
    '',
    tellaskBackHintEn,
    '',
    'Based on the environment info below, answer:',
    '- What should we watch out for in this environment?',
    '- What critical context is still missing?',
    '',
    'Environment info (a snapshot of the current Dominds runtime):',
    snapshotText,
  ].join('\n');
}

async function generatePrimingNoteViaMainlineAgent(options: {
  dlg: Dialog;
  shellSnapshotText: string;
  shellResponseText?: string;
  fbrResponses: ReadonlyArray<{ subdialogId: string; response: string }>;
  fbrTellaskHead: string;
  fbrCallId: string;
}): Promise<string> {
  const { dlg, shellSnapshotText, shellResponseText, fbrResponses, fbrTellaskHead, fbrCallId } =
    options;

  // Trigger a normal drive and rely on driver.ts context assembly.
  // Agent Priming must not trigger Diligence Push (“鞭策”); it should be best-effort
  // one-shot distillation with no keep-going injection.
  const prevDisableDiligencePush = dlg.disableDiligencePush;
  try {
    dlg.disableDiligencePush = true;
    const beforeMsgs = dlg.msgs.length;
    const language = getWorkLanguage();

    // IMPORTANT: include shell snapshot + FBR drafts in the internal prompt itself.
    // - Must be non-persisted (persistMode: 'internal')
    // - Must be robust even if the driver loop iterates (context health remediation)
    // - Must avoid relying on the subdialog-response queue
    const evidenceParts: string[] = [];
    const snapshotTrimmed = shellSnapshotText.trim();
    if (snapshotTrimmed) {
      evidenceParts.push(
        language === 'zh'
          ? ['环境快照（来自 `uname -a`）：', snapshotTrimmed].join('\n')
          : ['Environment snapshot (from `uname -a`):', snapshotTrimmed].join('\n'),
      );
    }
    const shellReturnTrimmed =
      typeof shellResponseText === 'string' ? shellResponseText.trim() : '';
    if (shellReturnTrimmed && shellReturnTrimmed !== snapshotTrimmed) {
      evidenceParts.push(
        language === 'zh'
          ? ['Shell 反馈（完整回传）：', shellReturnTrimmed].join('\n')
          : ['Shell feedback (full return):', shellReturnTrimmed].join('\n'),
      );
    }

    const maxDrafts = Math.min(6, fbrResponses.length);
    for (let i = 0; i < maxDrafts; i++) {
      const r = fbrResponses[i];
      const trimmed = r.response.trim();
      if (!trimmed) continue;
      const cap = 4000;
      const capped =
        trimmed.length <= cap
          ? trimmed
          : language === 'zh'
            ? `${trimmed.slice(0, cap).trimEnd()}\n\n（已截断：仅显示前 ${cap} 字符）`
            : `${trimmed.slice(0, cap).trimEnd()}\n\n(truncated: first ${cap} chars only)`;

      const fbrLabel = (() => {
        const head = fbrTellaskHead.trim();
        const callId = fbrCallId.trim();
        if (head && callId) {
          return language === 'zh'
            ? `FBR 草稿 #${i + 1}（tellaskHead: ${head}；callId: ${callId}）`
            : `FBR draft #${i + 1} (tellaskHead: ${head}; callId: ${callId})`;
        }
        if (head) {
          return language === 'zh'
            ? `FBR 草稿 #${i + 1}（tellaskHead: ${head}）`
            : `FBR draft #${i + 1} (tellaskHead: ${head})`;
        }
        if (callId) {
          return language === 'zh'
            ? `FBR 草稿 #${i + 1}（callId: ${callId}）`
            : `FBR draft #${i + 1} (callId: ${callId})`;
        }
        return language === 'zh' ? `FBR 草稿 #${i + 1}` : `FBR draft #${i + 1}`;
      })();
      evidenceParts.push([fbrLabel, capped].join('\n'));
    }
    const evidenceBlock = evidenceParts.length > 0 ? evidenceParts.join('\n\n---\n\n') : '';
    if (!evidenceBlock.trim()) {
      throw new Error(
        'Missing evidence for Agent Priming distillation (snapshot + FBR drafts are empty).',
      );
    }

    const internalPrompt =
      language === 'zh'
        ? [
            '你正在进行智能体启动（Agent Priming）的“综合提炼”步骤。',
            '请基于下方提供的环境快照（以及可选的 `!?@self` FBR 草稿），综合提炼出一条可复用的“智能体启动（Agent Priming）笔记”。',
            '',
            '证据材料（仅供综合提炼；不要逐条复述）：',
            evidenceBlock ? evidenceBlock : '（无）',
            '',
            '重要：只提炼“本次运行环境相关”的结论（例如：OS/架构、shell userland 差异、文件系统、端口/防火墙、全局链接/工具链等）。',
            '禁止：输出元话语、推理过程，或复述实现细节（例如 driver/缓存/持久化等）。',
            '若某条结论无法从环境快照或 FBR 草稿中直接支撑，请省略。',
            '',
            '要求：',
            '- 去重并消解冲突，只保留最关键的结论',
            '- 用 6~12 条 bullet points 输出（每条尽量短）',
            '- 只写结论要点；不要输出推理过程，也不要出现“我在考虑/我将要/让我们检查”等元话语',
          ].join('\n')
        : [
            'You are in the Agent Priming distillation step.',
            'Based on the environment snapshot (and optional `!?@self` FBR drafts) below, distill a reusable “Agent Priming note”.',
            '',
            'Evidence (for distillation only; do not repeat draft-by-draft):',
            evidenceBlock ? evidenceBlock : '(empty)',
            '',
            'Important: output only conclusions about this runtime environment (e.g., OS/arch, shell userland differences, filesystem behavior, ports/firewall, global links/toolchain).',
            'Do NOT include meta talk, reasoning narration, or implementation details (e.g. driver/caching/persistence).',
            'If a point is not directly supported by the environment snapshot or the FBR drafts, omit it.',
            '',
            'Requirements:',
            '- Dedupe and reconcile conflicts; keep only the key conclusions',
            '- Output 6–12 concise bullet points',
            '- Conclusion bullets only; no reasoning narration or meta talk (e.g. “I think / I will / let’s inspect”)',
          ].join('\n');

    // IMPORTANT: this is an internal (non-persisted) prompt. driver.ts will inject it into
    // the LLM context for this drive only, without polluting dialog history.
    await driveDialogStream(
      dlg,
      {
        content: internalPrompt,
        msgId: generateShortId(),
        grammar: 'markdown',
        persistMode: 'internal',
        skipTaskdoc: true,
      },
      true,
    );
    const afterMsgs = dlg.msgs.length;
    if (afterMsgs <= beforeMsgs) {
      throw new Error('Agent Priming distillation produced no new messages.');
    }
    const saying = extractLastAssistantSaying(dlg.msgs).trim();
    if (!saying) {
      throw new Error('Agent Priming distillation produced empty output.');
    }
    return saying;
  } finally {
    dlg.disableDiligencePush = prevDisableDiligencePush;
  }
}

function buildCoursePrefixMsgs(entry: AgentPrimingCacheEntry): ChatMessage[] {
  const language = entry.workLanguage;
  const header = (() => {
    if (language === 'zh') {
      if (entry.shellPolicy === 'specialist_only') {
        return '智能体启动（Agent Priming）上下文：本进程在对话创建时已真实跑通一次“诉请（shell 专员）+ 回传 + `!?@self` FBR + 综合提炼”。以下为压缩转录，作为每一程对话的开头上下文注入。';
      }
      if (entry.shellPolicy === 'no_specialist') {
        return '智能体启动（Agent Priming）上下文：本进程在对话创建时已获取环境快照并完成一次 `!?@self` FBR + 综合提炼（无 shell 专员；不得执行任意 shell 命令）。以下为压缩转录，作为每一程对话的开头上下文注入。';
      }
      return '智能体启动（Agent Priming）上下文：本进程在对话创建时已获取环境快照并完成一次 `!?@self` FBR + 综合提炼。以下为压缩转录，作为每一程对话的开头上下文注入。';
    }

    if (entry.shellPolicy === 'specialist_only') {
      return 'Agent Priming context: this process already ran a real Tellask (shell specialist) + return + `!?@self` FBR + distillation at dialog creation. The condensed transcript below is injected at the start of each course.';
    }
    if (entry.shellPolicy === 'no_specialist') {
      return 'Agent Priming context: this process captured an environment snapshot and ran `!?@self` FBR + distillation at dialog creation (no shell specialist; do not run arbitrary shell commands). The condensed transcript below is injected at the start of each course.';
    }
    return 'Agent Priming context: this process captured an environment snapshot and ran `!?@self` FBR + distillation at dialog creation. The condensed transcript below is injected at the start of each course.';
  })();

  const shellSnapshotLabel =
    language === 'zh'
      ? 'Shell 环境快照（当前 Dominds 运行时；来自 `uname -a`）'
      : 'Shell environment snapshot (current Dominds runtime; `uname -a`)';
  const shellSnapshot = entry.shell.snapshotText.trim()
    ? entry.shell.snapshotText.trim()
    : language === 'zh'
      ? '（无）'
      : '(empty)';

  const effort = Math.max(0, Math.floor(entry.fbr.effort));
  const fbrLabel = language === 'zh' ? 'FBR 输出（摘要）' : 'FBR outputs (summary)';
  const previewCap = Math.min(entry.fbr.responses.length, Math.max(0, Math.min(6, effort)));
  const previewResponses = previewCap > 0 ? entry.fbr.responses.slice(0, previewCap) : [];
  const blocks: string[] = [];
  for (let i = 0; i < previewResponses.length; i++) {
    const raw = previewResponses[i] ?? '';
    const trimmed = raw.trim();
    const cap = 4000;
    const capped =
      trimmed.length <= cap
        ? trimmed
        : language === 'zh'
          ? `${trimmed.slice(0, cap).trimEnd()}\n\n（已截断：仅显示前 ${cap} 字符）`
          : `${trimmed.slice(0, cap).trimEnd()}\n\n(truncated: first ${cap} chars only)`;
    blocks.push(
      language === 'zh'
        ? [`### FBR 草稿 #${i + 1}`, '', capped || '（无）'].join('\n')
        : [`### FBR draft #${i + 1}`, '', capped || '(empty)'].join('\n'),
    );
  }
  const fbrPreview =
    effort < 1
      ? language === 'zh'
        ? '（已跳过：已禁用）'
        : '(skipped: disabled)'
      : blocks.length < 1
        ? language === 'zh'
          ? '（无）'
          : '(empty)'
        : blocks.join('\n\n---\n\n');

  const priming = entry.primingNote.trim();

  const out: ChatMessage[] = [
    { type: 'transient_guide_msg', role: 'assistant', content: header },
    {
      type: 'environment_msg',
      role: 'user',
      content: `${shellSnapshotLabel}:\n\n${shellSnapshot}`,
    },
    {
      type: 'environment_msg',
      role: 'user',
      content:
        language === 'zh' ? `${fbrLabel}:\n\n${fbrPreview}` : `${fbrLabel}:\n\n${fbrPreview}`,
    },
  ];

  if (entry.shell.kind === 'specialist_tellask') {
    const fullReturn = entry.shell.responseText.trim();
    const snapshot = entry.shell.snapshotText.trim();
    if (fullReturn && fullReturn !== snapshot) {
      out.push({
        type: 'environment_msg',
        role: 'user',
        content:
          language === 'zh'
            ? `Shell 反馈（完整回传）：\n\n${fullReturn}`
            : `Shell feedback (full return):\n\n${fullReturn}`,
      });
    }
  }

  if (priming) {
    out.push({
      type: 'environment_msg',
      role: 'user',
      content:
        language === 'zh'
          ? `智能体启动（Agent Priming）笔记（综合提炼）：\n\n${priming}`
          : `Agent Priming note (distilled):\n\n${priming}`,
    });
  }

  return out;
}

async function replayAgentPriming(dlg: Dialog, entry: AgentPrimingCacheEntry): Promise<void> {
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
      await emitUiOnlyMarkdownEventsAndPersist(
        dlg,
        formatPreludeIntro(
          language,
          true,
          entry.shellPolicy,
          entry.shell.kind === 'specialist_tellask' ? entry.shell.specialistId : null,
        ),
      );

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
        dlg.id,
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
    const effort = Math.max(0, Math.floor(entry.fbr.effort));
    if (effort >= 1 && entry.fbr.responses.length > 0) {
      try {
        await dlg.notifyGeneratingStart();
        const fbrCallBody = [entry.fbr.selfTeaser, '', entry.fbr.tellaskBody].join('\n');
        const fbrCallContent = [
          '!?@self',
          ...prefixTellaskBodyLines(fbrCallBody).split('\n'),
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

      // Phase 4: FBR responses (separate bubbles, in stable index order)
      if (fbrCallId && fbrTellaskHead) {
        const normalized = Math.max(1, effort);
        const responses = entry.fbr.responses.slice(0, normalized);
        for (let i = 0; i < responses.length; i++) {
          const raw = responses[i] ?? '';
          await dlg.receiveTeammateResponse(
            entry.fbr.responderAgentId,
            fbrTellaskHead,
            'completed',
            dlg.id,
            {
              response: raw,
              agentId: entry.fbr.responderAgentId,
              callId: fbrCallId,
              originMemberId: dlg.agentId,
            },
          );
        }
      }
    }

    // Phase 5: summary bubble
    try {
      await dlg.notifyGeneratingStart();
      await emitSayingEventsAndPersist(dlg, entry.primingNote);
    } finally {
      try {
        await dlg.notifyGeneratingFinish();
      } catch (_finishErr) {
        // best-effort
      }
    }
  } catch (err) {
    log.warn('Agent Priming replay failed (best-effort)', err, { dialogId: dlg.id.valueOf() });
  } finally {
    let nextIdle: DialogRunState = { kind: 'idle_waiting_user' };
    try {
      nextIdle = await computeIdleRunState(dlg);
    } catch (err: unknown) {
      log.warn('Failed to compute idle runState after Agent Priming replay; falling back', err, {
        dialogId: dlg.id.valueOf(),
      });
    }
    await setDialogRunState(dlg.id, nextIdle);
    release();
  }
}

async function runAgentPrimingLive(dlg: Dialog): Promise<AgentPrimingCacheEntry> {
  const createdAt = formatUnifiedTimestamp(new Date());
  const language = getWorkLanguage();
  let fatalRunState: DialogRunState | null = null;
  let shellPolicy: AgentPrimingCacheEntry['shellPolicy'] = 'no_specialist';
  let specialistId: string | null = null;
  let shellTellaskBody = '';
  let shellResponseText = '';
  let snapshotText = '';
  let directNoteMarkdown = '';
  let fbrCallBody = '';
  let selfTeaser = '';
  let fbrEffort = 0;
  const fbrResponsesForCache: string[] = [];
  const fbrResponsesForInjection: Array<{ subdialogId: string; response: string }> = [];
  try {
    await setDialogRunState(dlg.id, { kind: 'proceeding' });

    const team = await Team.load();
    const member = team.getMember(dlg.agentId);
    const specialists = team.shellSpecialists
      .filter((s): s is string => typeof s === 'string')
      .map((s) => s.trim())
      .filter((s) => s !== '');
    const selfIsShellSpecialist = specialists.includes(dlg.agentId);
    specialistId = specialists.find((s) => s !== dlg.agentId) ?? null;
    shellPolicy =
      specialists.length < 1
        ? 'no_specialist'
        : selfIsShellSpecialist
          ? 'self_is_specialist'
          : 'specialist_only';

    shellTellaskBody = formatShellTellaskBody(language, specialistId);
    let shellCallId: string | null = null;
    let shellTellaskHead: string | null = null;
    let shellTellaskBodyForSubdialog: string | null = null;

    // Phase 1: shell ask (and optional prelude intro)
    if (shellPolicy === 'specialist_only' && specialistId !== null) {
      await dlg.withLock(async () => {
        try {
          await dlg.notifyGeneratingStart();
          await emitUiOnlyMarkdownEventsAndPersist(
            dlg,
            formatPreludeIntro(language, false, shellPolicy, specialistId),
          );

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
        } finally {
          try {
            await dlg.notifyGeneratingFinish();
          } catch (_finishErr) {
            // best-effort
          }
        }
      });
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
            ? ['由 Dominds 运行时执行：`uname -a`', '', '```console', unameOutput, '```', ''].join(
                '\n',
              )
            : ['Dominds runtime ran: `uname -a`', '', '```console', unameOutput, '```', ''].join(
                '\n',
              );
        }
        return language === 'zh'
          ? [
              '未配置 shell 专员：由 Dominds 运行时仅执行基线命令 `uname -a` 以获取环境快照。',
              '约束：后续**不得执行任意 shell 命令**；只能通过文件读写等非 shell 工具推进。',
              '',
              '```console',
              unameOutput,
              '```',
              '',
            ].join('\n')
          : [
              'No shell specialist configured: Dominds runtime ran only the baseline command `uname -a` to capture an environment snapshot.',
              'Constraint: do **not** run arbitrary shell commands; proceed only with non-shell tools like file read/write.',
              '',
              '```console',
              unameOutput,
              '```',
              '',
            ].join('\n');
      })();
      directNoteMarkdown = directNote;

      await dlg.withLock(async () => {
        try {
          await dlg.notifyGeneratingStart();
          await emitUiOnlyMarkdownEventsAndPersist(
            dlg,
            formatPreludeIntro(language, false, shellPolicy, specialistId),
          );
          await emitSayingEventsAndPersist(dlg, directNoteMarkdown);
        } finally {
          try {
            await dlg.notifyGeneratingFinish();
          } catch (_finishErr) {
            // best-effort
          }
        }
      });
    }

    // Phase 2: shell response (separate bubble)
    if (
      shellPolicy === 'specialist_only' &&
      specialistId !== null &&
      shellCallId &&
      shellTellaskHead
    ) {
      const ensuredSpecialistId = specialistId;
      if (ensuredSpecialistId === null) {
        throw new Error('Missing shell specialist id');
      }
      const ensuredShellCallId = shellCallId;
      if (!ensuredShellCallId) {
        throw new Error('Missing shell callId');
      }
      const ensuredShellTellaskHead = shellTellaskHead;
      if (!ensuredShellTellaskHead) {
        throw new Error('Missing shell tellaskHead');
      }
      const tellaskBody = shellTellaskBodyForSubdialog ?? shellTellaskBody;
      const sub = await dlg.withLock(async () => {
        return await dlg.createSubDialog(
          ensuredSpecialistId,
          ensuredShellTellaskHead,
          tellaskBody,
          {
            originMemberId: dlg.agentId,
            callerDialogId: dlg.id.selfId,
            callId: ensuredShellCallId,
            collectiveTargets: [ensuredSpecialistId],
          },
        );
      });

      const initPrompt = formatAssignmentFromSupdialog({
        fromAgentId: dlg.agentId,
        toAgentId: sub.agentId,
        tellaskHead: ensuredShellTellaskHead,
        tellaskBody,
        language,
        collectiveTargets: [ensuredSpecialistId],
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

      await dlg.withLock(async () => {
        await dlg.receiveTeammateResponse(
          ensuredSpecialistId,
          ensuredShellTellaskHead,
          'completed',
          sub.id,
          {
            response: shellResponseText,
            agentId: ensuredSpecialistId,
            callId: ensuredShellCallId,
            originMemberId: dlg.agentId,
          },
        );
      });
    }

    const rawFbrEffort = member ? member.fbr_effort : undefined;
    fbrEffort = (() => {
      if (typeof rawFbrEffort !== 'number' || !Number.isFinite(rawFbrEffort)) return 3;
      const n = Math.floor(rawFbrEffort);
      if (n < 0) return 0;
      if (n > 100) {
        throw new Error('Invalid fbr_effort: must be <= 100');
      }
      return n;
    })();

    fbrCallBody = formatFbrTellaskBody(language, snapshotText, { fbrEffort });
    selfTeaser = formatFbrSelfTeaser(language);
    let fbrCallId: string | null = null;
    let fbrTellaskHead: string | null = null;

    // Phase 3: FBR ask (call bubble)
    if (fbrEffort >= 1) {
      await dlg.withLock(async () => {
        try {
          await dlg.notifyGeneratingStart();
          const fbrSaying = [
            selfTeaser,
            '',
            '!?@self',
            ...prefixTellaskBodyLines(fbrCallBody).split('\n'),
            '',
          ].join('\n');
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
      });

      // Phase 4: FBR responses (separate bubbles; order is not meaningful)
      if (!fbrCallId || !fbrTellaskHead) {
        throw new Error('Missing FBR callId/tellaskHead');
      }
      const ensuredFbrCallId = fbrCallId;
      const ensuredFbrTellaskHead = fbrTellaskHead;

      const perInstance = Array.from({ length: fbrEffort }, (_, idx) => idx + 1);
      const created = await Promise.all(
        perInstance.map(async (i) => {
          const instanceBody =
            fbrEffort > 1
              ? [
                  fbrCallBody,
                  '',
                  language === 'zh'
                    ? '提示：请尽量提供与其它 FBR 草稿不同的视角（例如安全/限制/可验证性/风险点）。'
                    : 'Hint: try to provide a distinct angle vs other FBR drafts (e.g. security/constraints/verifiability/risk).',
                ].join('\n')
              : fbrCallBody;

          const sub = await dlg.withLock(async () => {
            return await dlg.createSubDialog(dlg.agentId, ensuredFbrTellaskHead, instanceBody, {
              originMemberId: dlg.agentId,
              callerDialogId: dlg.id.selfId,
              callId: ensuredFbrCallId,
              collectiveTargets: [dlg.agentId],
            });
          });

          const initPrompt = formatAssignmentFromSupdialog({
            fromAgentId: dlg.agentId,
            toAgentId: sub.agentId,
            tellaskHead: ensuredFbrTellaskHead,
            tellaskBody: instanceBody,
            language,
            collectiveTargets: [dlg.agentId],
          });

          await driveDialogStream(
            sub,
            { content: initPrompt, msgId: generateShortId(), grammar: 'markdown' },
            true,
          );

          const responseText = extractLastAssistantSaying(sub.msgs);
          return { sub, responseText };
        }),
      );

      for (const r of created) {
        const responseText = r.responseText;
        fbrResponsesForCache.push(responseText);
        fbrResponsesForInjection.push({ subdialogId: r.sub.id.selfId, response: responseText });
        await dlg.withLock(async () => {
          await dlg.receiveTeammateResponse(
            dlg.agentId,
            ensuredFbrTellaskHead,
            'completed',
            r.sub.id,
            {
              response: responseText,
              agentId: dlg.agentId,
              callId: ensuredFbrCallId,
              originMemberId: dlg.agentId,
            },
          );
        });
      }
    }

    if (!fbrCallId || !fbrTellaskHead) {
      if (fbrEffort >= 1) {
        throw new Error('Missing FBR callId/tellaskHead for Agent Priming distillation.');
      }
      // FBR disabled (fbr_effort == 0): distill from shell snapshot only.
      fbrCallId = '';
      fbrTellaskHead = '@self';
    }
    const primingNote = await generatePrimingNoteViaMainlineAgent({
      dlg,
      shellSnapshotText: snapshotText,
      shellResponseText: shellResponseText,
      fbrResponses: fbrResponsesForInjection,
      fbrTellaskHead: fbrTellaskHead,
      fbrCallId: fbrCallId,
    });

    const entry: AgentPrimingCacheEntry = {
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
        tellaskBody: fbrCallBody,
        selfTeaser,
        responderAgentId: dlg.agentId,
        effort: fbrEffort,
        responses: fbrResponsesForCache,
      },
      primingNote,
    };

    await dlg.withLock(async () => {
      dlg.setCoursePrefixMsgs(buildCoursePrefixMsgs(entry));
    });
    return entry;
  } catch (err) {
    const errText = err instanceof Error ? (err.stack ?? err.message) : String(err);
    const errTextTrimmed = errText.trim().slice(0, 4000);
    fatalRunState = {
      kind: 'interrupted',
      reason: { kind: 'system_stop', detail: `Agent Priming failed: ${errTextTrimmed}` },
    };
    log.warn('Agent Priming live run failed (fatal)', err, { dialogId: dlg.id.valueOf() });
    const msg =
      language === 'zh'
        ? [
            '错误：智能体启动（Agent Priming）失败；无法继续对话。',
            '',
            '根因（详细信息）：',
            '```text',
            errTextTrimmed,
            '```',
          ].join('\n')
        : [
            'Error: Agent Priming failed; cannot continue this dialog.',
            '',
            'Root cause (details):',
            '```text',
            errTextTrimmed,
            '```',
          ].join('\n');
    try {
      await dlg.withLock(async () => {
        await dlg.notifyGeneratingStart();
        await emitSayingEventsAndPersist(dlg, msg);
        await dlg.notifyGeneratingFinish();
      });
    } catch (_emitErr) {
      // best-effort
    }
    throw err;
  } finally {
    if (fatalRunState) {
      await setDialogRunState(dlg.id, fatalRunState);
    } else {
      let nextIdle: DialogRunState = { kind: 'idle_waiting_user' };
      try {
        nextIdle = await computeIdleRunState(dlg);
      } catch (err: unknown) {
        log.warn(
          'Failed to compute idle runState after Agent Priming live run; falling back',
          err,
          {
            dialogId: dlg.id.valueOf(),
          },
        );
      }
      await setDialogRunState(dlg.id, nextIdle);
    }
  }
}
