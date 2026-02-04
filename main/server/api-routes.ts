/**
 * Module: server/api-routes
 *
 * Common API route handlers for both production and development servers
 */
import fsPromises from 'fs/promises';
import { IncomingMessage, ServerResponse } from 'http';
import * as path from 'path';
import type { WebSocket } from 'ws';
import { DialogID, DialogStore, RootDialog } from '../dialog';
import { globalDialogRegistry } from '../dialog-global-registry';
import { createLogger } from '../log';
import { DialogPersistence, DiskFileDialogStore } from '../persistence';
import { DEFAULT_DILIGENCE_PUSH_MAX, DILIGENCE_FALLBACK_TEXT } from '../shared/diligence';
import { getWorkLanguage } from '../shared/runtime-language';
import type { ApiMoveDialogsRequest } from '../shared/types';
import { normalizeLanguageCode } from '../shared/types/language';
import type { DialogLatestFile, DialogMetadataFile } from '../shared/types/storage';
import type { DialogIdent } from '../shared/types/wire';
import { formatUnifiedTimestamp } from '../shared/utils/time';
import { Team } from '../team';
import { createToolsRegistrySnapshot } from '../tools/registry-snapshot';
import { generateDialogID } from '../utils/id';
import { isTaskPackagePath } from '../utils/task-package';
import { listTaskDocumentsInRtws } from '../utils/taskdoc-search';
import {
  buildSetupFileResponse,
  buildSetupStatusResponse,
  handleWriteRtwsLlmYaml,
  handleWriteShellEnv,
  handleWriteTeamYaml,
} from './setup-routes';
import {
  handleCreateRtwsSnippetGroup,
  handleGetBuiltinSnippets,
  handleGetRtwsSnippets,
  handleGetSnippetCatalog,
  handleSaveRtwsSnippet,
  handleTeamMgmtManual,
} from './snippets-routes';

// Dialog lookup is performed via file-backed persistence; no in-memory registry

const log = createLogger('api-routes');

let cachedDomindsVersion: string | null | undefined;

function resolveMemberDiligencePushMax(team: Team, agentId: string): number {
  const member = team.getMember(agentId);
  if (member && member.diligence_push_max !== undefined) {
    return member.diligence_push_max;
  }
  return DEFAULT_DILIGENCE_PUSH_MAX;
}

function normalizeDiligencePushMax(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.floor(value);
}

async function readDomindsPackageVersion(): Promise<string | null> {
  if (cachedDomindsVersion !== undefined) return cachedDomindsVersion;
  try {
    const packagePath = path.join(__dirname, '..', '..', 'package.json');
    const raw = await fsPromises.readFile(packagePath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) {
      cachedDomindsVersion = null;
      return null;
    }
    const version = parsed['version'];
    cachedDomindsVersion = typeof version === 'string' ? version : null;
    return cachedDomindsVersion;
  } catch {
    cachedDomindsVersion = null;
    return null;
  }
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const maybe = (error as { code?: unknown }).code;
  return typeof maybe === 'string' ? maybe : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface ApiRouteContext {
  clients?: Set<WebSocket>;
  mode: 'development' | 'production';
}

/**
 * Handle API routes
 */
export async function handleApiRoute(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  context: ApiRouteContext,
): Promise<boolean> {
  try {
    // Health check endpoint
    if (pathname === '/api/health' && req.method === 'GET') {
      return await handleHealthCheck(res, context);
    }

    // Live reload endpoint for development
    if (pathname === '/api/live-reload' && req.method === 'GET') {
      return await handleLiveReload(res, context);
    }

    // Team configuration endpoint (renamed)
    if (pathname === '/api/team/config' && req.method === 'GET') {
      return await handleGetTeamConfig(res);
    }

    // Setup status endpoint (WebUI /setup)
    if (pathname === '/api/setup/status' && req.method === 'GET') {
      const payload = await buildSetupStatusResponse();
      respondJson(res, 200, payload);
      return true;
    }

    if (pathname === '/api/setup/defaults-yaml' && req.method === 'GET') {
      const payload = await buildSetupFileResponse('defaults_yaml');
      respondJson(res, payload.success ? 200 : 404, payload);
      return true;
    }

    if (pathname === '/api/setup/rtws-llm-yaml' && req.method === 'GET') {
      const payload = await buildSetupFileResponse('rtws_llm_yaml');
      respondJson(res, payload.success ? 200 : 404, payload);
      return true;
    }

    // Setup: create/overwrite .minds/llm.yaml with raw YAML
    if (pathname === '/api/setup/write-rtws-llm-yaml' && req.method === 'POST') {
      const rawBody = await readRequestBody(req);
      const result = await handleWriteRtwsLlmYaml(rawBody);
      if (result.kind === 'ok') {
        respondJson(res, 200, result.response);
        return true;
      }
      if (result.kind === 'conflict') {
        respondJson(res, 409, { success: false, path: result.path, error: result.errorText });
        return true;
      }
      if (result.kind === 'bad_request') {
        respondJson(res, 400, { success: false, path: result.path, error: result.errorText });
        return true;
      }
      respondJson(res, 500, { success: false, path: result.path, error: result.errorText });
      return true;
    }

    // Setup: write env vars to shell rc files
    if (pathname === '/api/setup/write-shell-env' && req.method === 'POST') {
      const rawBody = await readRequestBody(req);
      const result = await handleWriteShellEnv(rawBody);
      if (result.kind === 'ok') {
        respondJson(res, 200, result.response);
        return true;
      }
      if (result.kind === 'bad_request') {
        respondJson(res, 400, { success: false, error: result.errorText });
        return true;
      }
      respondJson(res, 500, { success: false, error: result.errorText });
      return true;
    }

    // Setup: create/overwrite .minds/team.yaml with minimal member_defaults
    if (pathname === '/api/setup/write-team-yaml' && req.method === 'POST') {
      const rawBody = await readRequestBody(req);
      const result = await handleWriteTeamYaml(rawBody);
      if (result.kind === 'ok') {
        respondJson(res, 200, result.response);
        return true;
      }
      if (result.kind === 'conflict') {
        respondJson(res, 409, { success: false, path: result.path, error: result.errorText });
        return true;
      }
      if (result.kind === 'bad_request') {
        respondJson(res, 400, { success: false, path: result.path, error: result.errorText });
        return true;
      }
      respondJson(res, 500, { success: false, path: result.path, error: result.errorText });
      return true;
    }

    // Dialog list endpoint
    if (pathname === '/api/dialogs' && req.method === 'GET') {
      return await handleGetDialogs(res);
    }

    // Create dialog endpoint
    if (pathname === '/api/dialogs' && req.method === 'POST') {
      return await handleCreateDialog(req, res, context);
    }

    // Move dialogs between status directories (running/completed/archived)
    if (pathname === '/api/dialogs/move' && req.method === 'POST') {
      return await handleMoveDialogs(req, res, context);
    }

    // Delete a dialog (root dialogs only for now)
    if (
      pathname.startsWith('/api/dialogs/') &&
      !pathname.endsWith('/hierarchy') &&
      req.method === 'DELETE'
    ) {
      const parts = pathname.split('/');
      const rawRoot = parts[3];
      if (!rawRoot) {
        respondJson(res, 400, { error: 'Missing root dialog id' });
        return true;
      }
      const rawSelf = parts[4];
      const rootId = rawRoot.replace(/%2F/g, '/');
      const selfId = (rawSelf || rawRoot).replace(/%2F/g, '/');
      return await handleDeleteDialog(res, { rootId, selfId }, context);
    }

    // Get full hierarchy for a single root dialog
    if (
      pathname.startsWith('/api/dialogs/') &&
      pathname.endsWith('/hierarchy') &&
      req.method === 'GET'
    ) {
      const parts = pathname.split('/');
      const rootId = parts[3].replace(/%2F/g, '/');
      return await handleGetDialogHierarchy(res, rootId);
    }

    // Serve persisted dialog artifacts (binary)
    if (
      pathname.startsWith('/api/dialogs/') &&
      pathname.endsWith('/artifact') &&
      req.method === 'GET'
    ) {
      const parts = pathname.split('/');
      const rawRoot = parts[3];
      const rawMaybeSelf = parts[4];
      const rawTail = parts[5];
      if (!rawRoot) {
        respondJson(res, 400, { error: 'Missing root dialog id' });
        return true;
      }
      const rootId = rawRoot.replace(/%2F/g, '/');
      const selfId = (rawMaybeSelf && rawMaybeSelf !== 'artifact' ? rawMaybeSelf : rawRoot).replace(
        /%2F/g,
        '/',
      );
      const tail = (rawTail ?? rawMaybeSelf) || '';
      if (tail !== 'artifact') {
        respondJson(res, 404, { error: 'Not Found' });
        return true;
      }
      return await handleGetDialogArtifact(req, res, { rootId, selfId });
    }

    // Get specific dialog
    if (pathname.startsWith('/api/dialogs/') && req.method === 'GET') {
      const parts = pathname.split('/');
      const selfId = (parts[4] || parts[3]).replace(/%2F/g, '/');
      const rootId = parts[3].replace(/%2F/g, '/');
      const dialog: DialogIdent = { selfId, rootId };
      return await handleGetDialog(res, dialog);
    }

    // Taskdocs endpoint
    if (pathname === '/api/task-documents' && req.method === 'GET') {
      return await handleGetTaskDocuments(res);
    }

    // Tools registry endpoint (snapshot)
    if (pathname === '/api/tools-registry' && req.method === 'GET') {
      return await handleGetToolsRegistry(res);
    }

    // Read rtws diligence prompt (rtws file).
    if (pathname === '/api/rtws/diligence' && req.method === 'GET') {
      return await handleGetRtwsDiligence(req, res);
    }

    // Write rtws diligence prompt (rtws file).
    if (pathname === '/api/rtws/diligence' && req.method === 'POST') {
      return await handleWriteRtwsDiligence(req, res);
    }

    // Delete rtws diligence prompt (rtws file).
    if (pathname === '/api/rtws/diligence' && req.method === 'DELETE') {
      return await handleDeleteRtwsDiligence(req, res);
    }

    // Read Dominds docs markdown (from dominds install root, NOT rtws).
    if (pathname === '/api/docs/read' && req.method === 'GET') {
      return await handleReadDocsMarkdown(req, res);
    }

    if (pathname === '/api/snippets/builtin' && req.method === 'GET') {
      const payload = await handleGetBuiltinSnippets();
      respondJson(res, payload.success ? 200 : 500, payload);
      return true;
    }

    if (pathname === '/api/snippets/rtws' && req.method === 'GET') {
      const payload = await handleGetRtwsSnippets();
      respondJson(res, payload.success ? 200 : 500, payload);
      return true;
    }

    if (pathname === '/api/snippets/catalog' && req.method === 'GET') {
      const urlObj = new URL(req.url ?? '', 'http://127.0.0.1');
      const lang = urlObj.searchParams.get('lang') ?? urlObj.searchParams.get('uiLanguage');
      const parsedLang = typeof lang === 'string' ? normalizeLanguageCode(lang) : null;
      const payload = await handleGetSnippetCatalog(parsedLang);
      respondJson(res, payload.success ? 200 : 500, payload);
      return true;
    }

    if (pathname === '/api/snippets/rtws' && req.method === 'POST') {
      const rawBody = await readRequestBody(req);
      const payload = await handleSaveRtwsSnippet(rawBody);
      respondJson(res, payload.success ? 200 : 400, payload);
      return true;
    }

    if (pathname === '/api/snippets/groups' && req.method === 'POST') {
      const rawBody = await readRequestBody(req);
      const payload = await handleCreateRtwsSnippetGroup(rawBody);
      respondJson(res, payload.success ? 200 : 400, payload);
      return true;
    }

    if (pathname === '/api/team-mgmt/manual' && req.method === 'POST') {
      const rawBody = await readRequestBody(req);
      const payload = await handleTeamMgmtManual(rawBody);
      respondJson(res, payload.success ? 200 : 400, payload);
      return true;
    }

    return false; // Route not handled
  } catch (error) {
    log.error('Error handling API route:', error);
    respondJson(res, 500, { error: 'Internal server error' });
    return true;
  }
}

function resolveRtwsDiligencePath(lang: string | null): string {
  const parsed = typeof lang === 'string' ? normalizeLanguageCode(lang) : null;
  if (parsed === 'zh') return path.resolve(process.cwd(), '.minds', 'diligence.zh.md');
  if (parsed === 'en') return path.resolve(process.cwd(), '.minds', 'diligence.en.md');
  return path.resolve(process.cwd(), '.minds', 'diligence.md');
}

async function handleGetRtwsDiligence(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const urlObj = new URL(req.url ?? '', 'http://127.0.0.1');
  const lang = urlObj.searchParams.get('lang');
  const primaryPath = resolveRtwsDiligencePath(lang);
  const genericPath = path.resolve(process.cwd(), '.minds', 'diligence.md');

  const candidates = [primaryPath, genericPath];
  for (const filePath of candidates) {
    try {
      const raw = await fsPromises.readFile(filePath, 'utf-8');
      respondJson(res, 200, { success: true, path: filePath, raw, source: 'rtws' });
      return true;
    } catch (error: unknown) {
      if (getErrorCode(error) === 'ENOENT') {
        continue;
      }
      log.error('Failed to read diligence file', error);
      respondJson(res, 500, { success: false, error: 'Failed to read diligence file' });
      return true;
    }
  }

  const fallbackLang = typeof lang === 'string' ? normalizeLanguageCode(lang) : null;
  const wl = fallbackLang ?? getWorkLanguage();
  respondJson(res, 200, {
    success: true,
    path: primaryPath,
    raw: DILIGENCE_FALLBACK_TEXT[wl],
    source: 'builtin',
  });
  return true;
}

async function handleWriteRtwsDiligence(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const urlObj = new URL(req.url ?? '', 'http://127.0.0.1');
  const lang = urlObj.searchParams.get('lang');
  const overwrite = urlObj.searchParams.get('overwrite');
  const overwriteBool = overwrite === '1' || overwrite === 'true';
  const filePath = resolveRtwsDiligencePath(lang);

  let parsed: unknown;
  try {
    const rawBody = await readRequestBody(req);
    parsed = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    respondJson(res, 400, { success: false, error: 'Invalid JSON' });
    return true;
  }
  if (!isRecord(parsed) || typeof parsed.raw !== 'string') {
    respondJson(res, 400, { success: false, error: 'Body must be { raw: string }' });
    return true;
  }

  try {
    const existing = await fsPromises.readFile(filePath, 'utf-8').then(
      () => true,
      (e: unknown) => (getErrorCode(e) === 'ENOENT' ? false : Promise.reject(e)),
    );
    if (existing && !overwriteBool) {
      respondJson(res, 409, {
        success: false,
        path: filePath,
        error: 'File exists; retry with overwrite=1 to confirm overwrite',
      });
      return true;
    }

    await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
    await fsPromises.writeFile(filePath, parsed.raw, 'utf-8');
    respondJson(res, 200, { success: true, path: filePath });
    return true;
  } catch (error: unknown) {
    log.error('Failed to write diligence file', error);
    respondJson(res, 500, { success: false, error: 'Failed to write diligence file' });
    return true;
  }
}

async function handleDeleteRtwsDiligence(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const urlObj = new URL(req.url ?? '', 'http://127.0.0.1');
  const lang = urlObj.searchParams.get('lang');

  const primaryPath = resolveRtwsDiligencePath(lang);
  const genericPath = path.resolve(process.cwd(), '.minds', 'diligence.md');
  const candidates = Array.from(new Set([primaryPath, genericPath]));

  const deleted: string[] = [];
  const missing: string[] = [];

  for (const filePath of candidates) {
    try {
      await fsPromises.unlink(filePath);
      deleted.push(filePath);
    } catch (error: unknown) {
      if (getErrorCode(error) === 'ENOENT') {
        missing.push(filePath);
        continue;
      }
      log.error('Failed to delete diligence file', error);
      respondJson(res, 500, { success: false, error: 'Failed to delete diligence file' });
      return true;
    }
  }

  respondJson(res, 200, { success: true, deleted, missing });
  return true;
}

const DOCS_WHITELIST = new Set<string>([
  'design',
  'dialog-system',
  'diligence-push',
  'auth',
  'dominds-terminology',
  'cli-usage',
  'mottos',
  'encapsulated-taskdoc',
  'memory-system',
  'mcp-support',
  'context-health',
  'OEC-philosophy',
  'design.md',
  'dialog-system.md',
  'diligence-push.md',
  'auth.md',
  'dominds-terminology.md',
  'cli-usage.md',
  'mottos.md',
  'encapsulated-taskdoc.md',
  'memory-system.md',
  'mcp-support.md',
  'context-health.md',
  'OEC-philosophy.md',
]);

async function handleReadDocsMarkdown(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const urlObj = new URL(req.url ?? '', 'http://127.0.0.1');
  const name = urlObj.searchParams.get('name');
  const lang = urlObj.searchParams.get('lang');
  const parsedLang = typeof lang === 'string' ? normalizeLanguageCode(lang) : null;

  if (typeof name !== 'string' || name.trim() === '') {
    respondJson(res, 400, { success: false, error: 'Missing name' });
    return true;
  }
  if (!DOCS_WHITELIST.has(name)) {
    respondJson(res, 403, { success: false, error: `Unsupported doc name: ${name}` });
    return true;
  }

  const serverRoot = path.resolve(__dirname, '..', '..');
  const docsDir = path.resolve(serverRoot, 'dist', 'docs');

  const ext = '.md';
  const stem = name.endsWith(ext) ? name.slice(0, -ext.length) : name;
  const basePath = path.resolve(docsDir, `${stem}${ext}`);
  const candidateLocalized =
    parsedLang === null ? null : path.resolve(docsDir, `${stem}.${parsedLang}${ext}`);

  const candidates = candidateLocalized ? [candidateLocalized, basePath] : [basePath];

  // Back-compat/dev fallback: source tree may exist in development runs.
  // In published builds we expect docs to live under dist/docs.
  const docsDirFallback = path.resolve(serverRoot, 'docs');
  const basePathFallback = path.resolve(docsDirFallback, `${stem}${ext}`);
  const candidateLocalizedFallback =
    parsedLang === null ? null : path.resolve(docsDirFallback, `${stem}.${parsedLang}${ext}`);
  const candidatesFallback = candidateLocalizedFallback
    ? [candidateLocalizedFallback, basePathFallback]
    : [basePathFallback];

  for (const filePath of [...candidates, ...candidatesFallback]) {
    try {
      const raw = await fsPromises.readFile(filePath, 'utf-8');
      respondJson(res, 200, { success: true, name: stem, path: filePath, raw });
      return true;
    } catch (error: unknown) {
      if (getErrorCode(error) === 'ENOENT') {
        continue;
      }
      log.error('Failed to read docs file', error);
      respondJson(res, 500, { success: false, error: 'Failed to read docs file' });
      return true;
    }
  }

  respondJson(res, 404, { success: false, error: 'Doc not found' });
  return true;
}

async function handleGetToolsRegistry(res: ServerResponse): Promise<boolean> {
  try {
    const snapshot = createToolsRegistrySnapshot();
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    res.end(
      JSON.stringify({
        success: true,
        toolsets: snapshot.toolsets,
        timestamp: snapshot.timestamp,
      }),
    );
    return true;
  } catch (error) {
    log.error('Error getting tools registry snapshot:', error);
    res.writeHead(500, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify({ success: false, error: 'Failed to get tools registry' }));
    return true;
  }
}

/**
 * Health check endpoint
 */
async function handleHealthCheck(res: ServerResponse, context: ApiRouteContext): Promise<boolean> {
  try {
    const version = (await readDomindsPackageVersion()) ?? 'unknown';
    const healthData = {
      ok: true,
      timestamp: formatUnifiedTimestamp(new Date()),
      server: 'dominds',
      version,
      rtws: process.cwd(),
      mode: context.mode,
    };

    respondJson(res, 200, healthData);
    return true;
  } catch (error) {
    log.error('Health check failed:', error);
    respondJson(res, 500, { ok: false, error: 'Health check failed' });
    return true;
  }
}

/**
 * Live reload endpoint for development
 */
async function handleLiveReload(res: ServerResponse, context: ApiRouteContext): Promise<boolean> {
  try {
    respondJson(res, 200, {
      success: true,
      message: 'Live reload endpoint active',
      timestamp: formatUnifiedTimestamp(new Date()),
      mode: context.mode,
    });
    return true;
  } catch (error) {
    log.error('Live reload failed:', error);
    respondJson(res, 500, { success: false, error: 'Live reload failed' });
    return true;
  }
}

/**
 * Team configuration endpoint
 * Returns full team configuration with member defaults, default responder,
 * and raw members record. Frontend will attach prototypes for defaults.
 */
async function handleGetTeamConfig(res: ServerResponse): Promise<boolean> {
  try {
    const team = await Team.load();

    // Convert Team.Member instances to plain frontend objects without prototypes
    const toFrontendMember = (m: Team.Member) => ({
      id: m.id,
      name: m.name,
      provider: m.provider,
      model: m.model,
      gofor: m.gofor,
      toolsets: m.toolsets,
      tools: m.tools,
      icon: m.icon,
      streaming: m.streaming,
      hidden: m.hidden,
    });

    const memberDefaults = toFrontendMember(team.memberDefaults);
    const members: Record<string, ReturnType<typeof toFrontendMember>> = {};
    for (const [id, member] of Object.entries(team.members)) {
      members[id] = toFrontendMember(member);
    }

    const def = team.getDefaultResponder();
    respondJson(res, 200, {
      configuration: {
        memberDefaults,
        defaultResponder: def ? def.id : undefined,
        members,
      },
    });
    return true;
  } catch (error) {
    log.error('Error getting team configuration:', error);
    respondJson(res, 500, { success: false, error: 'Failed to get team configuration' });
    return true;
  }
}

/**
 * Get dialog list - returns root dialogs with subdialogCount
 */
async function handleGetDialogs(res: ServerResponse): Promise<boolean> {
  try {
    const statuses: ('running' | 'completed' | 'archived')[] = ['running', 'completed', 'archived'];
    const rootDialogs: Array<{
      rootId: string;
      agentId: string;
      taskDocPath: string;
      status: 'running' | 'completed' | 'archived';
      currentCourse: number;
      createdAt: string;
      lastModified: string;
      runState?: DialogLatestFile['runState'];
      subdialogCount: number;
    }> = [];

    for (const status of statuses) {
      const ids = await DialogPersistence.listDialogs(status);
      for (const id of ids) {
        const meta = await DialogPersistence.loadRootDialogMetadata(new DialogID(id), status);
        if (!meta) continue;

        // Load latest.yaml for currentCourse and lastModified timestamp
        const latest = await DialogPersistence.loadDialogLatest(new DialogID(id), status);

        // Count subdialogs for this root dialog
        const rootPath = DialogPersistence.getRootDialogPath(new DialogID(id), status);
        const subPath = path.join(rootPath, 'subdialogs');
        const subdialogCount = await countSubdialogs(subPath);

        rootDialogs.push({
          rootId: meta.id,
          agentId: meta.agentId,
          taskDocPath: meta.taskDocPath,
          status,
          currentCourse: latest?.currentCourse || 1,
          createdAt: meta.createdAt,
          lastModified: latest?.lastModified || meta.createdAt,
          runState: latest?.runState,
          subdialogCount,
        });
      }
    }

    respondJson(res, 200, { success: true, dialogs: rootDialogs });
    return true;
  } catch (error) {
    log.error('Error getting root dialogs:', error);
    respondJson(res, 500, { success: false, error: 'Failed to get root dialogs' });
    return true;
  }
}

/**
 * Count subdialog directories recursively
 */
async function countSubdialogs(dirPath: string): Promise<number> {
  try {
    const entries = await fsPromises.readdir(dirPath, { withFileTypes: true });
    let count = 0;
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const fullPath = path.join(dirPath, entry.name);
        const dialogYamlPath = path.join(fullPath, 'dialog.yaml');
        try {
          await fsPromises.access(dialogYamlPath);
          // This directory contains dialog.yaml - it's a subdialog
          count++;
        } catch {
          // No dialog.yaml - recurse into this directory
          count += await countSubdialogs(fullPath);
        }
      }
    }
    return count;
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === 'ENOENT'
    ) {
      return 0;
    }
    throw error;
  }
}

/**
 * Get full hierarchy (root + subdialogs) for a single root dialog
 */
async function handleGetDialogHierarchy(res: ServerResponse, rootId: string): Promise<boolean> {
  try {
    const statuses: ('running' | 'completed' | 'archived')[] = ['running', 'completed', 'archived'];

    let foundStatus: 'running' | 'completed' | 'archived' | null = null;
    let rootMeta: DialogMetadataFile | null = null;
    for (const status of statuses) {
      const meta = await DialogPersistence.loadRootDialogMetadata(new DialogID(rootId), status);
      if (meta) {
        foundStatus = status;
        rootMeta = meta;
        break;
      }
    }

    if (!foundStatus || !rootMeta) {
      respondJson(res, 404, { success: false, error: `Root dialog ${rootId} not found` });
      return true;
    }

    // Load latest.yaml for root dialog currentCourse and lastModified timestamp
    const rootLatest: DialogLatestFile | null = await DialogPersistence.loadDialogLatest(
      new DialogID(rootId),
      foundStatus,
    );

    const rootInfo = {
      id: rootMeta.id,
      agentId: rootMeta.agentId,
      taskDocPath: rootMeta.taskDocPath,
      status: foundStatus,
      currentCourse: rootLatest?.currentCourse || 1,
      createdAt: rootMeta.createdAt,
      lastModified: rootLatest?.lastModified || rootMeta.createdAt,
      runState: rootLatest?.runState,
    };

    // Enumerate subdialogs under this root
    const rootPath = DialogPersistence.getRootDialogPath(new DialogID(rootId), foundStatus);
    const subPath = path.join(rootPath, 'subdialogs');

    let subdialogs: Array<{
      selfId: string;
      rootId: string;
      agentId: string;
      taskDocPath: string;
      status: 'running' | 'completed' | 'archived';
      currentCourse: number;
      createdAt: string;
      lastModified: string;
      runState?: DialogLatestFile['runState'];
      tellaskSession?: string;
    }> = [];

    // Recursively find all subdialog directories (handles nested paths like c1/78/4c3d759a)
    async function findSubdialogDirs(dir: string, baseRelative: string = ''): Promise<string[]> {
      const results: string[] = [];
      try {
        const entries = await fsPromises.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const fullPath = path.join(dir, entry.name);
            const dialogYamlPath = path.join(fullPath, 'dialog.yaml');
            const entryRelative = baseRelative ? path.join(baseRelative, entry.name) : entry.name;
            try {
              await fsPromises.access(dialogYamlPath);
              // This directory contains dialog.yaml - it's a subdialog
              // Push the FULL relative path (e.g., "5a/e2/4c424f27" not just "5a")
              results.push(entryRelative);
            } catch {
              // No dialog.yaml - recurse into this directory
              const nested = await findSubdialogDirs(fullPath, entryRelative);
              results.push(...nested);
            }
          }
        }
      } catch (error) {
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          (error as { code?: unknown }).code === 'ENOENT'
        ) {
          // No subdialogs directory - return empty
        } else {
          throw error;
        }
      }
      return results;
    }

    try {
      const subIds = await findSubdialogDirs(subPath);
      for (const subId of subIds) {
        const meta = await DialogPersistence.loadDialogMetadata(
          new DialogID(subId, rootId),
          foundStatus,
        );
        if (meta) {
          // Load latest.yaml for subdialog currentCourse and lastModified timestamp
          const subLatest = await DialogPersistence.loadDialogLatest(
            new DialogID(subId, rootId),
            foundStatus,
          );

          subdialogs.push({
            selfId: meta.id,
            rootId: rootId, // For subdialogs, rootId is the supdialog's ID
            agentId: meta.agentId,
            taskDocPath: meta.taskDocPath,
            status: foundStatus,
            currentCourse: subLatest?.currentCourse || 1,
            createdAt: meta.createdAt,
            lastModified: subLatest?.lastModified || meta.createdAt,
            runState: subLatest?.runState,
            tellaskSession: meta.tellaskSession,
          });
        }
      }
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code?: unknown }).code === 'ENOENT'
      ) {
        subdialogs = [];
      } else {
        throw error;
      }
    }

    respondJson(res, 200, {
      success: true,
      hierarchy: {
        root: rootInfo,
        subdialogs,
      },
    });
    return true;
  } catch (error) {
    log.error('Error getting dialog hierarchy:', error);
    respondJson(res, 500, { success: false, error: 'Failed to get dialog hierarchy' });
    return true;
  }
}

/**
 * Create new dialog
 */
async function handleCreateDialog(
  req: IncomingMessage,
  res: ServerResponse,
  context: ApiRouteContext,
): Promise<boolean> {
  try {
    const body = await readRequestBody(req);
    const { agentId, taskDocPath } = JSON.parse(body);

    if (!agentId) {
      respondJson(res, 400, { success: false, error: 'agentId is required' });
      return true;
    }
    if (typeof taskDocPath !== 'string' || taskDocPath.trim() === '') {
      respondJson(res, 400, { success: false, error: 'taskDocPath is required' });
      return true;
    }
    if (!isTaskPackagePath(taskDocPath)) {
      respondJson(res, 400, {
        success: false,
        error: `taskDocPath must be a Taskdoc directory ending in '.tsk' (got: '${taskDocPath}')`,
      });
      return true;
    }

    // Generate dialog ID
    const generatedId = generateDialogID();
    const dialogId = new DialogID(generatedId);

    // Create dialog UI based on context
    // Always use DiskFileDialogStore for file-based persistence
    const dialogUI: DialogStore = new DiskFileDialogStore(dialogId);

    // Create RootDialog
    const dialog = new RootDialog(dialogUI, taskDocPath, dialogId, agentId);
    globalDialogRegistry.register(dialog);

    const team = await Team.load();
    const diligencePushMax = normalizeDiligencePushMax(
      resolveMemberDiligencePushMax(team, agentId),
    );
    const defaultDisableDiligencePush = diligencePushMax <= 0;
    dialog.disableDiligencePush = defaultDisableDiligencePush;
    dialog.diligencePushRemainingBudget = diligencePushMax > 0 ? diligencePushMax : 0;

    // Persist dialog metadata and latest.yaml (write-once pattern)
    const metadata = {
      id: dialogId.selfId,
      agentId: agentId,
      taskDocPath: taskDocPath,
      createdAt: formatUnifiedTimestamp(new Date()),
    };
    await DialogPersistence.saveDialogMetadata(new DialogID(dialogId.selfId), metadata);

    // Initialize latest.yaml via the mutation API (write-back will flush).
    await DialogPersistence.mutateDialogLatest(new DialogID(dialogId.selfId), () => ({
      kind: 'replace',
      next: {
        currentCourse: 1,
        lastModified: formatUnifiedTimestamp(new Date()),
        status: 'active',
        messageCount: 0,
        functionCallCount: 0,
        subdialogCount: 0,
        runState: { kind: 'idle_waiting_user' },
        disableDiligencePush: defaultDisableDiligencePush,
        diligencePushRemainingBudget: dialog.diligencePushRemainingBudget,
      },
    }));

    // Dialog is registered with the global registry on creation
    // No need to call registerDialog

    respondJson(res, 201, { success: true, selfId: dialogId.selfId, rootId: dialogId.rootId });
    broadcastDialogCreates(context.clients, {
      type: 'dialogs_created',
      scope: { kind: 'root', rootId: dialogId.selfId },
      status: 'running',
      createdRootIds: [dialogId.selfId],
      timestamp: formatUnifiedTimestamp(new Date()),
    });
    return true;
  } catch (error) {
    log.error('Error creating dialog:', error);
    respondJson(res, 500, { success: false, error: 'Failed to create dialog' });
    return true;
  }
}

async function handleMoveDialogs(
  req: IncomingMessage,
  res: ServerResponse,
  context: ApiRouteContext,
): Promise<boolean> {
  try {
    const body = await readRequestBody(req);
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== 'object' || parsed === null) {
      respondJson(res, 400, { success: false, error: 'Invalid JSON body' });
      return true;
    }

    const kind = (parsed as { kind?: unknown }).kind;
    if (kind !== 'root' && kind !== 'task') {
      respondJson(res, 400, { success: false, error: 'Invalid move request kind' });
      return true;
    }

    const fromStatus = (parsed as { fromStatus?: unknown }).fromStatus;
    const toStatus = (parsed as { toStatus?: unknown }).toStatus;
    const fromOk =
      fromStatus === 'running' || fromStatus === 'completed' || fromStatus === 'archived';
    const toOk = toStatus === 'running' || toStatus === 'completed' || toStatus === 'archived';
    if (!fromOk || !toOk) {
      respondJson(res, 400, { success: false, error: 'Invalid fromStatus/toStatus' });
      return true;
    }
    if (fromStatus === toStatus) {
      respondJson(res, 400, { success: false, error: 'fromStatus and toStatus must differ' });
      return true;
    }

    const request = parsed as ApiMoveDialogsRequest;
    const movedRootIds: string[] = [];
    const scope =
      request.kind === 'root'
        ? { kind: 'root' as const, rootId: request.rootId }
        : { kind: 'task' as const, taskDocPath: request.taskDocPath };

    if (request.kind === 'root') {
      const rootId = request.rootId;
      if (typeof rootId !== 'string' || rootId.trim() === '') {
        respondJson(res, 400, { success: false, error: 'rootId must be a non-empty string' });
        return true;
      }

      const meta = await DialogPersistence.loadRootDialogMetadata(new DialogID(rootId), fromStatus);
      if (!meta) {
        respondJson(res, 404, {
          success: false,
          error: `Root dialog ${rootId} not found in ${fromStatus}`,
        });
        return true;
      }

      await DialogPersistence.moveDialogStatus(new DialogID(rootId), fromStatus, toStatus);
      movedRootIds.push(rootId);

      const live = globalDialogRegistry.get(rootId);
      if (live) {
        live.setPersistenceStatus(toStatus);
      }

      respondJson(res, 200, { success: true, movedRootIds });
      broadcastDialogMoves(context.clients, {
        type: 'dialogs_moved',
        scope,
        fromStatus,
        toStatus,
        movedRootIds,
        timestamp: formatUnifiedTimestamp(new Date()),
      });
      return true;
    }

    const taskDocPath = request.taskDocPath;
    if (typeof taskDocPath !== 'string' || taskDocPath.trim() === '') {
      respondJson(res, 400, { success: false, error: 'taskDocPath must be a non-empty string' });
      return true;
    }

    const ids = await DialogPersistence.listDialogs(fromStatus);
    for (const id of ids) {
      if (typeof id !== 'string' || id.trim() === '') continue;
      const meta = await DialogPersistence.loadRootDialogMetadata(new DialogID(id), fromStatus);
      if (!meta) continue;
      if (meta.taskDocPath !== taskDocPath) continue;
      await DialogPersistence.moveDialogStatus(new DialogID(id), fromStatus, toStatus);
      movedRootIds.push(id);
    }

    for (const rootId of movedRootIds) {
      const live = globalDialogRegistry.get(rootId);
      if (live) {
        live.setPersistenceStatus(toStatus);
      }
    }

    respondJson(res, 200, { success: true, movedRootIds });
    broadcastDialogMoves(context.clients, {
      type: 'dialogs_moved',
      scope,
      fromStatus,
      toStatus,
      movedRootIds,
      timestamp: formatUnifiedTimestamp(new Date()),
    });
    return true;
  } catch (error) {
    log.error('Error moving dialogs:', error);
    respondJson(res, 500, { success: false, error: 'Failed to move dialogs' });
    return true;
  }
}

function broadcastDialogMoves(
  clients: Set<WebSocket> | undefined,
  message: {
    type: 'dialogs_moved';
    scope: { kind: 'root'; rootId: string } | { kind: 'task'; taskDocPath: string };
    fromStatus: 'running' | 'completed' | 'archived';
    toStatus: 'running' | 'completed' | 'archived';
    movedRootIds: string[];
    timestamp: string;
  },
): void {
  if (!clients) return;
  if (message.movedRootIds.length === 0) return;
  const data = JSON.stringify(message);
  for (const ws of clients) {
    if (ws.readyState === 1) {
      ws.send(data);
    }
  }
}

function broadcastDialogDeletes(
  clients: Set<WebSocket> | undefined,
  message: {
    type: 'dialogs_deleted';
    scope: { kind: 'root'; rootId: string } | { kind: 'task'; taskDocPath: string };
    fromStatus: 'running' | 'completed' | 'archived';
    deletedRootIds: string[];
    timestamp: string;
  },
): void {
  if (!clients) return;
  if (message.deletedRootIds.length === 0) return;
  const data = JSON.stringify(message);
  for (const ws of clients) {
    if (ws.readyState === 1) {
      ws.send(data);
    }
  }
}

function broadcastDialogCreates(
  clients: Set<WebSocket> | undefined,
  message: {
    type: 'dialogs_created';
    scope: { kind: 'root'; rootId: string } | { kind: 'task'; taskDocPath: string };
    status: 'running' | 'completed' | 'archived';
    createdRootIds: string[];
    timestamp: string;
  },
): void {
  if (!clients) return;
  if (message.createdRootIds.length === 0) return;
  const data = JSON.stringify(message);
  for (const ws of clients) {
    if (ws.readyState === 1) {
      ws.send(data);
    }
  }
}

async function handleDeleteDialog(
  res: ServerResponse,
  dialog: { rootId: string; selfId: string },
  context: ApiRouteContext,
): Promise<boolean> {
  try {
    const { rootId, selfId } = dialog;
    if (typeof rootId !== 'string' || rootId.trim() === '') {
      respondJson(res, 400, { error: 'Invalid root dialog id' });
      return true;
    }
    if (typeof selfId !== 'string' || selfId.trim() === '') {
      respondJson(res, 400, { error: 'Invalid dialog id' });
      return true;
    }
    if (selfId !== rootId) {
      respondJson(res, 400, {
        error: 'Only root dialog deletion is supported (use /api/dialogs/:root)',
      });
      return true;
    }

    const fromStatus = await DialogPersistence.deleteRootDialog(new DialogID(rootId));
    if (!fromStatus) {
      respondJson(res, 404, { error: 'Dialog not found' });
      return true;
    }

    log.debug('Deleted dialog via API', undefined, { rootId, fromStatus });
    globalDialogRegistry.unregister(rootId);

    respondJson(res, 200, { deleted: true, fromStatus });
    broadcastDialogDeletes(context.clients, {
      type: 'dialogs_deleted',
      scope: { kind: 'root', rootId },
      fromStatus,
      deletedRootIds: [rootId],
      timestamp: formatUnifiedTimestamp(new Date()),
    });
    return true;
  } catch (error) {
    log.error('Error deleting dialog:', error);
    respondJson(res, 500, { error: 'Failed to delete dialog' });
    return true;
  }
}

/**
 * Get specific dialog
 */
async function handleGetDialog(res: ServerResponse, dialog: DialogIdent): Promise<boolean> {
  try {
    const metadata: DialogMetadataFile | null = await DialogPersistence.loadDialogMetadata(
      new DialogID(dialog.selfId, dialog.rootId),
      'running',
    );
    if (!metadata) {
      respondJson(res, 404, { success: false, error: 'Dialog not found' });
      return true;
    }

    // Enforce structured identification for subdialogs
    if (metadata.supdialogId && dialog.selfId === dialog.rootId) {
      respondJson(res, 400, {
        success: false,
        error: 'Subdialog requires /api/dialogs/:root/:self',
      });
      return true;
    }

    const currentCourse = await DialogPersistence.getCurrentCourseNumber(
      new DialogID(dialog.selfId, dialog.rootId),
      'running',
    );

    const dialogData = {
      id: metadata.id,
      agentId: metadata.agentId,
      status: 'running',
      createdAt: metadata.createdAt,
      currentCourse,
    };

    respondJson(res, 200, { success: true, dialog: dialogData });
    return true;
  } catch (error) {
    log.error('Error getting dialog:', error);
    respondJson(res, 500, { success: false, error: 'Failed to get dialog' });
    return true;
  }
}

function normalizeDialogArtifactRelPath(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  if (trimmed.includes('\u0000')) return null;
  if (trimmed.includes('\\')) return null;
  if (trimmed.startsWith('/')) return null;
  if (trimmed.includes(':')) return null;

  const normalized = path.posix.normalize(trimmed);
  if (!normalized.startsWith('artifacts/')) return null;
  if (normalized.endsWith('/')) return null;
  const parts = normalized.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return null;
  return normalized;
}

function ensureTrailingSep(p: string): string {
  return p.endsWith(path.sep) ? p : p + path.sep;
}

function guessContentTypeFromPath(relPath: string): string {
  const ext = path.extname(relPath).toLowerCase();
  switch (ext) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.svg':
      return 'image/svg+xml';
    case '.txt':
    case '.md':
      return 'text/plain; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    default:
      return 'application/octet-stream';
  }
}

async function handleGetDialogArtifact(
  req: IncomingMessage,
  res: ServerResponse,
  dialog: DialogIdent,
): Promise<boolean> {
  try {
    const urlObj = new URL(req.url ?? '', 'http://127.0.0.1');
    const raw = urlObj.searchParams.get('path');
    if (!raw) {
      respondJson(res, 400, { success: false, error: 'Missing path query parameter' });
      return true;
    }
    const relPath = normalizeDialogArtifactRelPath(raw);
    if (!relPath) {
      respondJson(res, 400, { success: false, error: 'Invalid artifact path' });
      return true;
    }

    const statusCandidates: Array<'running' | 'completed' | 'archived'> = [
      'running',
      'completed',
      'archived',
    ];
    for (const status of statusCandidates) {
      const baseDir = DialogPersistence.getDialogEventsPath(
        new DialogID(dialog.selfId, dialog.rootId),
        status,
      );
      const candidatePath = path.join(baseDir, ...relPath.split('/'));
      const baseAbs = ensureTrailingSep(path.resolve(baseDir));
      const candAbs = path.resolve(candidatePath);
      if (!candAbs.startsWith(baseAbs)) {
        respondJson(res, 400, { success: false, error: 'Invalid artifact path' });
        return true;
      }

      try {
        const st = await fsPromises.stat(candAbs);
        if (!st.isFile()) continue;
      } catch (error) {
        if (getErrorCode(error) === 'ENOENT') continue;
        throw error;
      }

      const data = await fsPromises.readFile(candAbs);
      res.writeHead(200, {
        'Content-Type': guessContentTypeFromPath(relPath),
        'Cache-Control': 'no-store',
      });
      res.end(data);
      return true;
    }

    respondJson(res, 404, { success: false, error: 'Artifact not found' });
    return true;
  } catch (error) {
    log.error('Error serving dialog artifact', error);
    respondJson(res, 500, { success: false, error: 'Failed to read artifact' });
    return true;
  }
}

/**
 * Get Taskdocs
 */
async function handleGetTaskDocuments(res: ServerResponse): Promise<boolean> {
  try {
    const taskDocuments = await listTaskDocuments();
    respondJson(res, 200, taskDocuments);
    return true;
  } catch (error) {
    log.error('Error getting Taskdocs:', error);
    respondJson(res, 500, { success: false, error: 'Failed to get Taskdocs' });
    return true;
  }
}

/**
 * Helper function to read request body
 */
function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      resolve(body);
    });
    req.on('error', reject);
  });
}

/**
 * Helper function to send JSON response
 */
function respondJson(res: ServerResponse, statusCode: number, data: unknown): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

/**
 * List Taskdocs (recursive search; Taskdocs are encapsulated `*.tsk/` directories)
 */
async function listTaskDocuments(): Promise<{
  success: boolean;
  taskDocuments?: Array<{
    path: string;
    relativePath: string;
    name: string;
    size: number;
    lastModified: string;
  }>;
  error?: string;
}> {
  const result = await listTaskDocumentsInRtws({ rootDir: '.' });
  if (result.kind === 'ok') return { success: true, taskDocuments: result.taskDocuments };
  return { success: false, error: result.errorText };
}
