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
import { formatUnifiedTimestamp } from '../shared/utils/time';
import { Team } from '../team';
import type { FuncTool, TellaskTool, Tool } from '../tool';
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
  noTellaskToolsText,
  noneRequiredFieldsText,
  noneText,
  personalMemoriesHeader,
  personalScopeLabel,
  sharedMemoriesHeader,
  sharedScopeLabel,
} from './minds-i18n';
import { buildSystemPrompt, formatTeamIntro } from './system-prompt';

type ReadAgentMindResult = { kind: 'found'; text: string } | { kind: 'missing' };

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
  tellaskTools: TellaskTool[];
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
  // Get base tools from agent (excluding intrinsic tools which are now managed by Dialog)
  const baseAgentTools: Tool[] = agent.listTools();

  // Use only base agent tools - intrinsic tools are handled separately via Dialog
  const agentTools: Tool[] = baseAgentTools;

  const tellaskTools = agentTools.filter((t): t is TellaskTool => t.type === 'tellask');
  const funcTools = agentTools.filter((t): t is FuncTool => t.type === 'func');

  // Generate tool usage text - keep regular and intrinsic tools completely separate
  let toolUsageText: string;
  let intrinsicToolInstructions: string = '';
  let funcToolUsageText: string = '';
  let funcToolRulesText: string = '';

  // Regular tools (from agent)
  toolUsageText =
    tellaskTools.length > 0
      ? tellaskTools
          .map((tool) => {
            const usage = getTextForLanguage(
              { i18n: tool.usageDescriptionI18n, fallback: tool.usageDescription },
              workingLanguage,
            );
            return `#### @${tool.name}\n\n${usage}\n`;
          })
          .join('\n')
      : noTellaskToolsText(workingLanguage);
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

  // Intrinsic tools (from dialog, if available)
  if (dialog) {
    intrinsicToolInstructions = dialog.getIntrinsicToolInstructions();
  }

  const systemPrompt = buildSystemPrompt({
    language: workingLanguage,
    agent,
    persona,
    knowledge,
    lessons,
    teamIntro,
    toolUsageText,
    intrinsicToolInstructions,
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
    tellaskTools,
  };
}
