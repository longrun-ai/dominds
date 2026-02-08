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
import { getWorkLanguage } from '../shared/runtime-language';
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
import { isShellToolName, listShellSpecialistMemberIds } from '../tools/shell-tools';
import { buildToolsetManualTools, formatToolsetManualIntro } from '../tools/toolset-manual';
import {
  defaultPersonaText,
  funcToolRulesText as formatFuncToolRulesText,
  memoriesSummaryLinePersonal,
  memoriesSummaryLineShared,
  memoriesSummarySectionPersonal,
  memoriesSummarySectionShared,
  memoriesSummaryTitle,
  memoryPreambleLabels,
  noneText,
  personalMemoriesHeader,
  personalScopeLabel,
  sharedMemoriesHeader,
  sharedScopeLabel,
  taskdocCanonicalCopy,
} from './minds-i18n';
import { buildSystemPrompt, formatTeamIntro } from './system-prompt';
import {
  buildIntrinsicToolUsageText,
  buildMemorySystemPrompt,
  buildShellPolicyPrompt,
} from './system-prompt-parts';

type ReadAgentMindResult = { kind: 'found'; text: string } | { kind: 'missing' };
type ReadMindsTextResult = { kind: 'found'; text: string } | { kind: 'missing' };

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

async function readMindsTextResult(fn: string): Promise<ReadMindsTextResult> {
  const mindFn = path.join('.minds', fn);
  try {
    const st = await stat(mindFn);
    if (!st.isFile()) return { kind: 'missing' };
  } catch (error: unknown) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === 'ENOENT'
    ) {
      return { kind: 'missing' };
    }
    log.warn(`Failed stating file '${mindFn}':`, error);
    return { kind: 'missing' };
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

async function readMindsTextPreferred(options: {
  preferredFilenames: readonly string[];
  noFileDefault: string;
}): Promise<string> {
  for (const fn of options.preferredFilenames) {
    const result = await readMindsTextResult(fn);
    if (result.kind === 'found') return result.text;
  }
  return options.noFileDefault;
}

export async function loadAgentMinds(
  agentId?: string,
  dialog?: Dialog,
  options?: {
    missingToolsetPolicy?: 'warn' | 'silent';
  },
): Promise<{
  team: Team;
  agent: Team.Member;
  systemPrompt: string;
  memories: ChatMessage[];
  agentTools: Tool[];
}> {
  const workingLanguage = getWorkLanguage();
  const missingToolsetPolicy = options?.missingToolsetPolicy ?? 'warn';
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
  const envIntroRaw = await readMindsTextPreferred({
    preferredFilenames: [`env.${workingLanguage}.md`, 'env.md'],
    noFileDefault: '',
  });
  const none = noneText(workingLanguage);
  const persona = personaRaw && personaRaw.trim() !== '' ? personaRaw : none;
  const knowledge = knowledgeRaw && knowledgeRaw.trim() !== '' ? knowledgeRaw : none;
  const lessons = lessonsRaw && lessonsRaw.trim() !== '' ? lessonsRaw : none;
  const envIntro = envIntroRaw && envIntroRaw.trim() !== '' ? envIntroRaw : '';

  // Introduction of all team members (mark "(self)" for the current agent)
  const teamIntro = formatTeamIntro(team, agent.id, workingLanguage);

  // Compose tool list from member's resolved toolsets and tools + built-in human tool
  // Get base tools from agent (excluding intrinsic dialog control tools which are always injected)
  // shell_specialists is intended for visible teammates only. Hidden members are exempt from this
  // policy and may carry shell tools.
  const agentIsShellSpecialist = team.shellSpecialists.includes(agent.id) || agent.hidden === true;

  const baseAgentTools: Tool[] = (() => {
    const tools = agent.listTools({ onMissingToolset: missingToolsetPolicy });
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

  const toolsetNames = agent
    .listResolvedToolsetNames({ onMissing: missingToolsetPolicy })
    .filter((name) => {
      if (name === 'os') return agentIsShellSpecialist;
      return true;
    });
  const manualTools = buildToolsetManualTools({
    toolsetNames,
    existingToolNames: new Set(agentTools.map((t) => t.name)),
  });
  if (manualTools.tools.length > 0) {
    agentTools.push(...manualTools.tools);
  }

  const funcTools = agentTools.filter((t): t is FuncTool => t.type === 'func');

  const agentHasShellTools = funcTools.some((t) => isShellToolName(t.name));
  const agentHasReadonlyShell = funcTools.some((t) => t.name === 'readonly_shell');
  const shellSpecialistMemberIds = listShellSpecialistMemberIds(team);

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
  const promptdocContext = {
    language: workingLanguage,
    agentId: agent.id,
    isSubdialog,
    taskdocMaintainerId,
    agentHasTeamMemoryTools,
    agentHasPersonalMemoryTools,
    agentIsShellSpecialist,
    agentHasShellTools,
    agentHasReadonlyShell,
    shellSpecialistMemberIds,
  };

  const policyText = [
    buildShellPolicyPrompt(promptdocContext),
    buildMemorySystemPrompt(promptdocContext),
    taskdocCanonicalCopy(workingLanguage),
  ]
    .filter((b) => b.trim() !== '')
    .join('\n\n');

  const intrinsicToolUsageText = buildIntrinsicToolUsageText(workingLanguage, intrinsicFuncTools);
  const toolsetManualIntro = formatToolsetManualIntro(workingLanguage, manualTools.toolNames);
  const funcToolRulesText = funcTools.length > 0 ? formatFuncToolRulesText(workingLanguage) : '';

  const systemPrompt = buildSystemPrompt({
    language: workingLanguage,
    dialogScope: isSubdialog ? 'sideline' : 'mainline',
    agent,
    persona,
    knowledge,
    lessons,
    envIntro,
    teamIntro,
    funcToolRulesText,
    policyText,
    intrinsicToolUsageText,
    toolsetManualIntro,
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
