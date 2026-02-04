import fs from 'fs/promises';
import path from 'path';
import YAML from 'yaml';
import { createLogger } from '../log';
import type { LanguageCode } from '../shared/types/language';

type SnippetTemplateSource = 'builtin' | 'rtws';

type SnippetTemplate = {
  id: string;
  name: string;
  description?: string;
  content: string;
  source: SnippetTemplateSource;
  path?: string;
};

type SnippetCatalogGroup = {
  key: string;
  titleI18n: { en: string; zh: string };
  templates: SnippetTemplate[];
};

type SnippetCatalogResponse =
  | { success: true; groups: SnippetCatalogGroup[] }
  | { success: false; error: string };

type SnippetTemplatesResponse =
  | { success: true; templates: SnippetTemplate[] }
  | { success: false; error: string };

type SaveRtwsSnippetTemplateRequest = {
  groupKey: string;
  fileName?: string;
  uiLanguage: 'en' | 'zh';
  name: string;
  description?: string;
  content: string;
};

type SaveRtwsSnippetTemplateResponse =
  | { success: true; template: SnippetTemplate }
  | { success: false; error: string };

type CreateRtwsSnippetGroupRequest = {
  title: string;
  uiLanguage: 'en' | 'zh';
};

type CreateRtwsSnippetGroupResponse =
  | { success: true; groupKey: string }
  | { success: false; error: string };

type TeamMgmtManualRequest = { topics?: string[]; uiLanguage: 'en' | 'zh' };

type TeamMgmtManualResponse =
  | { success: true; markdown: string }
  | { success: false; error: string };

const log = createLogger('snippets-routes');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function parseSaveRtwsPromptTemplateRequest(raw: unknown): SaveRtwsSnippetTemplateRequest | null {
  if (!isRecord(raw)) return null;
  const groupKey = requireNonEmptyString(raw['groupKey']);
  const uiLanguageRaw = raw['uiLanguage'];
  const uiLanguage = uiLanguageRaw === 'zh' || uiLanguageRaw === 'en' ? uiLanguageRaw : null;
  const name = requireNonEmptyString(raw['name']);
  const content = requireNonEmptyString(raw['content']);
  if (!groupKey || !uiLanguage || !name || !content) return null;

  const fileNameRaw = raw['fileName'];
  const fileName =
    typeof fileNameRaw === 'string' && fileNameRaw.trim() !== '' ? fileNameRaw : undefined;

  const descriptionRaw = raw['description'];
  const description =
    typeof descriptionRaw === 'string' && descriptionRaw.trim() !== '' ? descriptionRaw : undefined;
  return { name, uiLanguage, fileName, description, content, groupKey };
}

function parseCreateRtwsSnippetGroupRequest(raw: unknown): CreateRtwsSnippetGroupRequest | null {
  if (!isRecord(raw)) return null;
  const title = requireNonEmptyString(raw['title']);
  const uiLanguageRaw = raw['uiLanguage'];
  const uiLanguage = uiLanguageRaw === 'zh' || uiLanguageRaw === 'en' ? uiLanguageRaw : null;
  if (!title || !uiLanguage) return null;
  return { title: title.trim(), uiLanguage };
}

function buildRtwsTemplateTokenFromName(name: string): string {
  return sanitizeRtwsTemplateFileName(name);
}

function buildRtwsTemplateTokenFromFileName(fileName: string): string {
  return sanitizeRtwsTemplateFileName(fileName);
}

type ParsedCatalog = Record<string, { name?: string; 'name-zh'?: string; snippets?: unknown }>;

function parseCatalogYaml(rawText: string): ParsedCatalog | null {
  try {
    const parsed: unknown = YAML.parse(rawText);
    if (!isRecord(parsed)) return null;
    const out: ParsedCatalog = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (!isRecord(v)) continue;
      out[k] = {
        name: typeof v['name'] === 'string' ? v['name'] : undefined,
        'name-zh': typeof v['name-zh'] === 'string' ? v['name-zh'] : undefined,
        snippets: v['snippets'],
      };
    }
    return out;
  } catch {
    return null;
  }
}

async function loadCatalogFromPath(abs: string): Promise<ParsedCatalog | null> {
  try {
    const raw = await fs.readFile(abs, 'utf-8');
    return parseCatalogYaml(raw);
  } catch {
    return null;
  }
}

function stripLangSuffixFromSnippetId(id: string): string {
  if (id.endsWith('.zh.md')) return id.slice(0, -'.zh.md'.length);
  if (id.endsWith('.en.md')) return id.slice(0, -'.en.md'.length);
  if (id.endsWith('.md')) return id.slice(0, -'.md'.length);
  return id;
}

function detectSnippetLanguageFromPath(filePath: string | undefined): LanguageCode | null {
  if (typeof filePath !== 'string') return null;
  const lowered = filePath.replace(/\\/g, '/').toLowerCase();
  if (lowered.endsWith('.zh.md')) return 'zh';
  if (lowered.endsWith('.en.md')) return 'en';
  return null;
}

function pickBestSnippetVariant(
  candidates: ReadonlyArray<SnippetTemplate>,
  uiLanguage: LanguageCode | null,
): SnippetTemplate | null {
  const first = candidates[0] ?? null;
  if (!first) return null;
  if (!uiLanguage) return first;

  for (const tpl of candidates) {
    if (detectSnippetLanguageFromPath(tpl.path) === uiLanguage) return tpl;
  }
  for (const tpl of candidates) {
    if (detectSnippetLanguageFromPath(tpl.path) === null) return tpl;
  }
  return first;
}

async function buildSnippetCatalog(
  uiLanguage: LanguageCode | null,
): Promise<SnippetCatalogGroup[]> {
  const builtin = await readBuiltinSnippets();
  const rtws = await readRtwsSnippets();

  const serverRoot = path.resolve(__dirname, '..', '..');
  const builtinCatalogAbs = path.resolve(serverRoot, 'dist', 'snippets', 'catalog.yaml');
  const builtinCatalogFallbackAbs = path.resolve(serverRoot, 'snippets', 'catalog.yaml');
  const rtwsRoot = path.resolve(process.cwd());
  const rtwsCatalogAbs = path.resolve(rtwsRoot, '.minds', 'snippets', 'catalog.yaml');

  const builtinCatalog =
    (await loadCatalogFromPath(builtinCatalogAbs)) ??
    (await loadCatalogFromPath(builtinCatalogFallbackAbs));
  const rtwsCatalog = await loadCatalogFromPath(rtwsCatalogAbs);

  if (!builtinCatalog && !rtwsCatalog) {
    return [
      {
        key: 'all',
        titleI18n: { en: 'All', zh: '全部' },
        templates: [...builtin, ...rtws],
      },
    ];
  }

  const builtinByToken = new Map<string, SnippetTemplate[]>();
  for (const tpl of builtin) {
    const p = typeof tpl.path === 'string' ? tpl.path : '';
    if (!p.startsWith('snippets/')) continue;
    const noExt = stripLangSuffixFromSnippetId(p);
    const token = noExt.replace(/^snippets\//, '');
    const prev = builtinByToken.get(token);
    if (prev) {
      prev.push(tpl);
    } else {
      builtinByToken.set(token, [tpl]);
    }
  }

  const rtwsByGroupAndToken = new Map<string, SnippetTemplate[]>();
  for (const tpl of rtws) {
    const p = typeof tpl.path === 'string' ? tpl.path : '';
    if (!p.startsWith('.minds/snippets/')) continue;
    const rel = p.slice('.minds/snippets/'.length);
    const parts = rel.split('/').filter((x) => x !== '');
    const groupKey = parts[0];
    const rest = parts.slice(1).join('/');
    if (!groupKey || !rest) continue;
    const token = stripLangSuffixFromSnippetId(rest);
    const k = `${groupKey}/${token}`;
    const prev = rtwsByGroupAndToken.get(k);
    if (prev) {
      prev.push(tpl);
    } else {
      rtwsByGroupAndToken.set(k, [tpl]);
    }
  }

  const keys: string[] = [];
  if (builtinCatalog) {
    keys.push(...Object.keys(builtinCatalog));
  }
  if (rtwsCatalog) {
    for (const k of Object.keys(rtwsCatalog)) {
      if (!keys.includes(k)) keys.push(k);
    }
  }

  const groups: SnippetCatalogGroup[] = [];
  for (const groupKey of keys) {
    const metaBuiltin = builtinCatalog ? builtinCatalog[groupKey] : undefined;
    const metaRtws = rtwsCatalog ? rtwsCatalog[groupKey] : undefined;
    const titleEn = metaRtws?.name ?? metaBuiltin?.name ?? groupKey;
    const titleZh =
      metaRtws?.['name-zh'] ??
      metaBuiltin?.['name-zh'] ??
      metaRtws?.name ??
      metaBuiltin?.name ??
      groupKey;

    const templates: SnippetTemplate[] = [];
    if (metaBuiltin && Array.isArray(metaBuiltin.snippets)) {
      for (const raw of metaBuiltin.snippets) {
        if (typeof raw !== 'string') continue;
        const token = raw.trim();
        if (!token) continue;
        const candidates = builtinByToken.get(token) ?? [];
        const tpl = pickBestSnippetVariant(candidates, uiLanguage);
        if (tpl) templates.push(tpl);
      }
    }
    if (metaRtws && Array.isArray(metaRtws.snippets)) {
      for (const raw of metaRtws.snippets) {
        if (typeof raw !== 'string') continue;
        const token = raw.trim();
        if (!token) continue;
        const candidates = rtwsByGroupAndToken.get(`${groupKey}/${token}`) ?? [];
        const tpl = pickBestSnippetVariant(candidates, uiLanguage);
        if (tpl) templates.push(tpl);
      }
    }

    // Keep empty groups so the UI can show newly-created rtws groups before adding snippets.

    // If an rtws template uses the same display name as a builtin template,
    // prefer the rtws version to support "override" via same-name saves.
    const rtwsNames = new Set<string>();
    for (const tpl of templates) {
      if (tpl.source === 'rtws') rtwsNames.add(tpl.name);
    }
    const filtered: SnippetTemplate[] = [];
    const seenNames = new Set<string>();
    for (const tpl of templates) {
      if (tpl.source === 'builtin' && rtwsNames.has(tpl.name)) {
        continue;
      }
      if (seenNames.has(tpl.name)) {
        continue;
      }
      seenNames.add(tpl.name);
      filtered.push(tpl);
    }

    groups.push({ key: groupKey, titleI18n: { en: titleEn, zh: titleZh }, templates: filtered });
  }

  if (groups.length === 0) {
    return [
      {
        key: 'all',
        titleI18n: { en: 'All', zh: '全部' },
        templates: [...builtin, ...rtws],
      },
    ];
  }

  return groups;
}

async function ensureRtwsCatalogGroup(
  snippetsDirAbs: string,
  request: CreateRtwsSnippetGroupRequest,
): Promise<CreateRtwsSnippetGroupResponse> {
  const title = request.title.trim();
  if (title === '') return { success: false, error: 'Missing title' };

  const base = sanitizeRtwsTemplateFileName(title);
  if (base === 'all') {
    return { success: false, error: "Group key 'all' is reserved" };
  }

  const catalogAbs = path.resolve(snippetsDirAbs, 'catalog.yaml');
  let catalog: ParsedCatalog = {};
  try {
    const raw = await fs.readFile(catalogAbs, 'utf-8');
    const parsed = parseCatalogYaml(raw);
    if (parsed) catalog = parsed;
  } catch {
    // ignore
  }

  let groupKey = base;
  if (isRecord(catalog[groupKey])) {
    // Auto-suffix for uniqueness.
    for (let i = 2; i < 1000; i += 1) {
      const candidate = `${base}-${i}`;
      if (!isRecord(catalog[candidate])) {
        groupKey = candidate;
        break;
      }
    }
    if (groupKey === base) {
      return { success: false, error: 'Failed to allocate unique group key' };
    }
  }

  const meta: Record<string, unknown> = {
    snippets: [],
  };
  if (request.uiLanguage === 'zh') {
    meta['name-zh'] = title;
    meta['name'] = title;
  } else {
    meta['name'] = title;
    meta['name-zh'] = title;
  }
  catalog[groupKey] = meta as ParsedCatalog[string];

  await fs.mkdir(snippetsDirAbs, { recursive: true });
  await fs.writeFile(catalogAbs, YAML.stringify(catalog), 'utf-8');

  return { success: true, groupKey };
}

function parseTeamMgmtManualRequest(raw: unknown): TeamMgmtManualRequest | null {
  if (!isRecord(raw)) return null;
  const uiLanguageRaw = raw['uiLanguage'];
  const uiLanguage = uiLanguageRaw === 'zh' || uiLanguageRaw === 'en' ? uiLanguageRaw : null;
  if (!uiLanguage) return null;

  const topicsValue = raw['topics'];
  if (topicsValue === undefined) {
    return { uiLanguage, topics: undefined };
  }
  if (!Array.isArray(topicsValue)) return null;
  const topics: string[] = [];
  for (const v of topicsValue) {
    if (typeof v !== 'string') return null;
    topics.push(v);
  }
  return { uiLanguage, topics };
}

function safeTemplateIdFromPath(relPath: string): string {
  return relPath.replace(/\\/g, '/');
}

function stripOptionalBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function parseFrontmatter(
  rawText: string,
):
  | { kind: 'none'; body: string }
  | { kind: 'parsed'; body: string; name?: string; description?: string } {
  const normalized = stripOptionalBom(rawText).replace(/\r\n/g, '\n');
  const m = normalized.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return { kind: 'none', body: rawText };
  const fmText = m[1] ?? '';
  const body = m[2] ?? '';
  try {
    const parsed: unknown = YAML.parse(fmText);
    if (!isRecord(parsed)) return { kind: 'none', body };
    const name = typeof parsed['name'] === 'string' ? parsed['name'] : undefined;
    const description =
      typeof parsed['description'] === 'string' ? parsed['description'] : undefined;
    return { kind: 'parsed', body, name, description };
  } catch {
    return { kind: 'none', body };
  }
}

function safeBasenameToName(filename: string): string {
  const base = filename.replace(/\.md$/i, '').trim();
  return base === '' ? filename : base;
}

function ensureInsideDir(dirAbs: string, candidateAbs: string): boolean {
  return candidateAbs === dirAbs || candidateAbs.startsWith(dirAbs + path.sep);
}

async function listMarkdownFilesRecursively(dirAbs: string): Promise<string[]> {
  const out: string[] = [];

  const walk = async (abs: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const childAbs = path.join(abs, ent.name);
      if (ent.isDirectory()) {
        await walk(childAbs);
        continue;
      }
      if (ent.isFile() && ent.name.toLowerCase().endsWith('.md')) {
        out.push(childAbs);
      }
    }
  };

  await walk(dirAbs);
  return out;
}

async function readBuiltinSnippets(): Promise<SnippetTemplate[]> {
  const serverRoot = path.resolve(__dirname, '..', '..');
  const candidates = [
    path.resolve(serverRoot, 'dist', 'snippets'),
    path.resolve(serverRoot, 'snippets'),
  ];
  let snippetsDir: string | null = null;
  for (const dir of candidates) {
    try {
      const st = await fs.stat(dir);
      if (st.isDirectory()) {
        snippetsDir = dir;
        break;
      }
    } catch {
      // ignore
    }
  }
  if (!snippetsDir) return [];

  const files = await listMarkdownFilesRecursively(snippetsDir);
  const templates: SnippetTemplate[] = [];
  for (const abs of files) {
    if (path.basename(abs).toLowerCase() === 'readme.md') continue;
    try {
      const raw = await fs.readFile(abs, 'utf-8');
      const parsed = parseFrontmatter(raw);
      const rel = path.relative(snippetsDir, abs).replace(/\\/g, '/');
      templates.push({
        id: `builtin:${safeTemplateIdFromPath(rel)}`,
        name:
          parsed.kind === 'parsed' && parsed.name
            ? parsed.name
            : safeBasenameToName(path.basename(abs)),
        description: parsed.kind === 'parsed' ? parsed.description : undefined,
        content: parsed.kind === 'parsed' ? parsed.body : raw,
        source: 'builtin',
        path: `snippets/${rel}`,
      });
    } catch {
      // ignore unreadable file
    }
  }
  return templates;
}

async function readRtwsSnippets(): Promise<SnippetTemplate[]> {
  const rtwsRoot = path.resolve(process.cwd());
  const snippetsDir = path.resolve(rtwsRoot, '.minds', 'snippets');
  const files = await listMarkdownFilesRecursively(snippetsDir);
  const templates: SnippetTemplate[] = [];
  for (const abs of files) {
    if (path.basename(abs).toLowerCase() === 'catalog.yaml') continue;
    try {
      const raw = await fs.readFile(abs, 'utf-8');
      const parsed = parseFrontmatter(raw);
      const rel = path.relative(snippetsDir, abs).replace(/\\/g, '/');
      templates.push({
        id: `rtws:${safeTemplateIdFromPath(rel)}`,
        name:
          parsed.kind === 'parsed' && parsed.name
            ? parsed.name
            : safeBasenameToName(path.basename(abs)),
        description: parsed.kind === 'parsed' ? parsed.description : undefined,
        content: parsed.kind === 'parsed' ? parsed.body : raw,
        source: 'rtws',
        path: `.minds/snippets/${rel}`,
      });
    } catch {
      // ignore
    }
  }
  return templates;
}

function sanitizeRtwsTemplateFileName(name: string): string {
  const trimmed = name.trim();
  const base = trimmed.replace(/[^a-zA-Z0-9\-_\u4e00-\u9fff]+/g, '-').replace(/-+/g, '-');
  const safe = base.replace(/^[-_]+/, '').replace(/[-_]+$/, '');
  return safe === '' ? 'prompt' : safe;
}

async function upsertRtwsCatalogEntry(
  snippetsDirAbs: string,
  groupKey: string,
  token: string,
): Promise<void> {
  const catalogAbs = path.resolve(snippetsDirAbs, 'catalog.yaml');

  let catalog: ParsedCatalog = {};
  try {
    const raw = await fs.readFile(catalogAbs, 'utf-8');
    const parsed = parseCatalogYaml(raw);
    if (parsed) catalog = parsed;
  } catch {
    // ignore
  }

  const existing = catalog[groupKey];
  const meta = isRecord(existing) ? { ...existing } : {};
  const prevSnippets = meta['snippets'];
  const snippets: string[] = [];
  if (Array.isArray(prevSnippets)) {
    for (const item of prevSnippets) {
      if (typeof item === 'string' && item.trim() !== '') snippets.push(item.trim());
    }
  }
  if (!snippets.includes(token)) snippets.push(token);
  meta['snippets'] = snippets;
  catalog[groupKey] = meta;

  await fs.mkdir(snippetsDirAbs, { recursive: true });
  await fs.writeFile(catalogAbs, YAML.stringify(catalog), 'utf-8');
}

export async function handleGetBuiltinSnippets(): Promise<SnippetTemplatesResponse> {
  try {
    const templates = await readBuiltinSnippets();
    return { success: true, templates };
  } catch (error: unknown) {
    log.error('Failed to read builtin snippets', error);
    return { success: false, error: 'Failed to load builtin snippets' };
  }
}

export async function handleGetRtwsSnippets(): Promise<SnippetTemplatesResponse> {
  try {
    const templates = await readRtwsSnippets();
    return { success: true, templates };
  } catch (error: unknown) {
    log.error('Failed to read rtws snippets', error);
    return { success: false, error: 'Failed to load rtws snippets' };
  }
}

export async function handleGetSnippetCatalog(
  uiLanguage: LanguageCode | null = null,
): Promise<SnippetCatalogResponse> {
  try {
    const groups = await buildSnippetCatalog(uiLanguage);
    return { success: true, groups };
  } catch (error: unknown) {
    log.error('Failed to build snippet catalog', error);
    return { success: false, error: 'Failed to load snippet catalog' };
  }
}

export async function handleSaveRtwsSnippet(
  rawBody: string,
): Promise<SaveRtwsSnippetTemplateResponse> {
  let parsed: unknown;
  try {
    parsed = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    return { success: false, error: 'Invalid JSON body' };
  }
  const req = parseSaveRtwsPromptTemplateRequest(parsed);
  if (!req) return { success: false, error: 'Invalid request body' };

  const rtwsRoot = path.resolve(process.cwd());
  const snippetsDir = path.resolve(rtwsRoot, '.minds', 'snippets');
  const safeName =
    typeof req.fileName === 'string' && req.fileName.trim() !== ''
      ? sanitizeRtwsTemplateFileName(req.fileName)
      : sanitizeRtwsTemplateFileName(req.name);
  const langSuffix = req.uiLanguage;
  const fileBasename = safeName.endsWith(`.${langSuffix}`) ? safeName : `${safeName}.${langSuffix}`;
  const groupKey = sanitizeRtwsTemplateFileName(req.groupKey);
  const fileAbs = path.resolve(snippetsDir, groupKey, `${fileBasename}.md`);
  if (!ensureInsideDir(snippetsDir, fileAbs)) {
    return { success: false, error: 'Invalid template name' };
  }
  try {
    await fs.mkdir(path.dirname(fileAbs), { recursive: true });

    const headerData: Record<string, string> = { name: req.name.trim() };
    if (typeof req.description === 'string' && req.description.trim() !== '') {
      headerData['description'] = req.description.trim();
    }
    const header = YAML.stringify(headerData).trimEnd();
    const serialized = `---\n${header}\n---\n\n${req.content.trimEnd()}\n`;
    await fs.writeFile(fileAbs, serialized, 'utf-8');
    await upsertRtwsCatalogEntry(
      snippetsDir,
      groupKey,
      typeof req.fileName === 'string' && req.fileName.trim() !== ''
        ? buildRtwsTemplateTokenFromFileName(req.fileName)
        : buildRtwsTemplateTokenFromName(req.name),
    );
    const rel = path.relative(snippetsDir, fileAbs).replace(/\\/g, '/');
    return {
      success: true,
      template: {
        id: `rtws:${safeTemplateIdFromPath(rel)}`,
        name: req.name.trim(),
        description: typeof req.description === 'string' ? req.description : undefined,
        content: req.content,
        source: 'rtws',
        path: `.minds/snippets/${rel}`,
      },
    };
  } catch (error: unknown) {
    log.error('Failed to save rtws snippet', error);
    return { success: false, error: 'Failed to save snippet template' };
  }
}

export async function handleCreateRtwsSnippetGroup(
  rawBody: string,
): Promise<CreateRtwsSnippetGroupResponse> {
  let parsed: unknown;
  try {
    parsed = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    return { success: false, error: 'Invalid JSON body' };
  }
  const req = parseCreateRtwsSnippetGroupRequest(parsed);
  if (!req) return { success: false, error: 'Invalid request body' };

  const rtwsRoot = path.resolve(process.cwd());
  const snippetsDir = path.resolve(rtwsRoot, '.minds', 'snippets');
  try {
    return await ensureRtwsCatalogGroup(snippetsDir, req);
  } catch (error: unknown) {
    log.error('Failed to create rtws snippet group', error);
    return { success: false, error: 'Failed to create snippet group' };
  }
}

export async function handleTeamMgmtManual(rawBody: string): Promise<TeamMgmtManualResponse> {
  let parsed: unknown;
  try {
    parsed = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    return { success: false, error: 'Invalid JSON body' };
  }
  const req = parseTeamMgmtManualRequest(parsed);
  if (!req) return { success: false, error: 'Invalid request body' };

  try {
    const { getTool } = await import('../tools/registry');
    const tool = getTool('team_mgmt_manual');
    if (!tool || tool.type !== 'func') {
      return { success: false, error: 'team_mgmt_manual tool not available' };
    }

    const fakeDlg = {
      getLastUserLanguageCode: () => req.uiLanguage,
    } as unknown as Parameters<typeof tool.call>[0];

    const { Team } = await import('../team');
    const caller = new Team.Member({
      id: 'webui',
      name: 'WebUI',
      read_dirs: ['.minds/**'],
      write_dirs: ['.minds/**'],
    });

    const markdown = await tool.call(fakeDlg, caller, { topics: req.topics ?? [] });
    return { success: true, markdown: String(markdown) };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Failed to load team manual';
    log.error('Failed to call team_mgmt_manual', error);
    return { success: false, error: msg };
  }
}
