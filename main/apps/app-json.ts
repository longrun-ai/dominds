import type { I18nText } from '../shared/types/i18n';
import type { JsonSchema, ToolArguments, ToolCallOutput } from '../tool';

export type DomindsAppJsonSchemaVersion = 1;

export type DomindsAppToolJson = Readonly<{
  name: string;
  description?: string;
  descriptionI18n?: I18nText;
  parameters: JsonSchema;
}>;

export type DomindsAppToolsetJson = Readonly<{
  id: string;
  descriptionI18n?: I18nText;
  tools: ReadonlyArray<DomindsAppToolJson>;
}>;

export type DomindsAppDialogRunControlJson = Readonly<{
  id: string;
  descriptionI18n?: I18nText;
}>;

export type DomindsAppContributesJson = Readonly<{
  teammatesYamlRelPath?: string;
  toolsets?: ReadonlyArray<DomindsAppToolsetJson>;
  dialogRunControls?: ReadonlyArray<DomindsAppDialogRunControlJson>;
}>;

export type DomindsAppHostEntryJson = Readonly<{
  kind: 'node_module';
  moduleRelPath: string;
  exportName: string;
}>;

export type DomindsAppFrontendJson = Readonly<{
  kind: 'http';
  defaultPort?: number;
  basePath?: string;
  wsPath?: string;
}>;

/**
 * The JSON payload printed by `npx <pkg> --json` for dominds app installation and runtime.
 * This JSON is treated as the stable handshake between dominds kernel and a Dominds App package.
 */
export type DomindsAppInstallJsonV1 = Readonly<{
  schemaVersion: DomindsAppJsonSchemaVersion;
  appId: string;
  displayName?: string;
  package: Readonly<{
    name: string;
    version: string | null;
    rootAbs: string;
  }>;
  host: DomindsAppHostEntryJson;
  frontend?: DomindsAppFrontendJson;
  contributes?: DomindsAppContributesJson;
}>;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function asNullableString(v: unknown): string | null {
  if (v === null) return null;
  return typeof v === 'string' ? v : null;
}

function isI18nText(v: unknown): v is I18nText {
  return isRecord(v) && typeof v['zh'] === 'string' && typeof v['en'] === 'string';
}

function isJsonSchema(v: unknown): v is JsonSchema {
  // Dominds JsonSchema is intentionally permissive: it's a passthrough dictionary.
  return isRecord(v);
}

function parseToolJson(
  v: unknown,
  at: string,
): { ok: true; tool: DomindsAppToolJson } | { ok: false; errorText: string } {
  if (!isRecord(v)) return { ok: false, errorText: `Invalid ${at}: expected object` };
  const name = asString(v['name']);
  if (!name || name.trim() === '') return { ok: false, errorText: `Invalid ${at}.name: required` };
  const description = asString(v['description']) ?? undefined;
  const descriptionI18n = v['descriptionI18n'];
  if (descriptionI18n !== undefined && !isI18nText(descriptionI18n)) {
    return { ok: false, errorText: `Invalid ${at}.descriptionI18n: expected {zh,en} string` };
  }
  const parameters = v['parameters'];
  if (!isJsonSchema(parameters))
    return { ok: false, errorText: `Invalid ${at}.parameters: expected JSON schema object` };
  return {
    ok: true,
    tool: {
      name,
      description,
      descriptionI18n: descriptionI18n as I18nText | undefined,
      parameters,
    },
  };
}

function parseToolsetJson(
  v: unknown,
  at: string,
): { ok: true; toolset: DomindsAppToolsetJson } | { ok: false; errorText: string } {
  if (!isRecord(v)) return { ok: false, errorText: `Invalid ${at}: expected object` };
  const id = asString(v['id']);
  if (!id || id.trim() === '') return { ok: false, errorText: `Invalid ${at}.id: required` };
  const descriptionI18n = v['descriptionI18n'];
  if (descriptionI18n !== undefined && !isI18nText(descriptionI18n)) {
    return { ok: false, errorText: `Invalid ${at}.descriptionI18n: expected {zh,en} string` };
  }
  const toolsRaw = v['tools'];
  if (!Array.isArray(toolsRaw))
    return { ok: false, errorText: `Invalid ${at}.tools: expected array` };
  const tools: DomindsAppToolJson[] = [];
  for (let i = 0; i < toolsRaw.length; i += 1) {
    const parsed = parseToolJson(toolsRaw[i], `${at}.tools[${i}]`);
    if (!parsed.ok) return parsed;
    tools.push(parsed.tool);
  }
  return {
    ok: true,
    toolset: {
      id,
      descriptionI18n: descriptionI18n as I18nText | undefined,
      tools,
    },
  };
}

function parseDialogRunControlJson(
  v: unknown,
  at: string,
): { ok: true; control: DomindsAppDialogRunControlJson } | { ok: false; errorText: string } {
  if (!isRecord(v)) return { ok: false, errorText: `Invalid ${at}: expected object` };
  const id = asString(v['id']);
  if (!id || id.trim() === '') return { ok: false, errorText: `Invalid ${at}.id: required` };
  const descriptionI18n = v['descriptionI18n'];
  if (descriptionI18n !== undefined && !isI18nText(descriptionI18n)) {
    return { ok: false, errorText: `Invalid ${at}.descriptionI18n: expected {zh,en} string` };
  }
  return {
    ok: true,
    control: {
      id,
      descriptionI18n: descriptionI18n as I18nText | undefined,
    },
  };
}

export function parseDomindsAppInstallJson(
  v: unknown,
): { ok: true; json: DomindsAppInstallJsonV1 } | { ok: false; errorText: string } {
  if (!isRecord(v)) return { ok: false, errorText: 'Invalid app --json output: expected object' };
  const schemaVersion = v['schemaVersion'];
  if (schemaVersion !== 1) {
    return { ok: false, errorText: `Unsupported app json schemaVersion: ${String(schemaVersion)}` };
  }
  const appId = asString(v['appId']);
  if (!appId || appId.trim() === '')
    return { ok: false, errorText: 'Invalid app json: appId required' };
  const displayName = asString(v['displayName']) ?? undefined;

  const pkg = v['package'];
  if (!isRecord(pkg))
    return { ok: false, errorText: 'Invalid app json: package must be an object' };
  const packageName = asString(pkg['name']);
  const packageVersion = asNullableString(pkg['version']);
  const rootAbs = asString(pkg['rootAbs']);
  if (!packageName || packageName.trim() === '')
    return { ok: false, errorText: 'Invalid app json: package.name required' };
  if (packageVersion === null) {
    // ok
  } else if (!packageVersion || packageVersion.trim() === '') {
    return { ok: false, errorText: 'Invalid app json: package.version must be string|null' };
  }
  if (!rootAbs || rootAbs.trim() === '')
    return { ok: false, errorText: 'Invalid app json: package.rootAbs required' };

  const host = v['host'];
  if (!isRecord(host)) return { ok: false, errorText: 'Invalid app json: host must be an object' };
  const hostKind = asString(host['kind']);
  if (hostKind !== 'node_module')
    return { ok: false, errorText: "Invalid app json: host.kind must be 'node_module'" };
  const moduleRelPath = asString(host['moduleRelPath']);
  const exportName = asString(host['exportName']);
  if (!moduleRelPath || moduleRelPath.trim() === '')
    return { ok: false, errorText: 'Invalid app json: host.moduleRelPath required' };
  if (!exportName || exportName.trim() === '')
    return { ok: false, errorText: 'Invalid app json: host.exportName required' };

  const frontendRaw = v['frontend'];
  let frontend: DomindsAppFrontendJson | undefined;
  if (frontendRaw !== undefined) {
    if (!isRecord(frontendRaw))
      return { ok: false, errorText: 'Invalid app json: frontend must be an object' };
    const kind = asString(frontendRaw['kind']);
    if (kind !== 'http')
      return { ok: false, errorText: "Invalid app json: frontend.kind must be 'http'" };
    const defaultPortRaw = frontendRaw['defaultPort'];
    const defaultPort =
      defaultPortRaw === undefined
        ? undefined
        : typeof defaultPortRaw === 'number' && Number.isFinite(defaultPortRaw)
          ? Math.floor(defaultPortRaw)
          : null;
    if (defaultPort === null || (defaultPort !== undefined && defaultPort < 0)) {
      return {
        ok: false,
        errorText: 'Invalid app json: frontend.defaultPort must be a non-negative number',
      };
    }
    const basePath = asString(frontendRaw['basePath']) ?? undefined;
    const wsPath = asString(frontendRaw['wsPath']) ?? undefined;
    frontend = { kind: 'http', defaultPort, basePath, wsPath };
  }

  const contributesRaw = v['contributes'];
  let contributes: DomindsAppContributesJson | undefined;
  if (contributesRaw !== undefined) {
    if (!isRecord(contributesRaw))
      return { ok: false, errorText: 'Invalid app json: contributes must be an object' };
    const teammatesYamlRelPath = asString(contributesRaw['teammatesYamlRelPath']) ?? undefined;
    const toolsetsRaw = contributesRaw['toolsets'];
    let toolsets: DomindsAppToolsetJson[] | undefined;
    if (toolsetsRaw !== undefined) {
      if (!Array.isArray(toolsetsRaw))
        return { ok: false, errorText: 'Invalid app json: contributes.toolsets must be an array' };
      toolsets = [];
      for (let i = 0; i < toolsetsRaw.length; i += 1) {
        const parsed = parseToolsetJson(toolsetsRaw[i], `contributes.toolsets[${i}]`);
        if (!parsed.ok) return parsed;
        toolsets.push(parsed.toolset);
      }
    }
    const dialogRunControlsRaw = contributesRaw['dialogRunControls'];
    let dialogRunControls: DomindsAppDialogRunControlJson[] | undefined;
    if (dialogRunControlsRaw !== undefined) {
      if (!Array.isArray(dialogRunControlsRaw)) {
        return {
          ok: false,
          errorText: 'Invalid app json: contributes.dialogRunControls must be an array',
        };
      }
      dialogRunControls = [];
      for (let i = 0; i < dialogRunControlsRaw.length; i += 1) {
        const parsed = parseDialogRunControlJson(
          dialogRunControlsRaw[i],
          `contributes.dialogRunControls[${i}]`,
        );
        if (!parsed.ok) return parsed;
        dialogRunControls.push(parsed.control);
      }
    }
    contributes = { teammatesYamlRelPath, toolsets, dialogRunControls };
  }

  return {
    ok: true,
    json: {
      schemaVersion: 1,
      appId,
      displayName,
      package: { name: packageName, version: packageVersion, rootAbs },
      host: { kind: 'node_module', moduleRelPath, exportName },
      frontend,
      contributes,
    },
  };
}

export type DomindsAppHostToolContext = Readonly<{
  dialogId: string;
  callerId: string;
}>;

export type DomindsAppHostToolHandler = (
  args: ToolArguments,
  ctx: DomindsAppHostToolContext,
) => Promise<ToolCallOutput>;
