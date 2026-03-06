import fs from 'fs/promises';
import path from 'path';
import YAML from 'yaml';

export type DomindsAppManifest = Readonly<{
  apiVersion: 'dominds.io/v1alpha1';
  kind: 'DomindsApp';
  id: string;
  dependencies?: ReadonlyArray<DomindsAppDependency>;
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

export type DomindsAppDependency = Readonly<{
  id: string;
  optional?: boolean;
}>;

export type AppManifestLoadResult =
  | Readonly<{ kind: 'ok'; manifest: DomindsAppManifest; raw: string; filePathAbs: string }>
  | Readonly<{ kind: 'error'; errorText: string; filePathAbs: string }>;

export const DEFAULT_DOMINDS_APP_MANIFEST_REL_PATH = '.minds/app.yaml';

export function makeDefaultRtwsAppManifest(id = 'rtws_root'): DomindsAppManifest {
  return {
    apiVersion: 'dominds.io/v1alpha1',
    kind: 'DomindsApp',
    id,
  };
}

async function fileExists(filePathAbs: string): Promise<boolean> {
  try {
    await fs.access(filePathAbs);
    return true;
  } catch (err: unknown) {
    const isEnoent =
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code?: unknown }).code === 'ENOENT';
    if (isEnoent) return false;
    throw err;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asOptionalString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function asOptionalBool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}

function parseDependencies(
  raw: unknown,
  at: string,
  filePathAbs: string,
): { ok: true; value: ReadonlyArray<DomindsAppDependency> } | { ok: false; errorText: string } {
  if (!Array.isArray(raw)) {
    return { ok: false, errorText: `Invalid ${at}: expected array (${filePathAbs})` };
  }
  const deps: DomindsAppDependency[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i];
    const itemAt = `${at}[${i}]`;
    if (!isRecord(item)) {
      return { ok: false, errorText: `Invalid ${itemAt}: expected object (${filePathAbs})` };
    }
    const id = typeof item['id'] === 'string' ? item['id'].trim() : '';
    if (id === '') {
      return { ok: false, errorText: `Invalid ${itemAt}.id: required (${filePathAbs})` };
    }
    const optional = asOptionalBool(item['optional']);
    deps.push({ id, optional });
  }
  return { ok: true, value: deps };
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

  // dependencies
  const depsRaw = parsed['dependencies'];
  const dependencies = (() => {
    if (depsRaw === undefined) return undefined;
    const parsedDeps = parseDependencies(depsRaw, 'dependencies', filePathAbs);
    if (!parsedDeps.ok) return parsedDeps;
    return { ok: true as const, value: parsedDeps.value };
  })();
  if (dependencies && !dependencies.ok) {
    return { ok: false, errorText: dependencies.errorText };
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
    dependencies: dependencies ? dependencies.value : undefined,
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

function canonicalizeManifest(manifest: DomindsAppManifest): DomindsAppManifest {
  const dependencies = (() => {
    if (!manifest.dependencies) return undefined;
    const byId = new Map<string, DomindsAppDependency>();
    for (const dep of manifest.dependencies) {
      const id = dep.id.trim();
      if (id === '') continue;
      byId.set(id, { id, optional: dep.optional === true ? true : undefined });
    }
    const normalized = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
    return normalized.length > 0 ? normalized : undefined;
  })();

  return {
    apiVersion: manifest.apiVersion,
    kind: manifest.kind,
    id: manifest.id,
    dependencies: dependencies && dependencies.length > 0 ? dependencies : undefined,
    name: manifest.name,
    description: manifest.description,
    contributes: manifest.contributes,
  };
}

export async function writeDomindsAppManifest(params: {
  packageRootAbs: string;
  manifestRelPath: string;
  manifest: DomindsAppManifest;
}): Promise<void> {
  const filePathAbs = path.resolve(params.packageRootAbs, params.manifestRelPath);
  await fs.mkdir(path.dirname(filePathAbs), { recursive: true });
  const yamlText = YAML.stringify(canonicalizeManifest(params.manifest));
  await fs.writeFile(filePathAbs, yamlText, 'utf-8');
}

export async function writeDomindsAppManifestIfChanged(params: {
  packageRootAbs: string;
  manifestRelPath: string;
  manifest: DomindsAppManifest;
}): Promise<void> {
  const filePathAbs = path.resolve(params.packageRootAbs, params.manifestRelPath);
  await fs.mkdir(path.dirname(filePathAbs), { recursive: true });
  const yamlText = YAML.stringify(canonicalizeManifest(params.manifest));
  try {
    const prev = await fs.readFile(filePathAbs, 'utf-8');
    if (prev === yamlText) return;
  } catch (err: unknown) {
    const isEnoent =
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code?: unknown }).code === 'ENOENT';
    if (!isEnoent) throw err;
  }
  await fs.writeFile(filePathAbs, yamlText, 'utf-8');
}

export async function loadRtwsDeclaredAppDependencies(params: {
  rtwsRootAbs: string;
}): Promise<ReadonlyArray<DomindsAppDependency>> {
  const filePathAbs = path.resolve(params.rtwsRootAbs, DEFAULT_DOMINDS_APP_MANIFEST_REL_PATH);
  if (!(await fileExists(filePathAbs))) return [];

  const loaded = await loadDomindsAppManifest({
    packageRootAbs: params.rtwsRootAbs,
    manifestRelPath: DEFAULT_DOMINDS_APP_MANIFEST_REL_PATH,
  });
  if (loaded.kind === 'error') {
    throw new Error(
      `Failed to load rtws app manifest: ${loaded.errorText} (${loaded.filePathAbs})`,
    );
  }
  return loaded.manifest.dependencies ?? [];
}

export async function hasRtwsDeclaredAppDependency(params: {
  rtwsRootAbs: string;
  appId: string;
}): Promise<boolean> {
  const appId = params.appId.trim();
  if (appId === '') return false;
  const deps = await loadRtwsDeclaredAppDependencies({ rtwsRootAbs: params.rtwsRootAbs });
  return deps.some((dep) => dep.id === appId);
}

export function upsertManifestDependency(params: {
  manifest: DomindsAppManifest;
  dependency: DomindsAppDependency;
}): DomindsAppManifest {
  const nextDep: DomindsAppDependency = {
    id: params.dependency.id.trim(),
    optional: params.dependency.optional === true ? true : undefined,
  };
  if (nextDep.id === '') return params.manifest;

  const deps = [...(params.manifest.dependencies ?? [])];
  const idx = deps.findIndex((dep) => dep.id === nextDep.id);
  if (idx >= 0) {
    const prev = deps[idx];
    if (prev && prev.optional === nextDep.optional) return params.manifest;
    deps[idx] = nextDep;
  } else {
    deps.push(nextDep);
  }
  return canonicalizeManifest({ ...params.manifest, dependencies: deps });
}

export function removeManifestDependency(params: {
  manifest: DomindsAppManifest;
  dependencyId: string;
}): DomindsAppManifest {
  const dependencyId = params.dependencyId.trim();
  if (dependencyId === '') return params.manifest;
  const prevDeps = params.manifest.dependencies ?? [];
  if (!prevDeps.some((dep) => dep.id === dependencyId)) return params.manifest;
  return canonicalizeManifest({
    ...params.manifest,
    dependencies: prevDeps.filter((dep) => dep.id !== dependencyId),
  });
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
