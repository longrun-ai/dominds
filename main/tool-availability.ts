import { createHash } from 'crypto';

import type {
  AppDynamicToolAvailabilityLayer,
  McpRuntimeLeaseLayer,
  MemberToolBindingLayer,
  ToolAvailabilityContext,
  ToolAvailabilityRegistryLayer,
  ToolAvailabilitySnapshot,
  ToolInfo,
  ToolsetInfo,
} from '@longrun-ai/kernel/types/tools-registry';
import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';
import { resolveDynamicAppToolAvailabilityForMember } from './apps/runtime';
import { getMcpRuntimeLeasesForDialog } from './mcp/supervisor';
import { Team } from './team';
import type { Tool } from './tool';
import { getTool, getToolset, getToolsetMeta, toolsetsRegistry } from './tools/registry';

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
    resolvedStaticToolsetIds: [],
    resolvedDirectToolIds: [],
    unresolvedDeclaredToolsetIds: [],
    unresolvedDeclaredToolIds: [],
  };
  return {
    ...payload,
    revision: computeRevision(payload),
  };
}

function buildMemberBindingLayer(member: Team.Member): MemberToolBindingLayer {
  const declaredToolsetSelectors = [...(member.toolsets ?? [])];
  const declaredToolIds = [...(member.tools ?? [])];
  const resolvedStaticToolsetIds = member.listResolvedToolsetNames({
    onMissing: 'silent',
    dynamicToolsetNames: [],
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
    resolvedStaticToolsetIds,
    resolvedDirectToolIds,
    unresolvedDeclaredToolsetIds,
    unresolvedDeclaredToolIds,
  };
  return {
    ...payload,
    revision: computeRevision(payload),
  };
}

function buildNotApplicableAppDynamicLayer(): AppDynamicToolAvailabilityLayer {
  const payload = {
    status: 'not_applicable' as const,
    toolsetIds: [],
    unresolvedToolsetIds: [],
  };
  return {
    ...payload,
    revision: computeRevision(payload),
  };
}

async function buildAppDynamicLayer(params: {
  memberId: string;
  taskDocPath: string;
  agentId?: string;
  dialog?: ToolAvailabilityContext['dialog'];
}): Promise<AppDynamicToolAvailabilityLayer> {
  const result = await resolveDynamicAppToolAvailabilityForMember({
    rtwsRootAbs: process.cwd(),
    memberId: params.memberId,
    taskDocPath: params.taskDocPath,
    agentId: params.agentId,
    dialogId: params.dialog?.selfId,
    mainDialogId: params.dialog?.rootId,
    sessionSlug: params.dialog?.sessionSlug,
  });
  if (result.status === 'not_applicable') {
    return buildNotApplicableAppDynamicLayer();
  }
  if (result.status === 'error') {
    const payload = {
      status: 'error' as const,
      memberId: params.memberId,
      taskDocPath: params.taskDocPath,
      toolsetIds: [],
      unresolvedToolsetIds: [],
      errorText: result.errorText,
    };
    return {
      ...payload,
      revision: computeRevision(payload),
    };
  }
  const unresolvedToolsetIds = result.toolsetIds.filter(
    (toolsetId) => getToolset(toolsetId) === undefined,
  );
  const payload = {
    status: 'ready' as const,
    memberId: params.memberId,
    taskDocPath: params.taskDocPath,
    toolsetIds: [...result.toolsetIds],
    unresolvedToolsetIds,
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

function buildVisibleDirectTools(layer: MemberToolBindingLayer): {
  visibleDirectToolIds: string[];
  visibleDirectTools: ToolInfo[];
} {
  if (layer.status !== 'ready') {
    return { visibleDirectToolIds: [], visibleDirectTools: [] };
  }
  const visibleDirectTools = layer.resolvedDirectToolIds
    .map((toolId) => getTool(toolId))
    .filter((tool): tool is Tool => tool !== undefined)
    .map((tool) => toolToInfo(tool, false));
  return {
    visibleDirectToolIds: [...layer.resolvedDirectToolIds],
    visibleDirectTools,
  };
}

function buildComposition(args: {
  registry: ToolAvailabilityRegistryLayer;
  memberBinding: MemberToolBindingLayer;
  appDynamicAvailability: AppDynamicToolAvailabilityLayer;
}) {
  const registryById = new Map(
    args.registry.toolsets.map((toolset) => [toolset.name, toolset] as const),
  );
  const visibleToolsetIds: string[] = [];
  const seen = new Set<string>();
  if (args.memberBinding.status === 'ready') {
    for (const toolsetId of args.memberBinding.resolvedStaticToolsetIds) {
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
  if (args.appDynamicAvailability.status === 'ready') {
    for (const toolsetId of args.appDynamicAvailability.toolsetIds) {
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
  const visibleToolsets = visibleToolsetIds
    .map((toolsetId) => registryById.get(toolsetId))
    .filter((toolset): toolset is ToolsetInfo => toolset !== undefined);
  const directTools = buildVisibleDirectTools(args.memberBinding);
  const payload = {
    visibleToolsetIds,
    visibleToolsets,
    visibleDirectToolIds: directTools.visibleDirectToolIds,
    visibleDirectTools: directTools.visibleDirectTools,
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
  const memberBinding =
    member !== null ? buildMemberBindingLayer(member) : buildNotApplicableMemberBindingLayer();
  const appDynamicAvailability =
    member !== null && typeof args?.taskDocPath === 'string' && args.taskDocPath.trim() !== ''
      ? await buildAppDynamicLayer({
          memberId: member.id,
          taskDocPath: args.taskDocPath.trim(),
          agentId: args.agentId?.trim(),
          dialog: args.dialog,
        })
      : buildNotApplicableAppDynamicLayer();
  const runtimeLease = buildRuntimeLeaseLayer(args?.dialog);
  const composition = buildComposition({
    registry,
    memberBinding,
    appDynamicAvailability,
  });
  return {
    protocolVersion: TOOL_AVAILABILITY_PROTOCOL_VERSION,
    context,
    layers: {
      registry,
      memberBinding,
      appDynamicAvailability,
      runtimeLease,
    },
    composition,
    timestamp: formatUnifiedTimestamp(new Date()),
  };
}
