/**
 * Module: server/api-routes
 *
 * Common API route handlers for both production and development servers
 */
import fs from 'fs';
import fsPromises from 'fs/promises';
import { IncomingMessage, ServerResponse } from 'http';
import * as path from 'path';
import type { WebSocket } from 'ws';
import { DialogID, DialogStore, RootDialog } from '../dialog';
import { globalDialogRegistry } from '../dialog-global-registry';
import { createLogger } from '../log';
import { DialogPersistence, DiskFileDialogStore } from '../persistence';
import type { ApiMoveDialogsRequest } from '../shared/types';
import type { DialogLatestFile, DialogMetadataFile } from '../shared/types/storage';
import type { DialogIdent } from '../shared/types/wire';
import { formatUnifiedTimestamp } from '../shared/utils/time';
import { Team } from '../team';
import { generateDialogID } from '../utils/id';
import { isTaskPackagePath } from '../utils/task-package';

// Dialog lookup is performed via file-backed persistence; no in-memory registry

const log = createLogger('api-routes');

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

    // Get specific dialog
    if (pathname.startsWith('/api/dialogs/') && req.method === 'GET') {
      const parts = pathname.split('/');
      const selfId = (parts[4] || parts[3]).replace(/%2F/g, '/');
      const rootId = parts[3].replace(/%2F/g, '/');
      const dialog: DialogIdent = { selfId, rootId };
      return await handleGetDialog(res, dialog);
    }

    // Task documents endpoint
    if (pathname === '/api/task-documents' && req.method === 'GET') {
      return await handleGetTaskDocuments(res);
    }

    return false; // Route not handled
  } catch (error) {
    log.error('Error handling API route:', error);
    respondJson(res, 500, { error: 'Internal server error' });
    return true;
  }
}

/**
 * Health check endpoint
 */
async function handleHealthCheck(res: ServerResponse, context: ApiRouteContext): Promise<boolean> {
  try {
    const healthData = {
      ok: true,
      timestamp: formatUnifiedTimestamp(new Date()),
      server: 'dominds',
      version: '1.0.0',
      workspace: process.cwd(),
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

    // Basic validation for required defaults
    if (!team.memberDefaults.provider) {
      respondJson(res, 500, {
        success: false,
        error:
          'Configuration Error: Missing required "provider" field in member_defaults of .minds/team.yaml.',
      });
      return true;
    }
    if (!team.memberDefaults.model) {
      respondJson(res, 500, {
        success: false,
        error:
          'Configuration Error: Missing required "model" field in member_defaults of .minds/team.yaml.',
      });
      return true;
    }

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
    });

    const memberDefaults = toFrontendMember(team.memberDefaults);
    const members: Record<string, ReturnType<typeof toFrontendMember>> = {};
    for (const [id, member] of Object.entries(team.members)) {
      members[id] = toFrontendMember(member);
    }

    respondJson(res, 200, {
      configuration: {
        memberDefaults,
        defaultResponder: team.defaultResponder,
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
      currentRound: number;
      createdAt: string;
      lastModified: string;
      subdialogCount: number;
    }> = [];

    for (const status of statuses) {
      const ids = await DialogPersistence.listDialogs(status);
      for (const id of ids) {
        const meta = await DialogPersistence.loadRootDialogMetadata(new DialogID(id), status);
        if (!meta) continue;

        // Load latest.yaml for currentRound and lastModified timestamp
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
          currentRound: latest?.currentRound || 1,
          createdAt: meta.createdAt,
          lastModified: latest?.lastModified || meta.createdAt,
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

    // Load latest.yaml for root dialog currentRound and lastModified timestamp
    const rootLatest: DialogLatestFile | null = await DialogPersistence.loadDialogLatest(
      new DialogID(rootId),
      foundStatus,
    );

    const rootInfo = {
      id: rootMeta.id,
      agentId: rootMeta.agentId,
      taskDocPath: rootMeta.taskDocPath,
      status: foundStatus,
      currentRound: rootLatest?.currentRound || 1,
      createdAt: rootMeta.createdAt,
      lastModified: rootLatest?.lastModified || rootMeta.createdAt,
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
      currentRound: number;
      createdAt: string;
      lastModified: string;
      topicId?: string;
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
          // Load latest.yaml for subdialog currentRound and lastModified timestamp
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
            currentRound: subLatest?.currentRound || 1,
            createdAt: meta.createdAt,
            lastModified: subLatest?.lastModified || meta.createdAt,
            topicId: meta.topicId,
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
        error: `taskDocPath must be a task package directory ending in '.tsk/' (got: '${taskDocPath}')`,
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

    // Persist dialog metadata and latest.yaml (write-once pattern)
    const metadata = {
      id: dialogId.selfId,
      agentId: agentId,
      taskDocPath: taskDocPath,
      createdAt: formatUnifiedTimestamp(new Date()),
    };
    await DialogPersistence.saveDialogMetadata(new DialogID(dialogId.selfId), metadata);

    // Create initial latest.yaml with current round and lastModified info
    await DialogPersistence.saveDialogLatest(new DialogID(dialogId.selfId), {
      currentRound: 1,
      lastModified: formatUnifiedTimestamp(new Date()),
      status: 'active',
      messageCount: 0,
      functionCallCount: 0,
      subdialogCount: 0,
    });

    // Dialog is registered with the global registry on creation
    // No need to call registerDialog

    respondJson(res, 201, { success: true, selfId: dialogId.selfId, rootId: dialogId.rootId });
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

    const currentRound = await DialogPersistence.getCurrentRoundNumber(
      new DialogID(dialog.selfId, dialog.rootId),
      'running',
    );

    const dialogData = {
      id: metadata.id,
      agentId: metadata.agentId,
      status: 'running',
      createdAt: metadata.createdAt,
      currentRound,
    };

    respondJson(res, 200, { success: true, dialog: dialogData });
    return true;
  } catch (error) {
    log.error('Error getting dialog:', error);
    respondJson(res, 500, { success: false, error: 'Failed to get dialog' });
    return true;
  }
}

/**
 * Get task documents
 */
async function handleGetTaskDocuments(res: ServerResponse): Promise<boolean> {
  try {
    const taskDocuments = await listTaskDocuments();
    respondJson(res, 200, taskDocuments);
    return true;
  } catch (error) {
    log.error('Error getting task documents:', error);
    respondJson(res, 500, { success: false, error: 'Failed to get task documents' });
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
 * List task documents (enhanced recursive search with ignore patterns)
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
  try {
    const taskDocuments: Array<{
      path: string;
      relativePath: string;
      name: string;
      size: number;
      lastModified: string;
    }> = [];

    // Load ignore patterns from .minds/task-ignore if it exists
    const ignorePatterns = await loadTaskIgnorePatterns();

    // Start recursive search from current directory
    await scanDirectory('.', taskDocuments, ignorePatterns);

    // Sort by path for consistent ordering
    taskDocuments.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

    return { success: true, taskDocuments };
  } catch (error) {
    log.error('Error listing task documents:', error);
    return { success: false, error: 'Failed to list task documents' };
  }
}

/**
 * Load ignore patterns from .minds/task-ignore file
 */
async function loadTaskIgnorePatterns(): Promise<string[]> {
  const ignorePatterns: string[] = [
    // Default patterns to ignore common non-task directories
    'node_modules/**',
    '.git/**',
    '.minds/**',
    '.dialogs/**',
    '.gitignore',
    'package.json',
    'package-lock.json',
    'README.md',
    'LICENSE',
    '*.log',
    '**/.DS_Store',
    '**/Thumbs.db',
  ];

  try {
    const taskIgnorePath = '.minds/task-ignore';
    if (fs.existsSync(taskIgnorePath)) {
      const ignoreContent = await fsPromises.readFile(taskIgnorePath, 'utf-8');
      const patterns = ignoreContent
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'));

      ignorePatterns.push(...patterns);
    }
  } catch (error) {
    log.debug('No .minds/task-ignore file found, using default patterns');
  }

  return ignorePatterns;
}

/**
 * Check if a path should be ignored based on patterns
 */
function shouldIgnorePath(filePath: string, ignorePatterns: string[]): boolean {
  const normalizedPath = filePath.replace(/\\/g, '/');

  for (const pattern of ignorePatterns) {
    // Simple glob pattern matching
    if (pattern.includes('**')) {
      // Handle double asterisk patterns
      const globPattern = pattern.replace(/\*\*/g, '.*');
      if (new RegExp(`^${globPattern}$`).test(normalizedPath)) {
        return true;
      }
    } else if (pattern.includes('*')) {
      // Handle single asterisk patterns
      const globPattern = pattern.replace(/\*/g, '[^/]*');
      if (new RegExp(`^${globPattern}$`).test(normalizedPath)) {
        return true;
      }
    } else {
      // Exact match or prefix match for directories
      if (normalizedPath === pattern || normalizedPath.startsWith(pattern + '/')) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Recursively scan directory for task documents
 */
async function scanDirectory(
  dirPath: string,
  taskDocuments: Array<{
    path: string;
    relativePath: string;
    name: string;
    size: number;
    lastModified: string;
  }>,
  ignorePatterns: string[],
): Promise<void> {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      const relativePath = path.relative('.', fullPath);

      // Check if this path should be ignored
      if (shouldIgnorePath(relativePath, ignorePatterns)) {
        continue;
      }

      if (entry.isDirectory()) {
        // Treat `*.tsk/` as a single encapsulated task document (do NOT recurse into it).
        if (entry.name.toLowerCase().endsWith('.tsk')) {
          try {
            const dirStats = fs.statSync(fullPath);
            let totalSize = 0;
            let lastModified = dirStats.mtime;
            const sectionFiles = [
              'goals.md',
              'constraints.md',
              'progress.md',
              'meta.json',
            ] as const;
            for (const filename of sectionFiles) {
              try {
                const sectionPath = path.join(fullPath, filename);
                const s = fs.statSync(sectionPath);
                totalSize += s.size;
                if (s.mtime > lastModified) lastModified = s.mtime;
              } catch {
                // Missing files are allowed; package may be created lazily.
              }
            }
            taskDocuments.push({
              path: fullPath,
              relativePath: relativePath.replace(/\\/g, '/'),
              name: entry.name,
              size: totalSize,
              lastModified: formatUnifiedTimestamp(lastModified),
            });
          } catch (statError) {
            log.debug(`Failed to get stats for task package: ${fullPath}`, statError);
          }
          continue;
        }

        // Recursively scan subdirectories
        await scanDirectory(fullPath, taskDocuments, ignorePatterns);
      }
    }
  } catch (error) {
    log.debug(`Failed to scan directory: ${dirPath}`, error);
  }
}
