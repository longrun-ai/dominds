import {
  expandResourceTemplate,
  getMcpResource,
  listMcpResources,
  renderResourceContent,
} from '../mcp/resources';
import { withMcpCatalogClient } from '../mcp/supervisor';
import { getWorkLanguage } from '../runtime/work-language';
import { Team } from '../team';
import type { FuncTool } from '../tool';
import { toolFailure, toolSuccess } from '../tool';

function parseStringRecord(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('arguments must be an object with string values');
  }
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') {
      throw new Error(`arguments.${key} must be a string`);
    }
    out[key] = item;
  }
  return out;
}

async function listVisibleMcpServerIds(
  caller: Team.Member,
  taskDocPath?: string,
): Promise<Set<string>> {
  const dynamicToolsetNames = await Team.listDynamicToolsetNamesForMember({
    member: caller,
    taskDocPath,
  });
  const declared = await Team.readMcpDeclaredToolsets();
  const declaredMcpToolsetNames =
    declared.kind === 'loaded' ? declared.declaredServerIds : undefined;
  const invalidMcpToolsetNames = declared.kind === 'loaded' ? declared.invalidServerIds : undefined;
  return new Set(
    caller
      .listResolvedToolsetNames({
        onMissing: 'silent',
        dynamicToolsetNames,
        declaredMcpToolsetNames,
        invalidMcpToolsetNames,
      })
      .filter((toolsetName) => declaredMcpToolsetNames?.has(toolsetName)),
  );
}

export const listResourcesTool: FuncTool = {
  type: 'func',
  name: 'list_resources',
  description: 'List available Dominds resources and resource templates.',
  descriptionI18n: {
    en: 'List available Dominds resources and resource templates.',
    zh: '列出可用的 Dominds resources 与 resource templates。',
  },
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      serverId: { type: 'string', description: 'Optional MCP server ID filter.' },
      query: { type: 'string', description: 'Optional case-insensitive text filter.' },
      kind: {
        type: 'string',
        enum: ['resource', 'resource_template'],
        description: 'Optional resource kind filter.',
      },
    },
  },
  argsValidation: 'dominds',
  async call(_dlg, _caller, args) {
    const language =
      typeof _dlg?.getLastUserLanguageCode === 'function'
        ? _dlg.getLastUserLanguageCode()
        : getWorkLanguage();
    const serverId = typeof args.serverId === 'string' ? args.serverId.trim() : '';
    const visibleMcpServerIds = await listVisibleMcpServerIds(_caller, _dlg.taskDocPath);
    const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : '';
    const kind =
      args.kind === 'resource' || args.kind === 'resource_template' ? args.kind : undefined;
    const resources = listMcpResources().filter((resource) => {
      if (serverId !== '' && resource.serverId !== serverId) return false;
      if (!visibleMcpServerIds.has(resource.serverId)) return false;
      if (kind !== undefined && resource.kind !== kind) return false;
      if (query === '') return true;
      const haystack =
        resource.kind === 'resource'
          ? `${resource.id}\n${resource.serverId}\n${resource.uri}\n${resource.name}\n${resource.description ?? ''}`
          : `${resource.id}\n${resource.serverId}\n${resource.uriTemplate}\n${resource.name}\n${resource.description ?? ''}`;
      return haystack.toLowerCase().includes(query);
    });
    if (resources.length === 0) {
      return toolSuccess(language === 'zh' ? '（无匹配 resources）' : '(no matching resources)');
    }
    const lines = resources.map((resource) => {
      if (resource.kind === 'resource') {
        return [
          `- ${resource.id}`,
          `  kind: resource`,
          `  serverId: ${resource.serverId}`,
          `  uri: ${resource.uri}`,
          `  name: ${resource.name}`,
          ...(resource.description ? [`  description: ${resource.description}`] : []),
          ...(resource.mimeType ? [`  mimeType: ${resource.mimeType}`] : []),
        ].join('\n');
      }
      return [
        `- ${resource.id}`,
        `  kind: resource_template`,
        `  serverId: ${resource.serverId}`,
        `  uriTemplate: ${resource.uriTemplate}`,
        `  variables: ${resource.variables.join(', ') || '(none)'}`,
        `  name: ${resource.name}`,
        ...(resource.description ? [`  description: ${resource.description}`] : []),
        ...(resource.mimeType ? [`  mimeType: ${resource.mimeType}`] : []),
      ].join('\n');
    });
    return toolSuccess(lines.join('\n'));
  },
};

export const fetchResourceTool: FuncTool = {
  type: 'func',
  name: 'fetch_resource',
  description: 'Fetch one Dominds resource by resourceId. Resource templates require arguments.',
  descriptionI18n: {
    en: 'Fetch one Dominds resource by resourceId. Resource templates require arguments.',
    zh: '按 resourceId 读取一个 Dominds resource。resource template 需要提供 arguments。',
  },
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['resourceId'],
    properties: {
      resourceId: { type: 'string', description: 'Resource ID from list_resources.' },
      arguments: {
        type: 'object',
        additionalProperties: { type: 'string' },
        description: 'Template arguments for resource_template entries.',
      },
    },
  },
  argsValidation: 'dominds',
  async call(_dlg, _caller, args) {
    const language =
      typeof _dlg?.getLastUserLanguageCode === 'function'
        ? _dlg.getLastUserLanguageCode()
        : getWorkLanguage();
    const resourceId = typeof args.resourceId === 'string' ? args.resourceId.trim() : '';
    if (resourceId === '') {
      return toolFailure(
        language === 'zh' ? '错误：需要提供 resourceId。' : 'Error: resourceId is required.',
      );
    }
    const resource = getMcpResource(resourceId);
    if (!resource) {
      return toolFailure(
        language === 'zh'
          ? `错误：未找到 resource '${resourceId}'。`
          : `Error: resource '${resourceId}' was not found.`,
      );
    }
    const visibleMcpServerIds = await listVisibleMcpServerIds(_caller, _dlg.taskDocPath);
    if (!visibleMcpServerIds.has(resource.serverId)) {
      return toolFailure(
        language === 'zh'
          ? `错误：当前成员没有访问 resource '${resourceId}' 所属 MCP toolset 的权限。`
          : `Error: current member cannot access the MCP toolset that owns resource '${resourceId}'.`,
      );
    }
    let uri: string;
    try {
      const templateArgs = parseStringRecord(args.arguments);
      if (resource.kind === 'resource') {
        if (Object.keys(templateArgs).length > 0) {
          throw new Error(`Static resource '${resource.id}' does not accept arguments`);
        }
        uri = resource.uri;
      } else {
        uri = expandResourceTemplate(resource, templateArgs);
      }
    } catch (error: unknown) {
      return toolFailure(error instanceof Error ? error.message : String(error));
    }
    try {
      const content = await withMcpCatalogClient(resource.serverId, async (client) => {
        const contents = await client.readResource(uri);
        return renderResourceContent(contents);
      });
      return toolSuccess(
        content !== '' ? content : language === 'zh' ? '（空 resource）' : '(empty resource)',
      );
    } catch (error: unknown) {
      return toolFailure(error instanceof Error ? error.message : String(error));
    }
  },
};
