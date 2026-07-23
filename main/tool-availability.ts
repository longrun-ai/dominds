import { createHash } from 'crypto';

import type {
  McpRuntimeLeaseLayer,
  MemberToolBindingLayer,
  ToolAvailabilityContext,
  ToolAvailabilityRegistryLayer,
  ToolAvailabilitySnapshot,
  ToolInfo,
  ToolsetInfo,
} from '@longrun-ai/kernel/types/tools-registry';
import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';
import { getMcpRuntimeLeasesForDialog } from './mcp/supervisor';
import { Team } from './team';
import type { Tool } from './tool';
import {
  addReminderTool,
  changeMindTool,
  clearMindTool,
  deleteReminderTool,
  doMindTool,
  migrateReminderTool,
  mindMoreTool,
  neverMindTool,
  recallTaskdocTool,
  updateReminderTool,
} from './tools/ctrl';
import { getTool, getToolset, getToolsetMeta, toolsetsRegistry } from './tools/registry';
import { isShellToolName } from './tools/shell-tools';
import { readSkillTool } from './tools/skills';
import { buildManTool } from './tools/toolset-manual';

const TOOL_AVAILABILITY_PROTOCOL_VERSION = 'tool-availability.v1' as const;

function computeRevision(payload: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex')}`;
}

function toolToInfo(tool: Tool, includeParameters: boolean): ToolInfo {
  return {
    name: tool.name,
    kind: 'func',
    description: tool.description,
    descriptionI18n: tool.descriptionI18n,
    ...(includeParameters ? { parameters: tool.parameters } : {}),
  };
}

export function listRegisteredToolsetCatalog(): ToolsetInfo[] {
  const toolsets: ToolsetInfo[] = [];
  for (const [toolsetName, tools] of toolsetsRegistry.entries()) {
    const meta = getToolsetMeta(toolsetName);
    toolsets.push({
      name: toolsetName,
      source: meta?.source ?? 'dominds',
      descriptionI18n: meta?.descriptionI18n,
      tools: tools.map((tool) => toolToInfo(tool, meta?.source === 'mcp')),
    });
  }
  return toolsets;
}

export function computeGlobalToolRegistryRevision(): string {
  return computeRevision(listRegisteredToolsetCatalog());
}

function buildRegistryLayer(): ToolAvailabilityRegistryLayer {
  const toolsets = listRegisteredToolsetCatalog();
  return {
    status: 'ready',
    revision: computeRevision(toolsets),
    toolsets,
  };
}

function buildNotApplicableMemberBindingLayer(): MemberToolBindingLayer {
  const payload = {
    status: 'not_applicable' as const,
    declaredToolsetSelectors: [],
    declaredToolIds: [],
    resolvedToolsetIds: [],
    resolvedDirectToolIds: [],
    unresolvedDeclaredToolsetIds: [],
    unresolvedDeclaredToolIds: [],
  };
  return {
    ...payload,
    revision: computeRevision(payload),
  };
}

function buildMemberBindingLayer(
  member: Team.Member,
  mcpDeclaredToolsets: Team.McpDeclaredToolsets,
): MemberToolBindingLayer {
  const declaredToolsetSelectors = [...(member.toolsets ?? [])];
  const declaredToolIds = [...(member.tools ?? [])];
  const declaredMcpToolsetNames =
    mcpDeclaredToolsets.kind === 'loaded' ? mcpDeclaredToolsets.declaredServerIds : undefined;
  const invalidMcpToolsetNames =
    mcpDeclaredToolsets.kind === 'loaded' ? mcpDeclaredToolsets.invalidServerIds : undefined;
  const resolvedToolsetIds = member.listResolvedToolsetNames({
    onMissing: 'silent',
    declaredMcpToolsetNames,
    invalidMcpToolsetNames,
  });
  const resolvedDirectToolIds: string[] = [];
  const unresolvedDeclaredToolIds: string[] = [];
  for (const toolId of declaredToolIds) {
    if (getTool(toolId)) {
      resolvedDirectToolIds.push(toolId);
    } else {
      unresolvedDeclaredToolIds.push(toolId);
    }
  }
  const unresolvedDeclaredToolsetIds = declaredToolsetSelectors.filter((entry) => {
    if (entry === '*' || entry.startsWith('!')) {
      return false;
    }
    return getToolset(entry) === undefined;
  });
  const payload = {
    status: 'ready' as const,
    memberId: member.id,
    declaredToolsetSelectors,
    declaredToolIds,
    resolvedToolsetIds,
    resolvedDirectToolIds,
    unresolvedDeclaredToolsetIds,
    unresolvedDeclaredToolIds,
  };
  return {
    ...payload,
    revision: computeRevision(payload),
  };
}

function buildRuntimeLeaseLayer(dialog: ToolAvailabilityContext['dialog']): McpRuntimeLeaseLayer {
  if (!dialog || dialog.rootId.trim() === '' || dialog.selfId.trim() === '') {
    const payload = {
      status: 'not_applicable' as const,
      leases: [],
    };
    return {
      ...payload,
      revision: computeRevision(payload),
    };
  }
  const normalizedRootId = dialog.rootId.trim();
  const normalizedSelfId = dialog.selfId.trim();
  const dialogKey =
    normalizedRootId === normalizedSelfId
      ? normalizedSelfId
      : `${normalizedRootId}#${normalizedSelfId}`;
  const leases = [...getMcpRuntimeLeasesForDialog(dialogKey)];
  const payload = {
    status: 'ready' as const,
    dialogKey,
    leases,
  };
  return {
    ...payload,
    revision: computeRevision(payload),
  };
}

function buildVisibleStandaloneTools(
  layer: MemberToolBindingLayer,
  existingToolNames: ReadonlySet<string>,
  agentIsShellSpecialist: boolean,
): {
  visibleStandaloneToolIds: string[];
  visibleStandaloneTools: ToolInfo[];
} {
  if (layer.status !== 'ready') {
    return { visibleStandaloneToolIds: [], visibleStandaloneTools: [] };
  }
  const visibleStandaloneToolIds: string[] = [];
  const visibleStandaloneTools: ToolInfo[] = [];
  for (const toolId of layer.resolvedDirectToolIds) {
    const tool = getTool(toolId);
    if (!tool) {
      continue;
    }
    if (!agentIsShellSpecialist && isShellToolName(tool.name)) {
      continue;
    }
    if (existingToolNames.has(tool.name)) {
      continue;
    }
    visibleStandaloneToolIds.push(tool.name);
    visibleStandaloneTools.push(toolToInfo(tool, false));
  }
  const injectedStandaloneTools: Tool[] = [buildManTool(), readSkillTool];
  for (const tool of injectedStandaloneTools) {
    if (
      !visibleStandaloneToolIds.includes(tool.name) &&
      !existingToolNames.has(tool.name) &&
      (agentIsShellSpecialist || !isShellToolName(tool.name))
    ) {
      visibleStandaloneToolIds.push(tool.name);
      visibleStandaloneTools.push(toolToInfo(tool, false));
    }
  }
  return {
    visibleStandaloneToolIds,
    visibleStandaloneTools,
  };
}

function buildIntrinsicControlToolset(dialog: ToolAvailabilityContext['dialog']): ToolsetInfo {
  const tools: Tool[] = [
    addReminderTool,
    deleteReminderTool,
    updateReminderTool,
    migrateReminderTool,
    clearMindTool,
    recallTaskdocTool,
  ];
  const isSideDialog = dialog !== undefined && dialog.rootId !== dialog.selfId;
  if (!isSideDialog) {
    tools.push(doMindTool, mindMoreTool, changeMindTool, neverMindTool);
  }
  const meta = getToolsetMeta('control');
  return {
    name: 'control',
    source: meta?.source ?? 'dominds',
    descriptionI18n: meta?.descriptionI18n,
    tools: tools.map((tool) => toolToInfo(tool, false)),
  };
}

function buildComposition(args: {
  registry: ToolAvailabilityRegistryLayer;
  memberBinding: MemberToolBindingLayer;
  dialog: ToolAvailabilityContext['dialog'];
  agentIsShellSpecialist: boolean;
}) {
  const registryById = new Map(
    args.registry.toolsets.map((toolset) => [toolset.name, toolset] as const),
  );
  const visibleToolsetIds: string[] = [];
  const seen = new Set<string>();
  if (args.memberBinding.status === 'ready') {
    for (const toolsetId of args.memberBinding.resolvedToolsetIds) {
      if (seen.has(toolsetId)) {
        continue;
      }
      if (!registryById.has(toolsetId)) {
        continue;
      }
      seen.add(toolsetId);
      visibleToolsetIds.push(toolsetId);
    }
  }
  const intrinsicControlToolset =
    args.memberBinding.status === 'ready' ? buildIntrinsicControlToolset(args.dialog) : undefined;
  if (intrinsicControlToolset !== undefined && !seen.has(intrinsicControlToolset.name)) {
    seen.add(intrinsicControlToolset.name);
    visibleToolsetIds.push(intrinsicControlToolset.name);
  }
  const visibleToolsets = visibleToolsetIds
    .map((toolsetId) =>
      toolsetId === intrinsicControlToolset?.name
        ? intrinsicControlToolset
        : registryById.get(toolsetId),
    )
    .filter((toolset): toolset is ToolsetInfo => toolset !== undefined)
    .map((toolset) =>
      args.agentIsShellSpecialist
        ? toolset
        : {
            ...toolset,
            tools: toolset.tools.filter((tool) => !isShellToolName(tool.name)),
          },
    );
  const toolsetToolNames = new Set(
    visibleToolsets.flatMap((toolset) => toolset.tools.map((tool) => tool.name)),
  );
  const standaloneTools = buildVisibleStandaloneTools(
    args.memberBinding,
    toolsetToolNames,
    args.agentIsShellSpecialist,
  );
  const payload = {
    visibleToolsetIds,
    visibleToolsets,
    visibleStandaloneToolIds: standaloneTools.visibleStandaloneToolIds,
    visibleStandaloneTools: standaloneTools.visibleStandaloneTools,
    runtimeLeaseAffectsVisibility: false as const,
  };
  return {
    ...payload,
    revision: computeRevision(payload),
  };
}

export async function createToolAvailabilitySnapshot(args?: {
  agentId?: string;
  taskDocPath?: string;
  dialog?: ToolAvailabilityContext['dialog'];
}): Promise<ToolAvailabilitySnapshot> {
  const context: ToolAvailabilityContext = {
    ...(typeof args?.agentId === 'string' && args.agentId.trim() !== ''
      ? { agentId: args.agentId.trim() }
      : {}),
    ...(typeof args?.taskDocPath === 'string' && args.taskDocPath.trim() !== ''
      ? { taskDocPath: args.taskDocPath.trim() }
      : {}),
    ...(args?.dialog ? { dialog: args.dialog } : {}),
  };
  const registry = buildRegistryLayer();
  const team = args?.agentId ? await Team.load() : null;
  const member = args?.agentId ? (team?.getMember(args.agentId) ?? null) : null;
  const mcpDeclaredToolsets =
    member !== null ? await Team.readMcpDeclaredToolsets() : { kind: 'missing' as const };
  const agentIsShellSpecialist =
    team !== null &&
    member !== null &&
    (team.shellSpecialists.includes(member.id) || member.hidden === true);
  const memberBinding =
    member !== null
      ? buildMemberBindingLayer(member, mcpDeclaredToolsets)
      : buildNotApplicableMemberBindingLayer();
  const runtimeLease = buildRuntimeLeaseLayer(args?.dialog);
  const composition = buildComposition({
    registry,
    memberBinding,
    dialog: context.dialog,
    agentIsShellSpecialist,
  });
  return {
    protocolVersion: TOOL_AVAILABILITY_PROTOCOL_VERSION,
    context,
    layers: {
      registry,
      memberBinding,
      runtimeLease,
    },
    composition,
    timestamp: formatUnifiedTimestamp(new Date()),
  };
}
