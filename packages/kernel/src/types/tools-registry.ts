import type { I18nText } from './i18n';

export type ToolKind = 'func';

export type ToolsetSource = 'dominds' | 'mcp' | 'app';
export type ToolAvailabilityProtocolVersion = 'tool-availability.v1';
export type ToolAvailabilityLayerStatus = 'ready' | 'error' | 'not_applicable';
export type ToolAvailabilityUpdateReason =
  | 'registry_changed'
  | 'member_binding_changed'
  | 'app_dynamic_availability_changed'
  | 'runtime_lease_changed';

export type ToolInfo = {
  name: string;
  kind: ToolKind;
  description?: string;
  descriptionI18n?: I18nText;
};

export type ToolsetInfo = {
  name: string;
  source: ToolsetSource;
  descriptionI18n?: I18nText;
  tools: ToolInfo[];
};

export type ToolAvailabilityDialogContext = Readonly<{
  rootId: string;
  selfId: string;
  sessionSlug?: string;
  status?: 'running' | 'completed' | 'archived' | 'unknown';
}>;

export type ToolAvailabilityContext = Readonly<{
  agentId?: string;
  taskDocPath?: string;
  dialog?: ToolAvailabilityDialogContext;
}>;

export type ToolAvailabilityRegistryLayer = Readonly<{
  status: 'ready';
  revision: string;
  toolsets: ToolsetInfo[];
}>;

export type MemberToolBindingLayer = Readonly<{
  status: ToolAvailabilityLayerStatus;
  revision: string;
  memberId?: string;
  declaredToolsetSelectors: ReadonlyArray<string>;
  declaredToolIds: ReadonlyArray<string>;
  resolvedStaticToolsetIds: ReadonlyArray<string>;
  resolvedDirectToolIds: ReadonlyArray<string>;
  unresolvedDeclaredToolsetIds: ReadonlyArray<string>;
  unresolvedDeclaredToolIds: ReadonlyArray<string>;
  errorText?: string;
}>;

export type AppDynamicToolAvailabilityLayer = Readonly<{
  status: ToolAvailabilityLayerStatus;
  revision: string;
  memberId?: string;
  taskDocPath?: string;
  toolsetIds: ReadonlyArray<string>;
  unresolvedToolsetIds: ReadonlyArray<string>;
  errorText?: string;
}>;

export type McpRuntimeLeaseInfo = Readonly<{
  serverId: string;
  transport: 'stdio' | 'streamable_http';
}>;

export type McpRuntimeLeaseLayer = Readonly<{
  status: ToolAvailabilityLayerStatus;
  revision: string;
  dialogKey?: string;
  leases: ReadonlyArray<McpRuntimeLeaseInfo>;
  errorText?: string;
}>;

export type ToolAvailabilityComposition = Readonly<{
  revision: string;
  visibleToolsetIds: ReadonlyArray<string>;
  visibleToolsets: ReadonlyArray<ToolsetInfo>;
  visibleDirectToolIds: ReadonlyArray<string>;
  visibleDirectTools: ReadonlyArray<ToolInfo>;
  runtimeLeaseAffectsVisibility: false;
}>;

export type ToolAvailabilitySnapshot = Readonly<{
  protocolVersion: ToolAvailabilityProtocolVersion;
  context: ToolAvailabilityContext;
  layers: Readonly<{
    registry: ToolAvailabilityRegistryLayer;
    memberBinding: MemberToolBindingLayer;
    appDynamicAvailability: AppDynamicToolAvailabilityLayer;
    runtimeLease: McpRuntimeLeaseLayer;
  }>;
  composition: ToolAvailabilityComposition;
  timestamp: string;
}>;
