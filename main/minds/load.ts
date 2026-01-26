/**
 * Module: minds/load
 *
 * Loads agent minds/persona/knowledge/lessons and memory files from `.minds`.
 * Composes the system prompt and aggregates memories with optional hints.
 */
import type { Dirent } from 'fs';
import { access, readFile, readdir, stat } from 'fs/promises';
import path from 'path';
import { Dialog } from '../dialog';
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
} from './minds-i18n';
import { buildSystemPrompt, formatTeamIntro } from './system-prompt';

type ReadAgentMindResult = { kind: 'found'; text: string } | { kind: 'missing' };

function listShellCapableMembers(team: Team): string[] {
  const ids: string[] = [];
  for (const member of Object.values(team.members)) {
    const tools = member.listTools();
    const hasShell = tools.some(
      (t) =>
        t.type === 'func' &&
        (t.name === 'shell_cmd' || t.name === 'stop_daemon' || t.name === 'get_daemon_output'),
    );
    if (hasShell) {
      ids.push(member.id);
    }
  }
  return ids;
}

function buildShellPolicyPrompt(options: {
  language: LanguageCode;
  agentHasShellTools: boolean;
  shellCapableMemberIds: string[];
}): string {
  const { language, agentHasShellTools, shellCapableMemberIds } = options;
  const title =
    language === 'zh' ? '### Shell 执行策略（重要）' : '### Shell Execution Policy (Important)';

  const shellPeers =
    shellCapableMemberIds.length > 0
      ? shellCapableMemberIds.map((id) => `@${id}`).join(', ')
      : language === 'zh'
        ? '（未发现任何具备 shell 能力的队友）'
        : '(no shell-capable teammates found)';

  if (agentHasShellTools) {
    const body =
      language === 'zh'
        ? [
            '你具备 shell 执行能力（高风险）。使用前必须先做风险识别与最小化：',
            '- 说明目的、预期输出/验证方式、预期工作目录与影响面。',
            '- 优先选择只读命令；写入/删除/网络/权限相关操作必须解释理由与安全边界。',
            '- 如果不确定命令后果，先提出更安全的替代方案或向人类/队友确认。',
            '',
            `同队具备 shell 能力的成员：${shellPeers}`,
          ].join('\n')
        : [
            'You have shell execution capability (high-risk). Before using it, do risk identification and minimize blast radius:',
            '- State intent, expected output/verification, expected working directory, and scope of impact.',
            '- Prefer read-only commands; for writes/deletes/network/privilege-related actions, justify and state safety boundaries.',
            '- If unsure about consequences, propose a safer alternative or confirm with a human/teammate first.',
            '',
            `Shell-capable teammates: ${shellPeers}`,
          ].join('\n');
    return `${title}\n\n${body}`.trim();
  }

  const body =
    language === 'zh'
      ? [
          '你不具备 shell 工具（本环境仅 @cmdr 等专员可执行 shell）：不要尝试“编造/假设”命令输出，也不要要求系统直接执行。',
          '当你确实需要 shell 执行时：请转交给具备 shell 能力的专员队友，并提供充分理由与可审查的命令提案：',
          '- 你要达成的目标（why）',
          '- 建议命令（what）+ 预期工作目录（cwd）+ 预期输出/验证方式（how to verify）',
          '- 风险评估与安全边界（risk & guardrails）',
          `可转交的 shell 专员队友：${shellPeers}`,
          '',
          '重要：如果你打算让队友执行命令，请在同一条消息里给出完整的 tellask 诉请块（以第 0 列开头的 `!?@cmdr` 行），不要只说“我会请 @cmdr 运行”。',
          '重要：在你看到 @cmdr 的回执（command/exit_code/stdout/stderr）之前，不要声称“已运行/已通过/无错”。',
        ].join('\n')
      : [
          'You do not have shell tools configured: do not fabricate/assume command output, and do not ask the system to execute commands directly.',
          'When you truly need shell execution, delegate to a shell-capable specialist teammate with a justified, reviewable proposal:',
          '- Goal (why)',
          '- Proposed command (what) + expected working directory (cwd) + expected output/verification (how to verify)',
          '- Risk assessment and guardrails (risk & guardrails)',
          '',
          `Shell-capable specialist teammates: ${shellPeers}`,
          '',
          'Important: if you intend to delegate, include the full tellask block (a column-0 `!?@cmdr` line) in the same message; do not just say “I will ask @cmdr to run it”.',
          'Important: do not claim “ran/passed/no errors” until you see @cmdr’s receipt (command/exit_code/stdout/stderr).',
        ].join('\n');
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
  const baseAgentTools: Tool[] = agent.listTools();

  // Inject intrinsic dialog control tools as function tools (available to all agents).
  const intrinsicFuncTools: FuncTool[] = [
    addReminderTool,
    deleteReminderTool,
    updateReminderTool,
    clearMindTool,
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

  const agentHasShellTools = funcTools.some(
    (t) => t.name === 'shell_cmd' || t.name === 'stop_daemon' || t.name === 'get_daemon_output',
  );
  const shellCapableMemberIds = listShellCapableMembers(team);
  const shellPolicyPrompt = buildShellPolicyPrompt({
    language: workingLanguage,
    agentHasShellTools,
    shellCapableMemberIds,
  });

  const toolsetPromptText = (() => {
    const toolsetNames = agent.listResolvedToolsetNames();
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

  // Generate tool usage text (shell policy + reminder working-set policy + toolset prompts).
  let toolUsageText: string;
  let funcToolUsageText: string = '';
  let funcToolRulesText: string = '';

  const remindersPolicyTitle =
    workingLanguage === 'zh'
      ? '### 提醒项（工作集）使用策略（重要）'
      : '### Reminder Working-Set Policy (Important)';
  const remindersPolicyBody =
    workingLanguage === 'zh'
      ? [
          '提醒项不是“噪音”，而是你跨新一轮/新回合携带的工作集（worklog）。',
          '你应主动维护少量高价值提醒项：优先 update_reminder 压缩/合并；不再需要就 delete_reminder。',
          '当上下文健康变黄/红：先收敛提醒项内容，再 change_mind(progress) 提炼，然后 clear_mind。',
        ].join('\n')
      : [
          'Reminders are not “noise”; they are your cross-round working set (worklog).',
          'Actively curate a small set of high-value reminders: prefer update_reminder to compress/merge; delete when no longer needed.',
          'At yellow/red context health: compress reminders first, then change_mind(progress), then clear_mind.',
        ].join('\n');
  const remindersPolicyPrompt = `${remindersPolicyTitle}\n\n${remindersPolicyBody}`;

  toolUsageText = (() => {
    const prefix = [shellPolicyPrompt, remindersPolicyPrompt, toolsetPromptText]
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
