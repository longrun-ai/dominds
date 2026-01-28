/**
 * Module: minds/load
 *
 * Loads agent minds/persona/knowledge/lessons and memory files from `.minds`.
 * Composes the system prompt and aggregates memories with optional hints.
 */
import type { Dirent } from 'fs';
import { access, readFile, readdir, stat } from 'fs/promises';
import path from 'path';
import { Dialog, SubDialog } from '../dialog';
import { ChatMessage } from '../llm/client';
import { log } from '../log';
import { getTextForLanguage } from '../shared/i18n/text';
import { getWorkLanguage } from '../shared/runtime-language';
import type { LanguageCode } from '../shared/types/language';
import { formatUnifiedTimestamp } from '../shared/utils/time';
import { Team } from '../team';
import type { FuncTool, Tool } from '../tool';
import {
  addReminderTool,
  changeMindTool,
  clearMindTool,
  deleteReminderTool,
  recallTaskdocTool,
  updateReminderTool,
} from '../tools/ctrl';
import { getToolsetPromptI18n } from '../tools/registry';
import {
  defaultPersonaText,
  funcToolRulesText as formatFuncToolRulesText,
  funcToolUsageLabels,
  memoriesSummaryLinePersonal,
  memoriesSummaryLineShared,
  memoriesSummarySectionPersonal,
  memoriesSummarySectionShared,
  memoriesSummaryTitle,
  memoryPreambleLabels,
  noneRequiredFieldsText,
  noneText,
  personalMemoriesHeader,
  personalScopeLabel,
  sharedMemoriesHeader,
  sharedScopeLabel,
  taskdocCanonicalCopy,
} from './minds-i18n';
import { buildSystemPrompt, formatTeamIntro } from './system-prompt';

type ReadAgentMindResult = { kind: 'found'; text: string } | { kind: 'missing' };

const SHELL_TOOL_NAMES = ['shell_cmd', 'stop_daemon', 'get_daemon_output'] as const;
type ShellToolName = (typeof SHELL_TOOL_NAMES)[number];

function isShellToolName(name: string): name is ShellToolName {
  return (SHELL_TOOL_NAMES as readonly string[]).includes(name);
}

function listShellSpecialistMemberIds(team: Team): string[] {
  const out: string[] = [];
  for (const id of team.shellSpecialists) {
    const member = team.getMember(id);
    if (!member) continue;
    if (member.hidden === true) continue;
    out.push(id);
  }
  return out;
}

function buildShellPolicyPrompt(options: {
  language: LanguageCode;
  agentIsShellSpecialist: boolean;
  agentHasShellTools: boolean;
  agentHasReadonlyShell: boolean;
  shellSpecialistMemberIds: string[];
}): string {
  const {
    language,
    agentIsShellSpecialist,
    agentHasShellTools,
    agentHasReadonlyShell,
    shellSpecialistMemberIds,
  } = options;
  const title =
    language === 'zh' ? '### Shell 执行策略（重要）' : '### Shell Execution Policy (Important)';

  const shellSpecialists =
    shellSpecialistMemberIds.length > 0
      ? shellSpecialistMemberIds.map((id) => `@${id}`).join(', ')
      : language === 'zh'
        ? '（未配置 shell 专员）'
        : '(no shell specialists configured)';

  if (agentIsShellSpecialist && agentHasShellTools) {
    const body =
      language === 'zh'
        ? [
            '你是本队的 shell 专员，具备 shell 执行能力（高风险）。使用前必须先做风险识别与最小化：',
            '- 说明目的、预期输出/验证方式、预期工作目录与影响面。',
            '- 优先选择只读命令；写入/删除/网络/权限相关操作必须解释理由与安全边界。',
            '- 如果不确定命令后果，先提出更安全的替代方案或向人类/队友确认。',
            '',
            '当队友请求你执行命令时：请先复述你将执行的命令与风险边界，再执行，并按结构化格式回传 command/exit_code/stdout/stderr。',
            '',
            `本队 shell 专员列表：${shellSpecialists}`,
          ].join('\n')
        : [
            'You are a designated shell specialist and have shell execution capability (high-risk). Before using it, do risk identification and minimize blast radius:',
            '- State intent, expected output/verification, expected working directory, and scope of impact.',
            '- Prefer read-only commands; for writes/deletes/network/privilege-related actions, justify and state safety boundaries.',
            '- If unsure about consequences, propose a safer alternative or confirm with a human/teammate first.',
            '',
            'When teammates ask you to run commands: restate the exact command and guardrails, then execute, and report back with a structured receipt: command/exit_code/stdout/stderr.',
            '',
            `Shell specialists in this team: ${shellSpecialists}`,
          ].join('\n');
    return `${title}\n\n${body}`.trim();
  }

  if (agentIsShellSpecialist && !agentHasShellTools) {
    const body =
      language === 'zh'
        ? [
            '你被配置为 shell 专员，但当前没有可用的 shell 工具（团队配置错误）。',
            '在未修复配置前：不要声称自己执行过命令；如需验证，请让人类修复 team.yaml 或把 shell 能力授予正确的成员。',
            '',
            `本队 shell 专员列表：${shellSpecialists}`,
          ].join('\n')
        : [
            'You are configured as a shell specialist, but you do not currently have shell tools available (team configuration error).',
            'Until it is fixed: do not claim you ran any command; ask a human to fix team.yaml or grant shell tools to the correct specialist member.',
            '',
            `Shell specialists in this team: ${shellSpecialists}`,
          ].join('\n');
    return `${title}\n\n${body}`.trim();
  }

  const body =
    language === 'zh'
      ? agentHasReadonlyShell
        ? [
            '你不具备高权限 shell 工具（shell_cmd/stop_daemon/get_daemon_output）。',
            '你已被明确授权使用 `readonly_shell` 自行执行只读命令（仅允许白名单命令前缀）：请直接调用，不要去寻找 shell 专员代跑。',
            '',
            '当你需要的命令不在白名单内，或需要写入/删除/网络/长时间运行/进程管理等高风险能力时：再转交给具备 shell 工具的专员队友，并提供充分理由与可审查的命令提案：',
            '- 你要达成的目标（why）',
            '- 建议命令（what）+ 预期工作目录（cwd）+ 预期输出/验证方式（how to verify）',
            '- 风险评估与安全边界（risk & guardrails）',
            `可转交的 shell 专员队友：${shellSpecialists}`,
            '',
            '重要：如果你打算让队友执行命令，请在同一条消息里给出完整的 tellask 诉请块（以第 0 列开头的 `!?@<shell-specialist>` 行），不要只说“我会请某人运行”。',
            '重要：在你看到 shell 专员的回执（command/exit_code/stdout/stderr）之前，不要声称“已运行/已通过/无错”。',
          ].join('\n')
        : [
            '你不具备 shell 工具（本环境仅 shell 专员可执行 shell）：不要尝试“编造/假设”命令输出，也不要要求系统直接执行。',
            '当你确实需要 shell 执行时：请转交给具备 shell 能力的专员队友，并提供充分理由与可审查的命令提案：',
            '- 你要达成的目标（why）',
            '- 建议命令（what）+ 预期工作目录（cwd）+ 预期输出/验证方式（how to verify）',
            '- 风险评估与安全边界（risk & guardrails）',
            `可转交的 shell 专员队友：${shellSpecialists}`,
            '',
            '重要：如果你打算让队友执行命令，请在同一条消息里给出完整的 tellask 诉请块（以第 0 列开头的 `!?@<shell-specialist>` 行），不要只说“我会请某人运行”。',
            '重要：在你看到 shell 专员的回执（command/exit_code/stdout/stderr）之前，不要声称“已运行/已通过/无错”。',
          ].join('\n')
      : agentHasReadonlyShell
        ? [
            'You do not have high-risk shell tools (shell_cmd/stop_daemon/get_daemon_output).',
            'You are explicitly authorized to use `readonly_shell` yourself for read-only inspection via its small allowlist. Call it directly; do not go looking for a shell specialist to run it for you.',
            '',
            'When the command you need is not in the allowlist, or you need high-risk capabilities like writes/deletes/network/long-running jobs/process management: delegate to a shell specialist teammate with a justified, reviewable proposal:',
            '- Goal (why)',
            '- Proposed command (what) + expected working directory (cwd) + expected output/verification (how to verify)',
            '- Risk assessment and guardrails (risk & guardrails)',
            '',
            `Shell specialist teammates: ${shellSpecialists}`,
            '',
            'Important: if you intend to delegate, include the full tellask block (a column-0 `!?@<shell-specialist>` line) in the same message; do not just say “I will ask someone to run it”.',
            'Important: do not claim “ran/passed/no errors” until you see the shell specialist’s receipt (command/exit_code/stdout/stderr).',
          ].join('\n')
        : [
            'You do not have shell tools configured (shell execution is restricted to designated specialists): do not fabricate/assume command output, and do not ask the system to execute commands directly.',
            'When you truly need shell execution, delegate to a shell specialist teammate with a justified, reviewable proposal:',
            '- Goal (why)',
            '- Proposed command (what) + expected working directory (cwd) + expected output/verification (how to verify)',
            '- Risk assessment and guardrails (risk & guardrails)',
            '',
            `Shell specialist teammates: ${shellSpecialists}`,
            '',
            'Important: if you intend to delegate, include the full tellask block (a column-0 `!?@<shell-specialist>` line) in the same message; do not just say “I will ask someone to run it”.',
            'Important: do not claim “ran/passed/no errors” until you see the shell specialist’s receipt (command/exit_code/stdout/stderr).',
          ].join('\n');
  return `${title}\n\n${body}`.trim();
}

async function readAgentMindResult(id: string, fn: string): Promise<ReadAgentMindResult> {
  const mindFn = path.join('.minds', 'team', id, fn);
  try {
    await access(mindFn);
  } catch {
    // no rtws mindset file, attempt builtin minds
    const builtinMindFn = path.join(__dirname, 'builtin', id, fn);
    try {
      const text = await readFile(builtinMindFn, 'utf-8');
      return { kind: 'found', text };
    } catch (error: unknown) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code?: unknown }).code === 'ENOENT'
      ) {
        return { kind: 'missing' };
      }
      log.warn(`Failed reading file '${builtinMindFn}':`, error);
      return { kind: 'missing' };
    }
  }
  try {
    const text = await readFile(mindFn, 'utf-8');
    return { kind: 'found', text };
  } catch (error: unknown) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === 'ENOENT'
    ) {
      return { kind: 'missing' };
    }
    log.warn(`Failed reading file '${mindFn}':`, error);
    return { kind: 'missing' };
  }
}

async function readAgentMindPreferred(options: {
  id: string;
  preferredFilenames: readonly string[];
  noFileDefault: string;
}): Promise<string> {
  for (const fn of options.preferredFilenames) {
    const result = await readAgentMindResult(options.id, fn);
    if (result.kind === 'found') return result.text;
  }
  return options.noFileDefault;
}

export async function loadAgentMinds(
  agentId?: string,
  dialog?: Dialog,
): Promise<{
  team: Team;
  agent: Team.Member;
  systemPrompt: string;
  memories: ChatMessage[];
  agentTools: Tool[];
}> {
  const workingLanguage = getWorkLanguage();
  let team = await Team.load();
  const agent = agentId === undefined ? team.getDefaultResponder() : team.getMember(agentId);
  if (!agent) throw new Error(`No such agent in team: '${agentId}'`);

  // read disk file afresh, in case the contents have changed by human or ai meanwhile
  const personaRaw = await readAgentMindPreferred({
    id: agent.id,
    preferredFilenames: [`persona.${workingLanguage}.md`, 'persona.md'],
    noFileDefault: defaultPersonaText(workingLanguage),
  });
  const knowledgeRaw = await readAgentMindPreferred({
    id: agent.id,
    preferredFilenames: [`knowledge.${workingLanguage}.md`, 'knowledge.md'],
    noFileDefault: '',
  });
  const lessonsRaw = await readAgentMindPreferred({
    id: agent.id,
    preferredFilenames: [`lessons.${workingLanguage}.md`, 'lessons.md'],
    noFileDefault: '',
  });
  const none = noneText(workingLanguage);
  const persona = personaRaw && personaRaw.trim() !== '' ? personaRaw : none;
  const knowledge = knowledgeRaw && knowledgeRaw.trim() !== '' ? knowledgeRaw : none;
  const lessons = lessonsRaw && lessonsRaw.trim() !== '' ? lessonsRaw : none;

  // Introduction of all team members (mark "(self)" for the current agent)
  const teamIntro = formatTeamIntro(team, agent.id, workingLanguage);

  // Compose tool list from member's resolved toolsets and tools + built-in human tool
  // Get base tools from agent (excluding intrinsic dialog control tools which are always injected)
  // shell_specialists is intended for visible teammates only. Hidden members are exempt from this
  // policy and may carry shell tools.
  const agentIsShellSpecialist = team.shellSpecialists.includes(agent.id) || agent.hidden === true;

  const baseAgentTools: Tool[] = (() => {
    const tools = agent.listTools();
    if (agentIsShellSpecialist) return tools;
    return tools.filter(
      (t) => !(t.type === 'func' && typeof t.name === 'string' && isShellToolName(t.name)),
    );
  })();

  // Inject intrinsic dialog control tools as function tools (available to all agents).
  const intrinsicFuncTools: FuncTool[] = [
    addReminderTool,
    deleteReminderTool,
    updateReminderTool,
    clearMindTool,
    recallTaskdocTool,
  ];
  // change_mind is only available in main dialogs (not subdialogs).
  if (dialog === undefined || dialog.supdialog === undefined) {
    intrinsicFuncTools.push(changeMindTool);
  }

  const agentTools: Tool[] = (() => {
    const out: Tool[] = [...baseAgentTools];
    const seenNames = new Set(out.map((t) => t.name));
    for (const t of intrinsicFuncTools) {
      if (!seenNames.has(t.name)) {
        out.push(t);
        seenNames.add(t.name);
      }
    }
    return out;
  })();

  const funcTools = agentTools.filter((t): t is FuncTool => t.type === 'func');

  const agentHasShellTools = funcTools.some((t) => isShellToolName(t.name));
  const agentHasReadonlyShell = funcTools.some((t) => t.name === 'readonly_shell');
  const shellSpecialistMemberIds = listShellSpecialistMemberIds(team);
  const shellPolicyPrompt = buildShellPolicyPrompt({
    language: workingLanguage,
    agentIsShellSpecialist,
    agentHasShellTools,
    agentHasReadonlyShell,
    shellSpecialistMemberIds,
  });

  const toolsetPromptText = (() => {
    const toolsetNames = agent.listResolvedToolsetNames().filter((name) => {
      if (name === 'os') return agentIsShellSpecialist;
      return true;
    });
    const blocks = toolsetNames
      .map((toolsetName) => {
        const promptI18n = getToolsetPromptI18n(toolsetName);
        const prompt = getTextForLanguage(
          { i18n: promptI18n, fallback: '' },
          workingLanguage,
        ).trim();
        if (prompt === '') return '';
        const title =
          workingLanguage === 'zh'
            ? `### Toolset 提示：${toolsetName}`
            : `### Toolset prompt: ${toolsetName}`;
        return `${title}\n\n${prompt}`;
      })
      .filter((b) => b !== '');
    return blocks.join('\n\n');
  })();

  const memorySystemTitle =
    workingLanguage === 'zh' ? '### 记忆系统（重要）' : '### Memory System (Important)';
  const TEAM_MEMORY_TOOL_NAMES = [
    'add_team_memory',
    'replace_team_memory',
    'drop_team_memory',
    'clear_team_memory',
  ] as const;
  type TeamMemoryToolName = (typeof TEAM_MEMORY_TOOL_NAMES)[number];
  const PERSONAL_MEMORY_TOOL_NAMES = [
    'add_memory',
    'replace_memory',
    'drop_memory',
    'clear_memory',
  ] as const;
  type PersonalMemoryToolName = (typeof PERSONAL_MEMORY_TOOL_NAMES)[number];

  function isTeamMemoryToolName(name: string): name is TeamMemoryToolName {
    return (TEAM_MEMORY_TOOL_NAMES as readonly string[]).includes(name);
  }

  function isPersonalMemoryToolName(name: string): name is PersonalMemoryToolName {
    return (PERSONAL_MEMORY_TOOL_NAMES as readonly string[]).includes(name);
  }

  const agentHasTeamMemoryTools = funcTools.some((t) => isTeamMemoryToolName(t.name));
  const agentHasPersonalMemoryTools = funcTools.some((t) => isPersonalMemoryToolName(t.name));
  const isSubdialog = dialog !== undefined && dialog.supdialog !== undefined;
  const taskdocMaintainerId =
    dialog && dialog instanceof SubDialog ? dialog.rootDialog.agentId : agent.id;

  const memorySystemBody = (() => {
    if (workingLanguage === 'zh') {
      const teamMemoryLine = '- 团队记忆：稳定的团队约定/工程规约（跨任务共享）。';

      const personalMemoryLine =
        '- 个人记忆：稳定的个人习惯/偏好与职责域知识；可维护你职责范围内的“工作区索引”（关键文档/代码的准确路径 + 必要要点），以减少重复读文件；不要记录具体任务状态。';

      return [
        '你的聊天记录与工具输出是临时信息：会快速累积、很快过时，并增加你的认知负担。在同一轮对话中，除了 `clear_mind` 以外你无法真正丢弃这些历史。',
        '`clear_mind` 会开启新一轮/新回合（保留差遣牒、提醒项与记忆层），从而卸掉这部分认知负载并继续推进。因此你必须先把关键信息提炼到高价值载体：',
        '- 差遣牒（Taskdoc，`*.tsk/`）：全队共享的任务契约（goals/constraints/progress）；保持足够短，每轮都应可通读。',
        `- 更新差遣牒的任意分段时：每次调用会替换该分段全文；你必须先对照“上下文中注入的当前内容”做合并/压缩；禁止覆盖/抹掉他人条目；自己负责维护的条目必须标注责任人（例如 \`- [owner:@${agent.id}] ...\` 或用 \`### @${agent.id}\` 分块）。`,
        '- 其中 `progress` 是全队共享公告牌：用于“阶段性进度快照”（关键决策/当前状态/下一步），不是流水账。',
        '- 重要：差遣牒内容会被系统以内联形式注入到上下文中（本轮生成视角下即为最新）。需要回顾时请直接基于上下文里的差遣牒内容回顾与决策，不要试图用通用文件工具读取 `*.tsk/` 下的文件（会被拒绝）。',
        '- 约定：`constraints` 尽量只写任务特有的硬要求。系统提示/工具文档里已明确且由系统强制执行的通用规则（例如 `*.tsk/` 封装禁止通用文件工具）无需重复写入 `constraints.md`。',
        '- 提醒项（工作集）：当前对话的高频工作记录/关键细节（偏私有，不作为全队公告）；保持少量（常见 1–3 条），优先 `update_reminder` 压缩/合并，不再需要就 `delete_reminder`。',
        teamMemoryLine,
        personalMemoryLine,
        '',
        ...(isSubdialog
          ? [
              `你当前处于子对话：此处不允许 \`change_mind\`。当你判断需要更新差遣牒（尤其是 progress 公告牌）时，请在合适时机直接诉请差遣牒维护人 \`@${taskdocMaintainerId}\` 执行更新，并给出你已合并好的“新全文/替换稿”（用于替换对应章节全文）。不要声称已更新，除非看到回执。`,
            ]
          : [
              '你当前处于主对话：你负责综合维护全队共享差遣牒（尤其是 progress 公告牌）。当队友/子对话提出更新建议时，及时合并、压缩并保持清晰。',
            ]),
        ...(agentHasTeamMemoryTools
          ? [
              '提示：你具备团队记忆工具（`add_team_memory` / `replace_team_memory` / `drop_team_memory` / `clear_team_memory`），可在必要时维护团队记忆（谨慎、少量、只写稳定约定）。',
            ]
          : []),
        ...(agentHasPersonalMemoryTools
          ? [
              '提示：你具备个人记忆工具（`add_memory` / `replace_memory` / `drop_memory` / `clear_memory`）。目标：维护你职责域的“工作区索引”（关键文档/代码的准确路径 + 最小必要要点，如入口文件/关键符号/约定），让你在职责范围内尽量做到“0 次 ripgrep 就能开始干活”；一旦你修改了相关文件或发现记忆有过期/冲突，必须立刻用 `replace_memory` 把对应条目更新为最新事实。',
            ]
          : []),
        ...(isSubdialog
          ? [
              `工作流：先做事 → 再提炼（\`update_reminder\`；必要时整理差遣牒更新提案并诉请 \`@${taskdocMaintainerId}\` 合并写入）→ 然后 \`clear_mind\` 清空噪音。`,
            ]
          : [
              '工作流：先做事 → 再提炼（`update_reminder` + `change_mind(progress)`）→ 然后 `clear_mind` 清空噪音。',
            ]),
        '当 context health 变黄/红：立刻停止继续大实现/大阅读；先提炼，再 clear。',
        '不要把长日志/大段 tool output 直接塞进差遣牒；差遣牒只写结论+下一步；细节只保留必要摘录放提醒项。',
      ].join('\n');
    }

    const teamMemoryLine = '- Team memory: stable shared conventions (cross-task).';

    const personalMemoryLine =
      '- Personal memory: stable personal habits/preferences and responsibility-scope knowledge. Maintain a compact responsibility-area workspace index (exact key doc/code paths + minimal key facts) to reduce repeat file reads; do not store per-task state.';

    return [
      'Chat history and tool outputs are temporary: they accumulate quickly, become stale, and increase cognitive load. Within a round, you cannot truly drop that history except via `clear_mind`.',
      '`clear_mind` starts a new round while preserving Taskdoc, reminders, and memory layers. Therefore, before clearing, distill key information into durable layers:',
      '- Taskdoc (`*.tsk/`): team-shared task contract (goals/constraints/progress). Keep it small enough to read every round.',
      `- When updating any Taskdoc section: each call replaces the entire section; always start from the current injected content and merge/compress; do not overwrite other contributors; add an explicit owner tag for entries you maintain (e.g., \`- [owner:@${agent.id}] ...\` or a \`### @${agent.id}\` block).`,
      '- Taskdoc `progress` is the team’s shared bulletin board: distilled milestone snapshots (key decisions/current status/next steps), not raw logs.',
      '- Important: the Taskdoc content is injected inline into the context (the latest as of this generation). Review the injected Taskdoc instead of trying to read files under `*.tsk/` via general file tools (they will be rejected).',
      '- Convention: keep Taskdoc `constraints` focused on task-specific requirements. Do not duplicate global, system-enforced rules already stated in system prompt/tool docs (e.g. `.tsk/` encapsulation bans general file tools).',
      '- Reminders (working set): your high-frequency per-dialog worklog + critical details (not a team bulletin board); keep it small (often 1–3 items), prefer `update_reminder` to compress/merge; delete when obsolete.',
      teamMemoryLine,
      personalMemoryLine,
      '',
      ...(isSubdialog
        ? [
            `You are currently in a subdialog: \`change_mind\` is not allowed here. When Taskdoc should be updated (especially the shared progress bulletin board), tellask the Taskdoc maintainer \`@${taskdocMaintainerId}\` with a fully merged replacement draft (full-section replacement). Do not claim it is updated until you see a receipt.`,
          ]
        : [
            'You are currently in the main dialog: you are responsible for keeping the team-shared Taskdoc coherent and up to date (especially the progress bulletin board). Merge proposals from teammates/subdialogs promptly and keep it concise.',
          ]),
      ...(agentHasTeamMemoryTools
        ? [
            'Hint: you have team-memory tools (`add_team_memory` / `replace_team_memory` / `drop_team_memory` / `clear_team_memory`) and may maintain team memory when it is truly stable and worth sharing.',
          ]
        : []),
      ...(agentHasPersonalMemoryTools
        ? [
            'Hint: you have personal-memory tools (`add_memory` / `replace_memory` / `drop_memory` / `clear_memory`). Goal: maintain a compact responsibility-area workspace index (exact key doc/code paths + minimal key facts like entrypoints/key symbols/contracts) so you can start work with 0 ripgrep within your scope. If you changed those files or detect staleness/conflicts, immediately `replace_memory` to keep it accurate.',
          ]
        : []),
      ...(isSubdialog
        ? [
            `Workflow: do work → distill (\`update_reminder\`; when Taskdoc needs updates, draft a merged replacement and ask \`@${taskdocMaintainerId}\`) → then \`clear_mind\` to drop noise.`,
          ]
        : [
            'Workflow: do work → distill (`update_reminder` + `change_mind(progress)`) → then `clear_mind` to drop noise.',
          ]),
      'When context health turns yellow/red: treat it as a hard stop; distill first, then clear.',
      'Do not paste long logs/tool outputs into Taskdoc; Taskdoc should record decisions + next steps; keep only essential excerpts in reminders.',
    ].join('\n');
  })();
  const memorySystemPrompt = `${memorySystemTitle}\n\n${memorySystemBody}`;
  const taskdocPolicyPrompt = taskdocCanonicalCopy(workingLanguage);

  // Generate tool usage text (shell policy + memory system + toolset prompts).
  let toolUsageText: string;
  let funcToolUsageText: string = '';
  let funcToolRulesText: string = '';

  toolUsageText = (() => {
    const prefix = [shellPolicyPrompt, memorySystemPrompt, taskdocPolicyPrompt, toolsetPromptText]
      .filter((b) => b.trim() !== '')
      .join('\n\n');
    return prefix;
  })();
  if (funcTools.length > 0) {
    funcToolUsageText = funcTools
      .map((tool) => {
        // NOTE: Function-tool schemas may come from MCP and are treated as passthrough JSON Schema.
        // Runtime inspection is unavoidable here because this is purely for human-readable help text.
        const schema = tool.parameters;

        const isRecord = (value: unknown): value is Record<string, unknown> =>
          typeof value === 'object' && value !== null && !Array.isArray(value);

        const requiredValue = schema['required'];
        const required =
          Array.isArray(requiredValue) && requiredValue.every((v) => typeof v === 'string')
            ? requiredValue
            : [];
        const req =
          required.length > 0 ? required.join(', ') : noneRequiredFieldsText(workingLanguage);

        const propsValue = schema['properties'];
        const propsRecord = isRecord(propsValue) ? propsValue : {};
        const props = Object.entries(propsRecord)
          .map(([k, v]) => {
            const desc =
              isRecord(v) && 'description' in v && typeof v.description === 'string'
                ? v.description
                : 'parameter';
            return `- ${k}: ${desc}`;
          })
          .join('\n');
        const labels = funcToolUsageLabels(workingLanguage);
        const toolDesc = getTextForLanguage(
          { i18n: tool.descriptionI18n, fallback: tool.description },
          workingLanguage,
        );
        return `#### ${labels.toolLabel}: ${tool.name}\n\n${toolDesc}\n\n- ${labels.invocationLabel}: ${labels.invocationBody}\n- ${labels.requiredLabel}: ${req}\n- ${labels.parametersLabel}:\n${props}`.trim();
      })
      .join('\n\n');
    funcToolRulesText = formatFuncToolRulesText(workingLanguage);
  }

  const systemPrompt = buildSystemPrompt({
    language: workingLanguage,
    agent,
    persona,
    knowledge,
    lessons,
    teamIntro,
    toolUsageText,
    intrinsicToolInstructions: '',
    funcToolUsageText,
    funcToolRulesText,
  });

  // composite this list by reading:
  //   - .minds/memory/team_shared/**/*.md
  //   - .minds/memory/individual/<agent.id>/**/*.md
  // one role='assistant' msg per file, add preamble about it's shared or personal
  // lightly hint the use of memory tools on personal mem, in 1st person tongue,
  // for mem tools made available to the agent per its team member spec
  //
  // aggregate shared and personal memories into assistant messages
  const memories: ChatMessage[] = [];
  const groupedMemories: { shared: ChatMessage[]; personal: ChatMessage[] } = {
    shared: [],
    personal: [],
  };
  try {
    interface MemoryFile {
      absolutePath: string;
      relativePath: string;
    }

    async function collectMdFiles(rootDir: string): Promise<MemoryFile[]> {
      const files: MemoryFile[] = [];
      async function walk(dir: string): Promise<void> {
        let entries: Dirent[];
        try {
          entries = await readdir(dir, { withFileTypes: true });
        } catch (err: unknown) {
          if (
            typeof err === 'object' &&
            err !== null &&
            'code' in err &&
            (err as { code?: unknown }).code === 'ENOENT'
          ) {
            return;
          }
          log.warn(`Failed to read directory ${dir}:`, err);
          return;
        }
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            await walk(fullPath);
          } else if (entry.isFile() && fullPath.endsWith('.md')) {
            const relativePath = path.relative(rootDir, fullPath);
            files.push({
              absolutePath: fullPath,
              relativePath: relativePath,
            });
          }
        }
      }
      await walk(rootDir);
      return files;
    }

    const sharedFiles = await collectMdFiles('.minds/memory/team_shared');
    const personalFiles = await collectMdFiles(`.minds/memory/individual/${agent.id}`);

    function countWords(text: string): number {
      const trimmed = text.trim();
      if (trimmed === '') return 0;
      return trimmed.split(/\s+/).length;
    }

    const readMemFiles = async (
      files: MemoryFile[],
      scopeKind: 'shared' | 'personal',
      scopeLabel: string,
      relevantToolNames: string[],
    ): Promise<void> => {
      for (const file of files) {
        try {
          const content = await readFile(file.absolutePath, 'utf-8');
          const s = await stat(file.absolutePath);
          const lastModified = formatUnifiedTimestamp(new Date(s.mtimeMs));
          const byteSize = s.size;
          const wordCount = countWords(content);
          const labels = memoryPreambleLabels(workingLanguage);
          let preamble = `### ${scopeLabel}\n- ${labels.pathLabel}: \`${file.relativePath}\`\n- ${labels.lastModifiedLabel}: ${lastModified}\n- ${labels.sizeLabel}: ${byteSize} ${labels.bytesUnit}\n- ${labels.wordsLabel}: ${wordCount}`;

          // Add tool usage hints if relevant memory tools are available
          const availableTools = agentTools.map((tool) => tool.name).filter(Boolean);
          const availableRelevantTools = relevantToolNames.filter((toolName) =>
            availableTools.includes(toolName),
          );

          if (availableRelevantTools.length > 0) {
            const toolHints = availableRelevantTools.map(
              (toolName) => `@${toolName} ${file.relativePath}`,
            );
            const nestedHints = toolHints.map((h) => `  - ${h}`).join('\n');
            preamble += `\n- ${labels.manageWithLabel}:\n${nestedHints}`;
          }

          const memMsg: ChatMessage = {
            type: 'transient_guide_msg',
            role: 'assistant',
            content: `${preamble}\n---\n${content.trim()}\n`,
          };
          if (scopeKind === 'shared') {
            groupedMemories.shared.push(memMsg);
          } else {
            groupedMemories.personal.push(memMsg);
          }
          memories.push(memMsg);
        } catch (err) {
          log.warn(`Failed to read memory file ${file.absolutePath}:`, err);
        }
      }
    };

    const sharedScopeLabelText = sharedScopeLabel(workingLanguage);
    const personalScopeLabelText = personalScopeLabel(workingLanguage, agent.id);

    await readMemFiles(sharedFiles, 'shared', sharedScopeLabelText, [
      'replace_team_memory',
      'drop_team_memory',
    ]);
    await readMemFiles(personalFiles, 'personal', personalScopeLabelText, [
      'replace_memory',
      'drop_memory',
    ]);
  } catch (err) {
    log.warn('Failed to load agent memories:', err);
  }

  // Prepend grouped section headers when any memory exists
  const groupedOutput: ChatMessage[] = [];
  if (groupedMemories.shared.length > 0 || groupedMemories.personal.length > 0) {
    groupedOutput.push({
      type: 'transient_guide_msg',
      role: 'assistant',
      content: memoriesSummaryTitle(workingLanguage),
    });
    if (groupedMemories.shared.length > 0) {
      const summaryShared = groupedMemories.shared
        .filter((m): m is ChatMessage & { content: string } => 'content' in m)
        .map((m) => {
          const match = m.content.match(/- (?:Path|路径): `([^`]+)`/);
          const p = match ? match[1] : '';
          return memoriesSummaryLineShared(workingLanguage, p);
        })
        .join('\n');
      groupedOutput.push({
        type: 'transient_guide_msg',
        role: 'assistant',
        content: memoriesSummarySectionShared(workingLanguage),
      });
      groupedOutput.push({
        type: 'transient_guide_msg',
        role: 'assistant',
        content: summaryShared,
      });
    }
    if (groupedMemories.personal.length > 0) {
      const summaryPersonal = groupedMemories.personal
        .filter((m): m is ChatMessage & { content: string } => 'content' in m)
        .map((m) => {
          const match = m.content.match(/- (?:Path|路径): `([^`]+)`/);
          const p = match ? match[1] : '';
          return memoriesSummaryLinePersonal(workingLanguage, p);
        })
        .join('\n');
      groupedOutput.push({
        type: 'transient_guide_msg',
        role: 'assistant',
        content: memoriesSummarySectionPersonal(workingLanguage),
      });
      groupedOutput.push({
        type: 'transient_guide_msg',
        role: 'assistant',
        content: summaryPersonal,
      });
    }
  }
  if (groupedMemories.shared.length > 0) {
    groupedOutput.push({
      type: 'transient_guide_msg',
      role: 'assistant',
      content: sharedMemoriesHeader(workingLanguage),
    });
    groupedOutput.push(...groupedMemories.shared);
  }
  if (groupedMemories.personal.length > 0) {
    groupedOutput.push({
      type: 'transient_guide_msg',
      role: 'assistant',
      content: personalMemoriesHeader(workingLanguage),
    });
    groupedOutput.push(...groupedMemories.personal);
  }

  return {
    team,
    agent,
    systemPrompt,
    memories: groupedOutput.length > 0 ? groupedOutput : memories,
    agentTools,
  };
}
