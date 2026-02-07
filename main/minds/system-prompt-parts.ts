import type { LanguageCode } from '../shared/types/language';
import type { FuncTool } from '../tool';
import { funcToolUsageLabels, noneRequiredFieldsText } from './minds-i18n';

export type PromptdocContext = {
  language: LanguageCode;
  agentId: string;
  isSubdialog: boolean;
  taskdocMaintainerId: string;
  agentHasTeamMemoryTools: boolean;
  agentHasPersonalMemoryTools: boolean;
  agentIsShellSpecialist: boolean;
  agentHasShellTools: boolean;
  agentHasReadonlyShell: boolean;
  shellSpecialistMemberIds: string[];
};

export function buildNoToolsNotice(language: LanguageCode): string {
  return language === 'zh'
    ? '无工具：不能调用任何工具，也不能访问 rtws / 文件 / 浏览器 / shell。'
    : 'No tools: do not call any tools, and do not access the rtws, files, browser, or shell.';
}

export function buildShellPolicyPrompt(ctx: PromptdocContext): string {
  const {
    language,
    agentIsShellSpecialist,
    agentHasShellTools,
    agentHasReadonlyShell,
    shellSpecialistMemberIds,
  } = ctx;
  const title =
    language === 'zh' ? '### Shell 执行策略（重要）' : '### Shell Execution Policy (Important)';
  const devopsScriptPolicy =
    language === 'zh'
      ? 'DevOps 场景：忌讳临时脚本。不要用临时脚本完成工作；如需工具脚本，请与队友和人类讨论并在 rtws 中正式设计/命名/规范化后使用。'
      : 'DevOps context: ad-hoc temp scripts are a taboo. Do not rely on temp scripts; if a tool script is needed, align with teammates and the human and formalize it in the rtws before use.';

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
            '',
            devopsScriptPolicy,
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
            '',
            devopsScriptPolicy,
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
            devopsScriptPolicy,
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
            devopsScriptPolicy,
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
            devopsScriptPolicy,
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
            devopsScriptPolicy,
            '',
            'Important: if you intend to delegate, include the full tellask block (a column-0 `!?@<shell-specialist>` line) in the same message; do not just say “I will ask someone to run it”.',
            'Important: do not claim “ran/passed/no errors” until you see the shell specialist’s receipt (command/exit_code/stdout/stderr).',
          ].join('\n');
  return `${title}\n\n${body}`.trim();
}

export function buildMemorySystemPrompt(ctx: PromptdocContext): string {
  const { language } = ctx;
  const title = language === 'zh' ? '### 记忆系统（重要）' : '### Memory System (Important)';

  if (language === 'zh') {
    const teamMemoryLine = '- 团队记忆：稳定的团队约定/工程规约（跨任务共享）。';
    const personalMemoryLine =
      '- 个人记忆：稳定的个人习惯/偏好与职责域知识；可维护你职责范围内的“rtws 索引”（关键文档/代码的准确路径 + 必要要点），以减少重复读文件；不要记录具体任务状态。';

    const body = [
      '你的聊天记录与工具输出是临时信息：会快速累积、很快过时，并增加你的认知负担。在同一轮对话中，除了 `clear_mind` 以外你无法真正丢弃这些历史。',
      '`clear_mind` 会开启新一程对话（保留差遣牒、提醒项与记忆层），从而卸掉这部分认知负载并继续推进。因此你必须先把关键信息提炼到高价值载体：',
      '- 差遣牒（Taskdoc，`*.tsk/`）：全队共享的任务契约（goals/constraints/progress）；保持足够短，每轮都应可通读。',
      `- 更新差遣牒的任意分段时：每次调用会替换该分段全文；你必须先对照“上下文中注入的当前内容”做合并/压缩；禁止覆盖/抹掉他人条目；自己负责维护的条目必须标注责任人（例如 \`- [owner:@${ctx.agentId}] ...\` 或用 \`### @${ctx.agentId}\` 分块）。`,
      '- 其中 `progress` 是全队共享公告牌：用于“阶段性进度快照”（关键决策/当前状态/下一步），不是流水账。',
      '- 重要：差遣牒内容会被系统以内联形式注入到上下文中（本轮生成视角下即为最新）。需要回顾时请直接基于上下文里的差遣牒内容回顾与决策，不要试图用通用文件工具读取 `*.tsk/` 下的文件（会被拒绝）。',
      '- 约定：`constraints` 尽量只写任务特有的硬要求。系统提示/工具文档里已明确且由系统强制执行的通用规则（例如 `*.tsk/` 封装禁止通用文件工具）无需重复写入 `constraints.md`。',
      '- 提醒项（工作集）：当前对话的高频工作记录/关键细节（偏私有，不作为全队公告）；保持少量（常见 1–3 条），优先 `update_reminder` 压缩/合并，不再需要就 `delete_reminder`。',
      teamMemoryLine,
      personalMemoryLine,
      '',
      ...(ctx.isSubdialog
        ? [
            `你当前处于支线对话：此处不允许 \`change_mind\`。当你判断需要更新差遣牒（尤其是 progress 公告牌）时，请在合适时机直接诉请差遣牒维护人 \`@${ctx.taskdocMaintainerId}\` 执行更新，并给出你已合并好的“新全文/替换稿”（用于替换对应章节全文）。不要声称已更新，除非看到回执。`,
          ]
        : [
            '你当前处于主线对话：你负责综合维护全队共享差遣牒（尤其是 progress 公告牌）。当队友/支线对话提出更新建议时，及时合并、压缩并保持清晰。',
          ]),
      ...(ctx.agentHasTeamMemoryTools
        ? [
            '提示：你具备团队记忆工具（`add_team_memory` / `replace_team_memory` / `drop_team_memory` / `clear_team_memory`），可在必要时维护团队记忆（谨慎、少量、只写稳定约定）。',
          ]
        : []),
      ...(ctx.agentHasPersonalMemoryTools
        ? [
            '提示：你具备个人记忆工具（`add_memory` / `replace_memory` / `drop_memory` / `clear_memory`）。目标：维护你职责域的“rtws 索引”（关键文档/代码的准确路径 + 最小必要要点，如入口文件/关键符号/约定），让你在职责范围内尽量做到“0 次 ripgrep 就能开始干活”；一旦你修改了相关文件或发现记忆有过期/冲突，必须立刻用 `replace_memory` 把对应条目更新为最新事实。',
          ]
        : []),
      ...(ctx.isSubdialog
        ? [
            `工作流：先做事 → 再提炼（\`update_reminder\`；必要时整理差遣牒更新提案并诉请 \`@${ctx.taskdocMaintainerId}\` 合并写入）→ 然后 \`clear_mind\` 清空噪音。`,
          ]
        : [
            '工作流：先做事 → 再提炼（`update_reminder` + `change_mind(progress)`）→ 然后 `clear_mind` 清空噪音。',
          ]),
      '当 context health 变黄/红：立刻停止继续大实现/大阅读；先提炼，再 clear。',
      '不要把长日志/大段 tool output 直接塞进差遣牒；差遣牒只写结论+下一步；细节只保留必要摘录放提醒项。',
    ].join('\n');

    return `${title}\n\n${body}`.trim();
  }

  const teamMemoryLine = '- Team memory: stable shared conventions (cross-task).';
  const personalMemoryLine =
    '- Personal memory: stable personal habits/preferences and responsibility-scope knowledge. Maintain a compact responsibility-area rtws index (exact key doc/code paths + minimal key facts) to reduce repeat file reads; do not store per-task state.';

  const body = [
    'Dialog history and tool outputs are temporary: they accumulate quickly, become stale, and increase cognitive load. Within a course, you cannot truly drop that history except via `clear_mind`.',
    '`clear_mind` starts a new course while preserving Taskdoc, reminders, and memory layers. Therefore, before clearing, distill key information into durable layers:',
    '- Taskdoc (`*.tsk/`): team-shared task contract (goals/constraints/progress). Keep it small enough to read every course.',
    `- When updating any Taskdoc section: each call replaces the entire section; always start from the current injected content and merge/compress; do not overwrite other contributors; add an explicit owner tag for entries you maintain (e.g., \`- [owner:@${ctx.agentId}] ...\` or a \`### @${ctx.agentId}\` block).`,
    '- Taskdoc `progress` is the team’s shared bulletin board: distilled milestone snapshots (key decisions/current status/next steps), not raw logs.',
    '- Important: the Taskdoc content is injected inline into the context (the latest as of this generation). Review the injected Taskdoc instead of trying to read files under `*.tsk/` via general file tools (they will be rejected).',
    '- Convention: keep Taskdoc `constraints` focused on task-specific requirements. Do not duplicate global, system-enforced rules already stated in system prompt/tool docs (e.g. `.tsk/` encapsulation bans general file tools).',
    '- Reminders (working set): your high-frequency per-dialog worklog + critical details (not a team bulletin board); keep it small (often 1–3 items), prefer `update_reminder` to compress/merge; delete when obsolete.',
    teamMemoryLine,
    personalMemoryLine,
    '',
    ...(ctx.isSubdialog
      ? [
          `You are currently in a subdialog: \`change_mind\` is not allowed here. When Taskdoc should be updated (especially the shared progress bulletin board), tellask the Taskdoc maintainer \`@${ctx.taskdocMaintainerId}\` with a fully merged replacement draft (full-section replacement). Do not claim it is updated until you see a receipt.`,
        ]
      : [
          'You are currently in the main dialog: you are responsible for keeping the team-shared Taskdoc coherent and up to date (especially the progress bulletin board). Merge proposals from teammates/subdialogs promptly and keep it concise.',
        ]),
    ...(ctx.agentHasTeamMemoryTools
      ? [
          'Hint: you have team-memory tools (`add_team_memory` / `replace_team_memory` / `drop_team_memory` / `clear_team_memory`) and may maintain team memory when it is truly stable and worth sharing.',
        ]
      : []),
    ...(ctx.agentHasPersonalMemoryTools
      ? [
          'Hint: you have personal-memory tools (`add_memory` / `replace_memory` / `drop_memory` / `clear_memory`). Goal: maintain a compact responsibility-area rtws index (exact key doc/code paths + minimal key facts) so you can start work with 0 ripgrep within your scope. If you changed those files or detect staleness/conflicts, immediately `replace_memory` to keep it accurate.',
        ]
      : []),
    ...(ctx.isSubdialog
      ? [
          `Workflow: do work → distill (\`update_reminder\`; when Taskdoc needs updates, draft a merged replacement and ask \`@${ctx.taskdocMaintainerId}\`) → then \`clear_mind\` to drop noise.`,
        ]
      : [
          'Workflow: do work → distill (`update_reminder` + `change_mind(progress)`) → then `clear_mind` to drop noise.',
        ]),
    'When context health turns yellow/red: treat it as a hard stop; distill first, then clear.',
    'Do not paste long logs/tool outputs into Taskdoc; Taskdoc should record decisions + next steps; keep only essential excerpts in reminders.',
  ].join('\n');

  return `${title}\n\n${body}`.trim();
}

function buildFuncToolUsageText(language: LanguageCode, funcTools: FuncTool[]): string {
  if (funcTools.length === 0) {
    return language === 'zh' ? '没有可用的函数工具。' : 'No function tools available.';
  }

  return funcTools
    .map((tool) => {
      const schema = tool.parameters;

      const isRecord = (value: unknown): value is Record<string, unknown> =>
        typeof value === 'object' && value !== null && !Array.isArray(value);

      const requiredValue = schema['required'];
      const required =
        Array.isArray(requiredValue) && requiredValue.every((v) => typeof v === 'string')
          ? requiredValue
          : [];
      const req = required.length > 0 ? required.join(', ') : noneRequiredFieldsText(language);

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
      const labels = funcToolUsageLabels(language);
      const toolDesc = tool.descriptionI18n
        ? (tool.descriptionI18n[language] ?? tool.descriptionI18n.en ?? tool.description)
        : (tool.description ?? '');
      return `#### ${labels.toolLabel}: ${tool.name}\n\n${toolDesc}\n\n- ${labels.invocationLabel}: ${labels.invocationBody}\n- ${labels.requiredLabel}: ${req}\n- ${labels.parametersLabel}:\n${props}`.trim();
    })
    .join('\n\n');
}

export function buildIntrinsicToolUsageText(language: LanguageCode, funcTools: FuncTool[]): string {
  const usage = buildFuncToolUsageText(language, funcTools).trim();
  if (usage === '') return language === 'zh' ? '（无）' : '(none)';
  return usage;
}
