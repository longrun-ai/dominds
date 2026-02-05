/**
 * Module: agent-priming
 *
 * Best-effort Agent Priming prelude generation for new dialogs.
 */
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
    responderAgentId: string;
    effort: number;
    responses: ReadonlyArray<string>;
  }>;
  primingNote: string;
}>;

const BASELINE_ENV_SNAPSHOT_CMD = 'uname -a';

const cacheByAgentId: Map<string, AgentPrimingCacheEntry> = new Map();
const inflightByAgentId: Map<string, Promise<AgentPrimingCacheEntry>> = new Map();

export type AgentPrimingCacheStatus = Readonly<
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
      log.warn('Failed to persist Agent Priming synthetic saying content (best-effort)', err, {
        dialogId: dlg.id.valueOf(),
        genseq,
      });
    }
  }
  return calls;
}

async function emitUiOnlyMarkdownEventsAndPersist(dlg: RootDialog, content: string): Promise<void> {
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

export function scheduleAgentPrimingForNewDialog(
  dlg: RootDialog,
  options: { mode: 'do' | 'reuse' | 'skip' },
): void {
  if (options.mode === 'skip') return;

  const agentId = dlg.agentId;
  const existing = cacheByAgentId.get(agentId);
  if (options.mode === 'reuse' && existing) {
    dlg.setCoursePrefixMsgs(buildCoursePrefixMsgs(existing));
    void replayAgentPriming(dlg, existing);
    return;
  }

  const inflight = inflightByAgentId.get(agentId);
  if (inflight) {
    void inflight.then((entry) => {
      if (options.mode === 'reuse') {
        dlg.setCoursePrefixMsgs(buildCoursePrefixMsgs(entry));
        return replayAgentPriming(dlg, entry);
      }
      // mode === 'do': wait for in-flight then run again for this dialog.
      return runAgentPrimingLive(dlg).then((next) => {
        cacheByAgentId.set(agentId, next);
      });
    });
    return;
  }

  const task = runAgentPrimingLive(dlg)
    .then((entry) => {
      cacheByAgentId.set(agentId, entry);
      return entry;
    })
    .catch((err: unknown) => {
      log.warn('Agent Priming live run failed; will retry on next dialog', err, {
        agentId,
      });
      throw err;
    })
    .finally(() => {
      inflightByAgentId.delete(agentId);
    });
  inflightByAgentId.set(agentId, task);
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

function shuffleCopy<T>(items: ReadonlyArray<T>): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i >= 1; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
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
): string {
  const shellPolicyLinesZh: string[] =
    shellPolicy === 'specialist_only'
      ? [
          '规则：此智能体**不执行任何 shell 命令**。所有 shell 命令必须通过 `shell_specialist` 执行并回传。',
          '下面将诉请 shell 专员仅执行一个低风险命令：`uname -a`。',
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
        'This prelude makes Tellask + return + FBR + synthesis feel real (guiding the agent to show it to itself).',
        'This dialog reused the in-process cache (no commands were re-run).',
        '',
        ...shellPolicyLinesEn,
        '',
      ].join('\n')
    : [
        '## Prelude: Agent Priming',
        '',
        'This prelude makes Tellask + return + FBR + synthesis feel real (guiding the agent to show it to itself).',
        '',
        ...shellPolicyLinesEn,
        '',
      ].join('\n');
}

function formatShellTellaskBody(language: LanguageCode): string {
  if (language === 'zh') {
    return [
      '你是 shell 专员：请代我执行 `uname -a` 获取当前运行环境的基本信息。',
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
  shellPolicy: AgentPrimingCacheEntry['shellPolicy'],
  options: { fbrEffort: number },
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

  const fbrEffort = Math.max(0, Math.floor(options.fbrEffort));
  const effortLineZh =
    fbrEffort >= 1
      ? `运行时提示：本次 FBR 的努力倍数为 ${fbrEffort}（fbr-effort=${fbrEffort}）。运行时会生成多份“初心自我”独立推理草稿，供上游对话综合提炼（这些草稿之间没有稳定映射关系，不要把它们当作固定身份）。请给出你这一份独立分析。`
      : '运行时提示：本成员已禁用 FBR（fbr-effort=0）。';
  const effortLineEn =
    fbrEffort >= 1
      ? `Runtime note: FBR effort multiplier is ${fbrEffort} (fbr-effort=${fbrEffort}). The runtime will generate multiple independent “fresh boots” drafts for the upstream dialog to synthesize (no stable mapping—do not treat them as fixed identities). Please produce your own independent analysis.`
      : 'Runtime note: FBR is disabled for this member (fbr-effort=0).';

  const askBackHintZh = (() => {
    if (shellPolicy === 'specialist_only') {
      return [
        '提示：如果你还想知道更多系统细节（`uname -a` 之外），可在本 FBR 支线对话中用 `!?@tellasker` 回问诉请者（上游对话）。',
        '诉请者可据此选择不违反安全协议的命令，并交由 `shell_specialist` 执行回传。',
        '（当前这次 FBR 请不要真的发起任何诉请；只需说明你会回问什么。）',
      ].join('\n');
    }
    if (shellPolicy === 'no_specialist') {
      return [
        '提示：如果你还想知道更多系统细节（`uname -a` 之外），可在本 FBR 支线对话中用 `!?@tellasker` 回问诉请者（上游对话）补充信息。',
        '注意：本团队无 `shell_specialist`，因此仍然**不得执行任意 shell 命令**；只能请求补充文本材料（文件片段/日志/配置/运行报错等）。',
        '（当前这次 FBR 请不要真的发起任何诉请；只需说明你会回问什么。）',
      ].join('\n');
    }
    return [
      '提示：如果你还想知道更多系统细节（`uname -a` 之外），可在本 FBR 支线对话中用 `!?@tellasker` 回问诉请者（上游对话）。',
      '（当前这次 FBR 请不要真的发起任何诉请；只需说明你会回问什么。）',
    ].join('\n');
  })();

  const askBackHintEn = (() => {
    if (shellPolicy === 'specialist_only') {
      return [
        'Hint: if you want more system details beyond `uname -a`, ask back in this FBR sideline dialog via `!?@tellasker` (to the upstream tellasker dialog).',
        'Then the tellasker can choose safety-compliant follow-up commands and have a `shell_specialist` run and return them.',
        '(In this FBR run, do not actually emit any tellasks; just state what you would ask back.)',
      ].join('\n');
    }
    if (shellPolicy === 'no_specialist') {
      return [
        'Hint: if you want more system details beyond `uname -a`, ask back in this FBR sideline dialog via `!?@tellasker` (to the upstream tellasker dialog).',
        'Note: there is no `shell_specialist` in this team, so do **not** run arbitrary shell commands; request additional text materials only (file snippets/logs/configs/errors).',
        '(In this FBR run, do not actually emit any tellasks; just state what you would ask back.)',
      ].join('\n');
    }
    return [
      'Hint: if you want more system details beyond `uname -a`, ask back in this FBR sideline dialog via `!?@tellasker` (to the upstream tellasker dialog).',
      '(In this FBR run, do not actually emit any tellasks; just state what you would ask back.)',
    ].join('\n');
  })();

  if (language === 'zh') {
    return [
      '你正在进行一次“扪心自问”（FBR）。你**没有任何工具**：不能调用工具，只能使用本文本推理。',
      effortLineZh,
      '',
      askBackHintZh,
      '',
      '请基于下面环境信息回答：',
      '- 在这个环境里要注意些什么？',
      '- 优先利用哪些命令行工具，为什么？',
      '',
      `环境信息（当前 Dominds 运行时真实环境快照；来自命令：\`${snapshotCmd}\`）：`,
      snapshotText,
      shellPolicyTailZh,
    ].join('\n');
  }
  return [
    'You are doing Fresh Boots Reasoning (FBR). You have **no tools**: do not call tools; reason with text only.',
    effortLineEn,
    '',
    askBackHintEn,
    '',
    'Based on the environment info below, answer:',
    '- What should we watch out for in this environment?',
    '- Which CLI tools should we prioritize, and why?',
    '',
    `Environment info (a real snapshot of the current Dominds runtime; from \`${snapshotCmd}\`):`,
    snapshotText,
    shellPolicyTailEn,
  ].join('\n');
}

function formatPrimingNoteFallback(
  language: LanguageCode,
  unameLine: string | null,
  shellPolicy: AgentPrimingCacheEntry['shellPolicy'],
): string {
  const header = language === 'zh' ? '## 智能体启动（Agent Priming）' : '## Agent Priming';
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
  const unameSectionLabel = language === 'zh' ? '`uname -a`（摘要）' : '`uname -a` (summary)';
  const unameBlock = unameLine
    ? ['```console', unameLine, '```'].join('\n')
    : language === 'zh'
      ? '_（未能提取单行摘要；详见上文输出）_'
      : '_(Failed to extract a single-line summary; see output above.)_';

  return [
    header,
    '',
    policyNote ? `${policyNote}\n` : '',
    `${unameSectionLabel}:`,
    unameBlock,
    '',
    language === 'zh'
      ? '（综合提炼未生成；请参考上文 FBR 草稿并自行综合。）'
      : '(Synthesis unavailable; please refer to the FBR drafts above and synthesize manually.)',
  ].join('\n');
}

function truncateLines(text: string, maxLines: number, maxChars: number): string {
  const normalized = text.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const slice = lines.slice(0, Math.max(1, maxLines)).join('\n');
  if (slice.length <= maxChars) return slice;
  return slice.slice(0, Math.max(0, maxChars)).trimEnd();
}

function formatPrimingSynthesisPrompt(options: {
  language: LanguageCode;
  snapshotCmd: string;
  snapshotText: string;
  fbrEffort: number;
  fbrDrafts: ReadonlyArray<string>;
  shellPolicy: AgentPrimingCacheEntry['shellPolicy'];
}): string {
  const { language, snapshotCmd, snapshotText, fbrEffort, fbrDrafts, shellPolicy } = options;
  const normalizedEffort = Math.max(0, Math.floor(fbrEffort));
  const drafts = shuffleCopy([...fbrDrafts])
    .map((d) => truncateLines(d, 80, 8000))
    .filter((d) => d.trim() !== '');

  const snapshotBlock = snapshotText.trim();
  const draftsBlock =
    drafts.length < 1
      ? language === 'zh'
        ? '（无 FBR 草稿；可能是 fbr-effort=0 或生成失败。）'
        : '(No FBR drafts; likely fbr-effort=0 or generation failed.)'
      : drafts.join('\n\n---\n\n');

  const policyLineZh =
    shellPolicy === 'specialist_only'
      ? '约束：此智能体**不执行任何 shell 命令**；所有 shell 命令必须诉请 `shell_specialist` 执行并回传。'
      : shellPolicy === 'no_specialist'
        ? '约束：本团队无 `shell_specialist`，因此后续**不能执行任意 shell 命令**；只能通过文件读写等非 shell 工具推进。'
        : '约束：本次对话主理人属于 `shell_specialists`，后续 shell 相关操作仍需遵循安全协议与最小风险原则。';

  const policyLineEn =
    shellPolicy === 'specialist_only'
      ? 'Constraint: this agent must **not run any shell commands**; all shell commands must be executed by a `shell_specialist` and returned.'
      : shellPolicy === 'no_specialist'
        ? 'Constraint: there is no `shell_specialist` in this team, so we must **not run arbitrary shell commands**; proceed only with non-shell tools like file read/write.'
        : 'Constraint: the dialog owner is a member of `shell_specialists`; any shell work must still follow the safety protocol and minimize risk.';

  if (language === 'zh') {
    return [
      '请你作为主线对话主理人，基于下面材料，生成一条短而可复用的“智能体启动（Agent Priming）”笔记。',
      '要求：',
      '- 使用 Markdown；以 `## 智能体启动（Agent Priming）` 开头。',
      '- 明确提及本次环境快照来自命令：`' + snapshotCmd + '`（未来可能更换命令，不能靠猜）。',
      '- 引导理解：这就是当前 Dominds 的**真实运行环境**，不是“某台机器”的抽象例子。',
      '- 强调 shell 策略约束（见下）；不要暗示“自己在本地跑一下”。',
      '- “综合提炼”：从多份 FBR 草稿中取精华、去糟粕，去重/消冲突，避免逐条复述每份草稿。',
      '- 不要使用序号/编号列表（顺序不重要）；可用少量无序 bullet。',
      '- 不要在行首输出 `!?@...`（避免被解析为真实诉请）。如果必须提及语法，请放在行内反引号里。',
      '',
      policyLineZh,
      '',
      `环境快照（来自 \`${snapshotCmd}\`）：`,
      snapshotBlock,
      '',
      `FBR 草稿（努力倍数=fbr-effort=${normalizedEffort}；草稿匿名且无稳定映射关系）：`,
      draftsBlock,
    ].join('\n');
  }

  return [
    'As the mainline dialog owner, use the materials below to generate a short, reusable “Agent Priming” note.',
    'Requirements:',
    '- Markdown; start with `## Agent Priming`.',
    '- Explicitly mention the snapshot command: `' +
      snapshotCmd +
      '` (do not rely on “obviousness”; the command may change).',
    '- Treat this as the **real Dominds runtime environment**, not a hypothetical “some machine”.',
    '- Emphasize the shell policy constraint (below); do not suggest “just run it locally”.',
    '- Synthesize: extract the best from multiple FBR drafts (dedupe, reconcile conflicts) instead of repeating each draft.',
    '- Avoid numbered lists (order does not matter); keep it short with a few unordered bullets.',
    '- Do not output `!?@...` at the start of a line (avoid being parsed as a real Tellask). If you must mention the syntax, keep it inline in backticks.',
    '',
    policyLineEn,
    '',
    `Environment snapshot (from \`${snapshotCmd}\`):`,
    snapshotBlock,
    '',
    `FBR drafts (effort multiplier / fbr-effort=${normalizedEffort}; anonymous with no stable mapping):`,
    draftsBlock,
  ].join('\n');
}

async function generatePrimingNoteViaMainlineAgent(options: {
  dlg: RootDialog;
  snapshotCmd: string;
  snapshotText: string;
  fbrResponses: ReadonlyArray<string>;
  shellPolicy: AgentPrimingCacheEntry['shellPolicy'];
  fbrEffort: number;
}): Promise<string> {
  const { dlg, snapshotCmd, snapshotText, fbrResponses, shellPolicy, fbrEffort } = options;
  const language = getWorkLanguage();

  try {
    // Use the normal dialog driver (streaming/non-streaming selection, retries, etc.) with a
    // toolless `@self` subdialog, so this behavior matches the runtime driver with no local drift.
    //
    // Tool-less is important here: the Agent Priming synthesis must be a pure text transform of
    // snapshot + drafts, and must not run tools (including any mind-edit tools).
    const prompt = formatPrimingSynthesisPrompt({
      language,
      snapshotCmd,
      snapshotText,
      fbrEffort,
      fbrDrafts: fbrResponses,
      shellPolicy,
    });

    const tellaskHead = '@self (agent priming synthesis)';
    const tellaskBody = prompt;

    const sub = await dlg.createSubDialog(dlg.agentId, tellaskHead, tellaskBody, {
      originMemberId: dlg.agentId,
      callerDialogId: dlg.id.selfId,
      callId: generateShortId(),
      collectiveTargets: [dlg.agentId],
    });

    const initPrompt = formatAssignmentFromSupdialog({
      fromAgentId: dlg.agentId,
      toAgentId: sub.agentId,
      tellaskHead,
      tellaskBody,
      language,
      collectiveTargets: [dlg.agentId],
    });

    await driveDialogStream(
      sub,
      { content: initPrompt, msgId: generateShortId(), grammar: 'markdown' },
      true,
    );

    const saying = extractLastAssistantSaying(sub.msgs).trim();
    if (saying) {
      return saying;
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    // Do not silently fall back for known severe configuration errors (e.g. Codex requires
    // streaming=true).
    if (message.includes('apiType=codex requires streaming=true')) {
      throw err;
    }
    log.warn('Failed to generate Agent Priming note via mainline agent (best-effort)', err, {
      dialogId: dlg.id.valueOf(),
    });
  }

  const unameLine = takeFirstNonEmptyLine(snapshotText);
  return formatPrimingNoteFallback(language, unameLine, shellPolicy);
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
      return 'Agent Priming context: this process already ran a real Tellask (shell staff) + return + `!?@self` FBR + synthesis at dialog creation. The condensed transcript below is injected at the start of each course.';
    }
    if (entry.shellPolicy === 'no_specialist') {
      return 'Agent Priming context: this process captured an environment snapshot and ran `!?@self` FBR + synthesis at dialog creation (no shell staff; do not run arbitrary shell commands). The condensed transcript below is injected at the start of each course.';
    }
    return 'Agent Priming context: this process captured an environment snapshot and ran `!?@self` FBR + synthesis at dialog creation. The condensed transcript below is injected at the start of each course.';
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
  const fbrLabel =
    language === 'zh'
      ? `FBR 输出（摘要；努力倍数=${effort}，fbr-effort=${effort}）`
      : `FBR outputs (summary; effort×${effort}, fbr-effort=${effort})`;
  const previewCap = Math.max(1, effort);
  const shuffledResponses = shuffleCopy(entry.fbr.responses);
  const previewResponses = shuffledResponses.slice(0, previewCap);
  const blocks: string[] = [];
  for (let i = 0; i < previewResponses.length; i++) {
    const raw = previewResponses[i] ?? '';
    const lines = raw.replace(/\r\n/g, '\n').split('\n');
    const preview = lines.slice(0, 12).join('\n').trim();
    blocks.push(preview ? preview : language === 'zh' ? '（无）' : '(empty)');
  }
  const fbrPreview =
    previewResponses.length < 1
      ? language === 'zh'
        ? '（已跳过：fbr-effort=0）'
        : '(skipped: fbr-effort=0)'
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
      type: 'transient_guide_msg',
      role: 'assistant',
      content:
        language === 'zh'
          ? `${fbrLabel}:\n\n说明：以下为多份独立初心推理草稿（努力倍数=fbr-effort=${effort}）。可能重复/冲突；主线对话应综合提炼，取各自精华、去各自糟粕，避免逐条复述。\n\n${fbrPreview}`
          : `${fbrLabel}:\n\nNote: below are multiple independent FBR drafts (effort multiplier / fbr-effort=${effort}). They may overlap or conflict; the mainline dialog should synthesize (dedupe, reconcile, and extract the best), rather than repeating each draft.\n\n${fbrPreview}`,
    },
  ];

  if (priming) {
    out.push({ type: 'environment_msg', role: 'user', content: priming });
  }

  return out;
}

async function replayAgentPriming(dlg: RootDialog, entry: AgentPrimingCacheEntry): Promise<void> {
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
        formatPreludeIntro(language, true, entry.shellPolicy),
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
    const effort = Math.max(0, Math.floor(entry.fbr.effort));
    if (effort >= 1 && entry.fbr.responses.length > 0) {
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

      // Phase 4: FBR responses (separate bubbles, in stable index order)
      if (fbrCallId && fbrTellaskHead) {
        const normalized = Math.max(1, effort);
        const responses = shuffleCopy(entry.fbr.responses).slice(0, normalized);
        for (let i = 0; i < responses.length; i++) {
          const raw = responses[i] ?? '';
          await dlg.receiveTeammateResponse(
            entry.fbr.responderAgentId,
            fbrTellaskHead,
            'completed',
            undefined,
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

async function runAgentPrimingLive(dlg: RootDialog): Promise<AgentPrimingCacheEntry> {
  const release = await dlg.acquire();
  const createdAt = formatUnifiedTimestamp(new Date());
  const language = getWorkLanguage();
  try {
    await setDialogRunState(dlg.id, { kind: 'proceeding' });

    const team = await Team.load();
    const member = team.getMember(dlg.agentId);
    const specialists = team.shellSpecialists
      .filter((s): s is string => typeof s === 'string')
      .map((s) => s.trim())
      .filter((s) => s !== '');
    const selfIsShellSpecialist = specialists.includes(dlg.agentId);
    const specialistId = specialists.find((s) => s !== dlg.agentId) ?? null;
    const shellPolicy: AgentPrimingCacheEntry['shellPolicy'] =
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
      await emitUiOnlyMarkdownEventsAndPersist(
        dlg,
        formatPreludeIntro(language, false, shellPolicy),
      );

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

    const rawFbrEffort = member ? member.fbr_effort : undefined;
    const fbrEffort = (() => {
      if (typeof rawFbrEffort !== 'number' || !Number.isFinite(rawFbrEffort)) return 3;
      const n = Math.floor(rawFbrEffort);
      if (n < 0) return 0;
      if (n > 100) return 100;
      return n;
    })();

    const snapshotBody = formatFbrTellaskBody(
      language,
      BASELINE_ENV_SNAPSHOT_CMD,
      snapshotText,
      shellPolicy,
      { fbrEffort },
    );
    let fbrCallId: string | null = null;
    let fbrTellaskHead: string | null = null;
    const fbrResponses: string[] = [];

    // Phase 3: FBR ask (call bubble)
    if (fbrEffort >= 1) {
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

      // Phase 4: FBR responses (separate bubbles, stable index order)
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
                  snapshotBody,
                  '',
                  language === 'zh'
                    ? '提示：请尽量提供与其它 FBR 草稿不同的视角（例如安全/限制/可验证性/工具优先级/风险点）。'
                    : 'Hint: try to provide a distinct angle vs other FBR drafts (e.g. security/constraints/verifiability/tool priority/risk).',
                ].join('\n')
              : snapshotBody;

          const sub = await dlg.createSubDialog(dlg.agentId, ensuredFbrTellaskHead, instanceBody, {
            originMemberId: dlg.agentId,
            callerDialogId: dlg.id.selfId,
            callId: ensuredFbrCallId,
            collectiveTargets: [dlg.agentId],
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

      const shuffled = shuffleCopy(created);
      for (const r of shuffled) {
        const responseText = r.responseText;
        fbrResponses.push(responseText);
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
      }
    }

    const primingNote = await generatePrimingNoteViaMainlineAgent({
      dlg,
      snapshotCmd: BASELINE_ENV_SNAPSHOT_CMD,
      snapshotText,
      fbrResponses,
      shellPolicy,
      fbrEffort,
    });
    // Phase 5: summary bubble
    try {
      await dlg.notifyGeneratingStart();
      await emitSayingEventsAndPersist(dlg, primingNote);
    } finally {
      try {
        await dlg.notifyGeneratingFinish();
      } catch (_finishErr) {
        // best-effort
      }
    }

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
        tellaskBody: snapshotBody,
        responderAgentId: dlg.agentId,
        effort: fbrEffort,
        responses: fbrResponses,
      },
      primingNote,
    };

    dlg.setCoursePrefixMsgs(buildCoursePrefixMsgs(entry));
    return entry;
  } catch (err) {
    log.warn('Agent Priming live run failed (best-effort)', err, { dialogId: dlg.id.valueOf() });
    const msg =
      language === 'zh'
        ? '智能体启动（Agent Priming）序幕执行失败（已跳过）。你可以继续正常对话。'
        : 'Agent Priming prelude failed (skipped). You can continue normally.';
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
      log.warn('Failed to compute idle runState after Agent Priming live run; falling back', err, {
        dialogId: dlg.id.valueOf(),
      });
    }
    await setDialogRunState(dlg.id, nextIdle);
    release();
  }
}
