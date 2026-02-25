import fs from 'fs/promises';
import path from 'path';
import YAML from 'yaml';

export type DomindsAppManifest = Readonly<{
  apiVersion: 'dominds.io/v1alpha1';
  kind: 'DomindsApp';
  id: string;
  name?: Readonly<{ zh?: string; en?: string }>;
  description?: Readonly<{ zh?: string; en?: string }>;
  contributes?: Readonly<{
    web?: Readonly<{
      staticDir: string;
      mountPath?: string;
    }>;
    teammates?: Readonly<{
      teamYaml: string;
    }>;
    tools?: Readonly<{
      module: string;
    }>;
    rtwsSeed?: Readonly<{
      taskdocs?: ReadonlyArray<
        Readonly<{
          path: string;
          goals?: string;
          constraints?: string;
          progress?: string;
        }>
      >;
    }>;
  }>;
}>;

export type AppManifestLoadResult =
  | Readonly<{ kind: 'ok'; manifest: DomindsAppManifest; raw: string; filePathAbs: string }>
  | Readonly<{ kind: 'error'; errorText: string; filePathAbs: string }>;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asOptionalString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function normalizeMountPath(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === '/') return '/';
  const withLeadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return withLeadingSlash.endsWith('/') ? withLeadingSlash.slice(0, -1) : withLeadingSlash;
}

export function parseDomindsAppManifest(
  parsed: unknown,
  filePathAbs: string,
): { ok: true; manifest: DomindsAppManifest } | { ok: false; errorText: string } {
  if (!isRecord(parsed)) {
    return { ok: false, errorText: `Invalid manifest YAML: expected an object (${filePathAbs})` };
  }

  const apiVersion = parsed['apiVersion'];
  if (apiVersion !== 'dominds.io/v1alpha1') {
    return {
      ok: false,
      errorText: `Invalid manifest apiVersion: expected 'dominds.io/v1alpha1' (${filePathAbs})`,
    };
  }

  const kind = parsed['kind'];
  if (kind !== 'DomindsApp') {
    return {
      ok: false,
      errorText: `Invalid manifest kind: expected 'DomindsApp' (${filePathAbs})`,
    };
  }

  const idRaw = parsed['id'];
  const id = typeof idRaw === 'string' ? idRaw.trim() : '';
  if (id === '') {
    return {
      ok: false,
      errorText: `Invalid manifest id: non-empty string required (${filePathAbs})`,
    };
  }

  const contributesRaw = parsed['contributes'];
  const contributes = (() => {
    if (contributesRaw === undefined) return undefined;
    if (!isRecord(contributesRaw)) {
      return {
        ok: false as const,
        errorText: `Invalid contributes: expected object (${filePathAbs})`,
      };
    }

    const webRaw = contributesRaw['web'];
    const web = (() => {
      if (webRaw === undefined) return undefined;
      if (!isRecord(webRaw)) {
        return {
          ok: false as const,
          errorText: `Invalid contributes.web: expected object (${filePathAbs})`,
        };
      }
      const staticDir = typeof webRaw['staticDir'] === 'string' ? webRaw['staticDir'].trim() : '';
      if (staticDir === '') {
        return {
          ok: false as const,
          errorText: `Invalid contributes.web.staticDir: required (${filePathAbs})`,
        };
      }
      const mountPathRaw = asOptionalString(webRaw['mountPath']);
      const mountPath = mountPathRaw !== undefined ? normalizeMountPath(mountPathRaw) : undefined;
      return { ok: true as const, value: { staticDir, mountPath } };
    })();
    if (web && !web.ok) return web;

    const teammatesRaw = contributesRaw['teammates'];
    const teammates = (() => {
      if (teammatesRaw === undefined) return undefined;
      if (!isRecord(teammatesRaw)) {
        return {
          ok: false as const,
          errorText: `Invalid contributes.teammates: expected object (${filePathAbs})`,
        };
      }
      const teamYaml =
        typeof teammatesRaw['teamYaml'] === 'string' ? teammatesRaw['teamYaml'].trim() : '';
      if (teamYaml === '') {
        return {
          ok: false as const,
          errorText: `Invalid contributes.teammates.teamYaml: required (${filePathAbs})`,
        };
      }
      return { ok: true as const, value: { teamYaml } };
    })();
    if (teammates && !teammates.ok) return teammates;

    const toolsRaw = contributesRaw['tools'];
    const tools = (() => {
      if (toolsRaw === undefined) return undefined;
      if (!isRecord(toolsRaw)) {
        return {
          ok: false as const,
          errorText: `Invalid contributes.tools: expected object (${filePathAbs})`,
        };
      }
      const modulePath = typeof toolsRaw['module'] === 'string' ? toolsRaw['module'].trim() : '';
      if (modulePath === '') {
        return {
          ok: false as const,
          errorText: `Invalid contributes.tools.module: required (${filePathAbs})`,
        };
      }
      return { ok: true as const, value: { module: modulePath } };
    })();
    if (tools && !tools.ok) return tools;

    const seedRaw = contributesRaw['rtwsSeed'];
    const rtwsSeed = (() => {
      if (seedRaw === undefined) return undefined;
      if (!isRecord(seedRaw)) {
        return {
          ok: false as const,
          errorText: `Invalid contributes.rtwsSeed: expected object (${filePathAbs})`,
        };
      }
      const taskdocsRaw = seedRaw['taskdocs'];
      if (taskdocsRaw === undefined) return { ok: true as const, value: undefined };
      if (!Array.isArray(taskdocsRaw)) {
        return {
          ok: false as const,
          errorText: `Invalid contributes.rtwsSeed.taskdocs: expected array (${filePathAbs})`,
        };
      }
      const taskdocs: Array<{
        path: string;
        goals?: string;
        constraints?: string;
        progress?: string;
      }> = [];
      for (const item of taskdocsRaw) {
        if (!isRecord(item)) {
          return {
            ok: false as const,
            errorText: `Invalid rtwsSeed.taskdocs item: expected object (${filePathAbs})`,
          };
        }
        const p = typeof item['path'] === 'string' ? item['path'].trim() : '';
        if (p === '' || !p.endsWith('.tsk')) {
          return {
            ok: false as const,
            errorText: `Invalid rtwsSeed.taskdocs[].path: must end with '.tsk' (${filePathAbs})`,
          };
        }
        taskdocs.push({
          path: p,
          goals: asOptionalString(item['goals']),
          constraints: asOptionalString(item['constraints']),
          progress: asOptionalString(item['progress']),
        });
      }
      return { ok: true as const, value: { taskdocs } };
    })();
    if (rtwsSeed && !rtwsSeed.ok) return rtwsSeed;

    return {
      ok: true as const,
      value: {
        web: web ? web.value : undefined,
        teammates: teammates ? teammates.value : undefined,
        tools: tools ? tools.value : undefined,
        rtwsSeed: rtwsSeed && rtwsSeed.value ? rtwsSeed.value : undefined,
      },
    };
  })();

  if (contributes && !contributes.ok) {
    return { ok: false, errorText: contributes.errorText };
  }

  const nameRaw = parsed['name'];
  const name =
    nameRaw !== undefined
      ? isRecord(nameRaw)
        ? { zh: asOptionalString(nameRaw['zh']), en: asOptionalString(nameRaw['en']) }
        : undefined
      : undefined;
  const descriptionRaw = parsed['description'];
  const description =
    descriptionRaw !== undefined
      ? isRecord(descriptionRaw)
        ? {
            zh: asOptionalString(descriptionRaw['zh']),
            en: asOptionalString(descriptionRaw['en']),
          }
        : undefined
      : undefined;

  const manifest: DomindsAppManifest = {
    apiVersion,
    kind,
    id,
    name,
    description,
    contributes: contributes ? contributes.value : undefined,
  };

  return { ok: true, manifest };
}

export async function loadDomindsAppManifest(params: {
  packageRootAbs: string;
  manifestRelPath: string;
}): Promise<AppManifestLoadResult> {
  const filePathAbs = path.resolve(params.packageRootAbs, params.manifestRelPath);
  let raw: string;
  try {
    raw = await fs.readFile(filePathAbs, 'utf-8');
  } catch (err: unknown) {
    return {
      kind: 'error',
      filePathAbs,
      errorText: err instanceof Error ? err.message : String(err),
    };
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(raw);
  } catch (err: unknown) {
    return {
      kind: 'error',
      filePathAbs,
      errorText: `Failed to parse YAML: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const normalized = parseDomindsAppManifest(parsed, filePathAbs);
  if (!normalized.ok) {
    return { kind: 'error', filePathAbs, errorText: normalized.errorText };
  }

  return { kind: 'ok', manifest: normalized.manifest, raw, filePathAbs };
}

export function resolveAppContribPaths(params: {
  manifest: DomindsAppManifest;
  packageRootAbs: string;
}): Readonly<{
  webStaticDirAbs: string | null;
  webMountPath: string | null;
  teammatesYamlAbs: string | null;
  toolsModuleAbs: string | null;
  seedTaskdocs: ReadonlyArray<
    Readonly<{ path: string; goals?: string; constraints?: string; progress?: string }>
  >;
}> {
  const c = params.manifest.contributes;
  const webStaticDirAbs = c?.web?.staticDir
    ? path.resolve(params.packageRootAbs, c.web.staticDir)
    : null;
  const webMountPath = c?.web?.mountPath ? normalizeMountPath(c.web.mountPath) : null;
  const teammatesYamlAbs = c?.teammates?.teamYaml
    ? path.resolve(params.packageRootAbs, c.teammates.teamYaml)
    : null;
  const toolsModuleAbs = c?.tools?.module
    ? path.resolve(params.packageRootAbs, c.tools.module)
    : null;
  const seedTaskdocs = c?.rtwsSeed?.taskdocs ? c.rtwsSeed.taskdocs : [];
  return { webStaticDirAbs, webMountPath, teammatesYamlAbs, toolsModuleAbs, seedTaskdocs };
}
