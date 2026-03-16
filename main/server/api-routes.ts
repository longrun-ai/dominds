/**
 * Module: server/api-routes
 *
 * Common API route handlers for both production and development servers
 */
import type { ApiForkDialogResponse, ApiMoveDialogsRequest } from '@longrun-ai/kernel/types';
import { normalizeLanguageCode } from '@longrun-ai/kernel/types/language';
import type {
  ListPrimingScriptsResponse,
  PrimingScriptWarningSummary,
  SaveCurrentCoursePrimingRequest,
  SaveCurrentCoursePrimingResponse,
  SearchPrimingScriptsResponse,
} from '@longrun-ai/kernel/types/priming';
import type { DialogLatestFile, DialogMetadataFile } from '@longrun-ai/kernel/types/storage';
import type { DialogIdent, DialogStatusKind } from '@longrun-ai/kernel/types/wire';
import fsPromises from 'fs/promises';
import { IncomingMessage, ServerResponse } from 'http';
import * as path from 'path';
import type { WebSocket } from 'ws';
import { registerEnabledAppsToolProxies } from '../apps/runtime';
import { DialogID, DialogStore, RootDialog } from '../dialog';
import { getRunControlCountsSnapshot } from '../dialog-display-state';
import { forkRootDialogTreeAtGeneration } from '../dialog-fork';
import { globalDialogRegistry } from '../dialog-global-registry';
import { createLogger } from '../log';
import { DialogPersistence, DiskFileDialogStore } from '../persistence';
import type { PrimingScriptLoadIssue } from '../priming';
import {
  applyPrimingScriptsToDialog,
  buildRootDialogPrimingMetadata,
  listApplicablePrimingScripts,
  saveDialogCourseAsIndividualPrimingScript,
  searchApplicablePrimingScripts,
} from '../priming';
import { DEFAULT_DILIGENCE_PUSH_MAX, DILIGENCE_FALLBACK_TEXT } from '../shared/diligence';
import { getWorkLanguage } from '../shared/runtime-language';
import { formatUnifiedTimestamp } from '../shared/utils/time';
import { Team } from '../team';
import { createToolsRegistrySnapshot } from '../tools/registry-snapshot';
import { generateDialogID } from '../utils/id';
import { listTaskDocumentsInRtws } from '../utils/taskdoc-search';
import { makeCreateDialogFailure, parseCreateDialogInput } from './create-dialog-contract';
import { isTextLikeMimeType, sniffMimeType } from './mime-types';
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
const PRIMING_WARNING_SAMPLE_MAX = 5;

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

function parseDialogStatusFromUrl(urlObj: URL): DialogStatusKind | null {
  const raw = urlObj.searchParams.get('status');
  if (raw === null) return 'running';
  if (raw === 'running' || raw === 'completed' || raw === 'archived') {
    return raw;
  }
  return null;
}

function parseDialogStatusKind(raw: unknown): DialogStatusKind | null {
  if (raw === 'running' || raw === 'completed' || raw === 'archived') {
    return raw;
  }
  return null;
}

function buildPrimingWarningSummary(
  warnings: PrimingScriptLoadIssue[],
): PrimingScriptWarningSummary | undefined {
  if (warnings.length === 0) return undefined;
  return {
    skippedCount: warnings.length,
    samples: warnings.slice(0, PRIMING_WARNING_SAMPLE_MAX),
  };
}

async function handleListPrimingScripts(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  try {
    const urlObj = new URL(req.url ?? '', 'http://127.0.0.1');
    const agentId =
      typeof urlObj.searchParams.get('agentId') === 'string'
        ? urlObj.searchParams.get('agentId')!
        : '';
    if (agentId.trim() === '') {
      const payload: ListPrimingScriptsResponse = {
        success: false,
        error: 'agentId is required',
      };
      respondJson(res, 400, payload);
      return true;
    }
    const qRaw = urlObj.searchParams.get('q');
    const query = typeof qRaw === 'string' ? qRaw.trim() : '';
    if (query !== '') {
      const matched = await searchApplicablePrimingScripts({
        agentId,
        query,
        limit: 50,
      });
      const warningSummary = buildPrimingWarningSummary(matched.warnings);
      if (warningSummary) {
        log.warn('Skipped invalid priming scripts while searching', undefined, {
          agentId,
          query,
          skippedCount: warningSummary.skippedCount,
          samples: warningSummary.samples,
        });
      }
      const payload: SearchPrimingScriptsResponse = {
        success: true,
        scripts: matched.scripts,
        warningSummary,
      };
      respondJson(res, 200, payload);
      return true;
    }

    const data = await listApplicablePrimingScripts(agentId);
    const warningSummary = buildPrimingWarningSummary(data.warnings);
    if (warningSummary) {
      log.warn('Skipped invalid priming scripts while listing recent scripts', undefined, {
        agentId,
        skippedCount: warningSummary.skippedCount,
        samples: warningSummary.samples,
      });
    }
    const payload: ListPrimingScriptsResponse = {
      success: true,
      recent: data.recent,
      warningSummary,
    };
    respondJson(res, 200, payload);
    return true;
  } catch (error: unknown) {
    log.error('Failed to list priming scripts', error);
    const payload: ListPrimingScriptsResponse = {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to list priming scripts',
    };
    respondJson(res, 500, payload);
    return true;
  }
}

async function handleSaveCurrentCoursePriming(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  let parsed: unknown;
  try {
    const rawBody = await readRequestBody(req);
    parsed = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    const payload: SaveCurrentCoursePrimingResponse = {
      success: false,
      error: 'Invalid JSON body',
    };
    respondJson(res, 400, payload);
    return true;
  }

  if (!isRecord(parsed)) {
    const payload: SaveCurrentCoursePrimingResponse = {
      success: false,
      error: 'Invalid request body',
    };
    respondJson(res, 400, payload);
    return true;
  }

  const dialogRaw = parsed['dialog'];
  const courseRaw = parsed['course'];
  const slugRaw = parsed['slug'];
  const overwriteRaw = parsed['overwrite'];
  if (!isRecord(dialogRaw)) {
    const payload: SaveCurrentCoursePrimingResponse = {
      success: false,
      error: 'dialog is required',
    };
    respondJson(res, 400, payload);
    return true;
  }

  const rootId = typeof dialogRaw['rootId'] === 'string' ? dialogRaw['rootId'].trim() : '';
  const selfId = typeof dialogRaw['selfId'] === 'string' ? dialogRaw['selfId'].trim() : '';
  const status = parseDialogStatusKind(dialogRaw['status']) ?? 'running';
  const course =
    typeof courseRaw === 'number' && Number.isFinite(courseRaw) ? Math.floor(courseRaw) : 0;
  const slug = typeof slugRaw === 'string' ? slugRaw.trim() : '';
  const overwrite = overwriteRaw === true;

  if (rootId === '' || selfId === '') {
    const payload: SaveCurrentCoursePrimingResponse = {
      success: false,
      error: 'dialog.rootId and dialog.selfId are required',
    };
    respondJson(res, 400, payload);
    return true;
  }
  if (course <= 0) {
    const payload: SaveCurrentCoursePrimingResponse = {
      success: false,
      error: 'course must be a positive integer',
    };
    respondJson(res, 400, payload);
    return true;
  }
  if (slug === '') {
    const payload: SaveCurrentCoursePrimingResponse = {
      success: false,
      error: 'slug is required',
    };
    respondJson(res, 400, payload);
    return true;
  }
  if (overwriteRaw !== undefined && typeof overwriteRaw !== 'boolean') {
    const payload: SaveCurrentCoursePrimingResponse = {
      success: false,
      error: 'overwrite must be a boolean when provided',
      errorCode: 'INVALID_REQUEST',
    };
    respondJson(res, 400, payload);
    return true;
  }

  const request: SaveCurrentCoursePrimingRequest = {
    dialog: { rootId, selfId, status },
    course,
    slug,
    overwrite,
  };

  try {
    const result = await saveDialogCourseAsIndividualPrimingScript({
      dialogId: new DialogID(request.dialog.selfId, request.dialog.rootId),
      status: request.dialog.status ?? 'running',
      course: request.course,
      slug: request.slug,
      overwrite: request.overwrite,
    });
    const payload: SaveCurrentCoursePrimingResponse = {
      success: true,
      script: result.script,
      messageCount: result.messageCount,
      path: result.path,
    };
    respondJson(res, 200, payload);
    return true;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to save priming script';
    const errorCode = getErrorCode(error);
    const isAlreadyExists =
      errorCode === 'PRIMING_SCRIPT_EXISTS' ||
      errorCode === 'EEXIST' ||
      message.includes('already exists');
    const isBadRequest =
      message.includes('required') ||
      message.includes('Invalid') ||
      message.includes('Cannot save priming') ||
      message.includes('slug must be');
    const payload: SaveCurrentCoursePrimingResponse = {
      success: false,
      error: message,
      errorCode: isAlreadyExists
        ? 'ALREADY_EXISTS'
        : isBadRequest
          ? 'INVALID_REQUEST'
          : 'INTERNAL_ERROR',
    };
    const statusCode = isAlreadyExists ? 409 : isBadRequest ? 400 : 500;
    respondJson(res, statusCode, payload);
    return true;
  }
}

export interface ApiRouteContext {
  clients?: Set<WebSocket>;
  mode: 'development' | 'production';
}

export async function handleWorkspaceFilePreviewPage(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (!(pathname === '/f' || pathname === '/f/' || pathname.startsWith('/f/'))) {
    return false;
  }
  if (req.method !== 'GET') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET' });
    res.end('Method Not Allowed');
    return true;
  }

  const pathRel = parseWorkspacePreviewPathname(pathname);
  if (pathRel !== null) {
    try {
      const resolved = await resolveWorkspacePreviewPath(pathRel);
      const stat = await fsPromises.stat(resolved.candidateAbsPath);
      if (stat.isFile()) {
        const headBytes = await readFileHead(resolved.candidateAbsPath, 512);
        const mimeType = sniffMimeType(pathRel, headBytes);
        if (!isTextLikeMimeType(mimeType)) {
          const data = await fsPromises.readFile(resolved.candidateAbsPath);
          res.writeHead(200, {
            'Content-Type': mimeType,
            'Content-Length': stat.size,
            'Content-Disposition': 'inline',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
          });
          res.end(data);
          return true;
        }
      }
    } catch (error: unknown) {
      const code = getErrorCode(error);
      if (code !== 'ENOENT' && code !== 'OUTSIDE_RTWS') {
        log.error('Failed to inspect workspace preview path before rendering /f', error, {
          path: pathRel,
        });
      }
    }
  }

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Dominds Workspace Preview</title>
    <link
      rel="stylesheet"
      href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/styles/github-dark.min.css"
    />
    <style>
      :root { color-scheme: dark; }
      body {
        margin: 0;
        font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial;
        background: #0f172a;
        color: #e2e8f0;
      }
      a { color: #93c5fd; text-decoration: none; }
      a:hover { text-decoration: underline; }
      .wrap { max-width: 1280px; margin: 0 auto; padding: 16px; }
      .panel {
        border: 1px solid #334155;
        border-radius: 10px;
        overflow: hidden;
        background: #111827;
      }
      .head {
        padding: 10px 12px;
        border-bottom: 1px solid #334155;
        background: #1f2937;
      }
      .path {
        font-size: 13px;
        font-weight: 600;
        word-break: break-all;
      }
      .meta {
        margin-top: 4px;
        color: #94a3b8;
        font-size: 12px;
      }
      .body { padding: 8px; }
      .status {
        border: 1px solid #334155;
        border-radius: 8px;
        padding: 10px;
        font-size: 13px;
        color: #cbd5e1;
        background: #0f172a;
      }
      .status.err {
        border-color: #7f1d1d;
        background: #1f1010;
        color: #fecaca;
      }
      .code-wrap, .dir-wrap {
        border-radius: 8px;
        border: 1px solid #334155;
        background: #0b1220;
        overflow: auto;
        max-height: calc(100vh - 190px);
      }
      .code-view {
        min-width: max-content;
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 12px;
        line-height: 1.6;
      }
      .code-line {
        display: grid;
        grid-template-columns: auto 1fr;
      }
      .code-line:hover {
        background: rgba(148, 163, 184, 0.08);
      }
      .code-line.target-line {
        background: rgba(245, 158, 11, 0.14);
      }
      .line-no {
        position: sticky;
        left: 0;
        padding: 0 12px;
        min-width: 56px;
        box-sizing: border-box;
        text-align: right;
        user-select: none;
        -webkit-user-select: none;
        -moz-user-select: none;
        color: #64748b;
        background: #0f172a;
        border-right: 1px solid #1e293b;
      }
      .code-line.target-line .line-no {
        color: #fbbf24;
        background: #1c1917;
      }
      .line-content {
        display: block;
        margin: 0;
        padding: 0 12px;
        white-space: pre;
        tab-size: 2;
      }
      .line-content:empty::after {
        content: ' ';
      }
      .target-col {
        background: #f59e0b;
        color: #111827;
        border-radius: 3px;
        box-shadow: 0 0 0 1px rgba(245, 158, 11, 0.45);
      }
      .target-col-caret {
        display: inline-block;
        width: 2px;
        min-height: 1.2em;
        vertical-align: text-bottom;
        background: #f59e0b;
        box-shadow: 0 0 0 1px rgba(245, 158, 11, 0.35);
      }
      .dir-list {
        width: 100%;
        border-collapse: collapse;
        font-size: 13px;
      }
      .dir-list thead th {
        position: sticky;
        top: 0;
        z-index: 1;
        background: #111827;
        color: #94a3b8;
        font-weight: 600;
        text-align: left;
        border-bottom: 1px solid #334155;
      }
      .dir-list th, .dir-list td {
        padding: 8px 10px;
        border-bottom: 1px solid #1e293b;
        vertical-align: top;
      }
      .dir-list tbody tr:hover {
        background: rgba(148, 163, 184, 0.08);
      }
      .entry-name {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
      }
      .entry-icon {
        width: 1.2em;
        text-align: center;
        color: #cbd5e1;
      }
      .entry-label {
        word-break: break-word;
      }
      .entry-type, .entry-size {
        white-space: nowrap;
        color: #94a3b8;
      }
      .entry-note {
        color: #94a3b8;
        font-size: 12px;
        word-break: break-word;
      }
      .entry-note.warn {
        color: #fca5a5;
      }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="panel">
        <div class="head">
          <div id="preview-path" class="path">Loading...</div>
          <div id="preview-meta" class="meta"></div>
        </div>
        <div class="body">
          <div id="status" class="status">Loading workspace entry...</div>
          <div id="code-wrap" class="code-wrap" style="display:none;">
            <div id="code-view" class="code-view"></div>
          </div>
          <div id="dir-wrap" class="dir-wrap" style="display:none;">
            <table class="dir-list">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Type</th>
                  <th>Size</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody id="dir-body"></tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/highlight.min.js"></script>
    <script>
      (function () {
        var pathEl = document.getElementById('preview-path');
        var metaEl = document.getElementById('preview-meta');
        var statusEl = document.getElementById('status');
        var codeWrapEl = document.getElementById('code-wrap');
        var codeViewEl = document.getElementById('code-view');
        var dirWrapEl = document.getElementById('dir-wrap');
        var dirBodyEl = document.getElementById('dir-body');
        if (
          !pathEl ||
          !metaEl ||
          !statusEl ||
          !codeWrapEl ||
          !codeViewEl ||
          !dirWrapEl ||
          !dirBodyEl
        ) return;

        function setError(message) {
          statusEl.classList.add('err');
          statusEl.textContent = message;
          statusEl.style.display = 'block';
          codeWrapEl.style.display = 'none';
          dirWrapEl.style.display = 'none';
        }

        function resetViews() {
          statusEl.classList.remove('err');
          codeWrapEl.style.display = 'none';
          dirWrapEl.style.display = 'none';
          codeViewEl.innerHTML = '';
          dirBodyEl.innerHTML = '';
        }

        function showReady() {
          statusEl.style.display = 'none';
        }

        function escapeHtml(value) {
          return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
        }

        function normalizeRelativePath(input, allowRoot) {
          if (typeof input !== 'string') return null;
          if (input.indexOf('\\\\') >= 0) return null;
          if (/[\\u0000]/.test(input)) return null;
          if (input.charAt(0) === '/') return null;
          var parts = input.split('/');
          var normalized = [];
          for (var i = 0; i < parts.length; i += 1) {
            var seg = parts[i];
            if (!seg || seg === '.') continue;
            if (seg === '..') {
              if (normalized.length < 1) return null;
              normalized.pop();
              continue;
            }
            normalized.push(seg);
          }
          if (normalized.length < 1) return allowRoot ? '' : null;
          return normalized.join('/');
        }

        function parseRelativePathFromLocation() {
          var pathname = window.location.pathname || '';
          if (pathname === '/f' || pathname === '/f/') return '';
          if (!pathname.startsWith('/f/')) return null;
          var tail = pathname.slice('/f/'.length);
          if (tail.length < 1) return '';
          var rawParts = tail.split('/');
          var decodedParts = [];
          for (var i = 0; i < rawParts.length; i += 1) {
            var rawPart = rawParts[i];
            if (rawPart.length < 1) continue;
            var decoded;
            try { decoded = decodeURIComponent(rawPart); } catch { return null; }
            if (decoded.length < 1) continue;
            if (decoded.indexOf('/') >= 0 || decoded.indexOf('\\\\') >= 0 || /[\\u0000]/.test(decoded)) return null;
            decodedParts.push(decoded);
          }
          return normalizeRelativePath(decodedParts.join('/'), true);
        }

        function parsePositiveInt(raw) {
          if (typeof raw !== 'string' || raw.trim() === '') return null;
          var parsed = Number.parseInt(raw, 10);
          return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
        }

        function detectLang(filePath) {
          var idx = filePath.lastIndexOf('.');
          var ext = idx >= 0 ? filePath.slice(idx + 1).toLowerCase() : '';
          var map = {
            c: 'c', cc: 'cpp', cpp: 'cpp', cs: 'csharp', css: 'css',
            go: 'go', h: 'c', hpp: 'cpp', html: 'xml', java: 'java',
            js: 'javascript', json: 'json', jsx: 'jsx', kt: 'kotlin', md: 'markdown',
            mjs: 'javascript', mts: 'typescript', py: 'python', rb: 'ruby', rs: 'rust',
            sh: 'bash', sql: 'sql', toml: 'toml', ts: 'typescript', tsx: 'tsx',
            txt: 'plaintext', vue: 'xml', xml: 'xml', yaml: 'yaml', yml: 'yaml'
          };
          return Object.prototype.hasOwnProperty.call(map, ext) ? map[ext] : 'plaintext';
        }

        function formatBytes(size) {
          if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) return '';
          if (size < 1024) return String(size) + ' B';
          if (size < 1024 * 1024) return (size / 1024).toFixed(1) + ' KiB';
          return (size / (1024 * 1024)).toFixed(1) + ' MiB';
        }

        function buildPreviewHref(relativePath) {
          if (typeof relativePath !== 'string') return '/f';
          var normalized = normalizeRelativePath(relativePath, true);
          if (normalized === null || normalized.length < 1) return '/f';
          return '/f/' + normalized.split('/').map(function (segment) {
            return encodeURIComponent(segment);
          }).join('/');
        }

        function parentPathOf(relativePath) {
          if (relativePath.length < 1) return null;
          var parts = relativePath.split('/');
          parts.pop();
          return parts.join('/');
        }

        function renderHighlightedSegment(raw, lang) {
          if (typeof raw !== 'string' || raw.length < 1) return '';
          if (
            window.hljs &&
            typeof window.hljs.highlight === 'function' &&
            typeof window.hljs.getLanguage === 'function' &&
            lang !== 'plaintext' &&
            window.hljs.getLanguage(lang)
          ) {
            return window.hljs.highlight(raw, { language: lang, ignoreIllegals: true }).value;
          }
          return escapeHtml(raw);
        }

        function buildLineHtml(rawLine, lang, isTargetLine, targetColumn) {
          if (!isTargetLine || targetColumn === null) {
            return rawLine.length > 0 ? renderHighlightedSegment(rawLine, lang) : '';
          }
          var clampedColumn = targetColumn;
          if (clampedColumn < 1) clampedColumn = 1;
          if (clampedColumn > rawLine.length + 1) clampedColumn = rawLine.length + 1;
          var splitIndex = clampedColumn - 1;
          var before = rawLine.slice(0, splitIndex);
          var after = rawLine.slice(splitIndex + 1);
          if (splitIndex >= rawLine.length) {
            return renderHighlightedSegment(rawLine, lang) + '<span class="target-col-caret" aria-hidden="true"></span>';
          }
          var targetChar = rawLine.charAt(splitIndex);
          return (
            renderHighlightedSegment(before, lang) +
            '<span class="target-col">' + renderHighlightedSegment(targetChar, lang) + '</span>' +
            renderHighlightedSegment(after, lang)
          );
        }

        function renderFile(raw, lang, targetLine, targetColumn) {
          codeViewEl.innerHTML = '';
          var lines = raw.split('\\n');
          var fragment = document.createDocumentFragment();
          var selectedLineEl = null;
          for (var i = 0; i < lines.length; i += 1) {
            var lineNumber = i + 1;
            var rawLine = lines[i];
            var rowEl = document.createElement('div');
            rowEl.className = 'code-line' + (lineNumber === targetLine ? ' target-line' : '');
            rowEl.setAttribute('data-line', String(lineNumber));

            var lineNoEl = document.createElement('span');
            lineNoEl.className = 'line-no';
            lineNoEl.textContent = String(lineNumber);
            lineNoEl.setAttribute('aria-hidden', 'true');

            var lineContentEl = document.createElement('span');
            lineContentEl.className = 'line-content hljs';
            lineContentEl.innerHTML = buildLineHtml(rawLine, lang, lineNumber === targetLine, targetColumn);

            rowEl.appendChild(lineNoEl);
            rowEl.appendChild(lineContentEl);
            fragment.appendChild(rowEl);
            if (lineNumber === targetLine) {
              selectedLineEl = rowEl;
            }
          }
          codeViewEl.appendChild(fragment);
          codeWrapEl.style.display = 'block';
          if (selectedLineEl && typeof selectedLineEl.scrollIntoView === 'function') {
            selectedLineEl.scrollIntoView({ block: 'center' });
          }
        }

        function createEntryLink(relativePath, label, icon) {
          var link = document.createElement('a');
          link.href = buildPreviewHref(relativePath);
          link.className = 'entry-name';

          var iconEl = document.createElement('span');
          iconEl.className = 'entry-icon';
          iconEl.textContent = icon;

          var labelEl = document.createElement('span');
          labelEl.className = 'entry-label';
          labelEl.textContent = label;

          link.appendChild(iconEl);
          link.appendChild(labelEl);
          return link;
        }

        function describeEntryNote(entry) {
          if (!entry || entry.isSymlink !== true) return '';
          if (typeof entry.symlinkTarget !== 'string' || entry.symlinkTarget.length < 1) return 'symlink';
          return 'symlink → ' + entry.symlinkTarget;
        }

        function createDirRow(entry) {
          var row = document.createElement('tr');

          var nameCell = document.createElement('td');
          var label = entry.name + (entry.kind === 'directory' ? '/' : '');
          var icon = entry.kind === 'directory' ? '📁' : entry.kind === 'file' ? '📄' : '⛔';
          if (entry.kind === 'directory' || entry.kind === 'file') {
            nameCell.appendChild(createEntryLink(entry.path, label, icon));
          } else {
            var nameWrap = document.createElement('span');
            nameWrap.className = 'entry-name';
            var iconEl = document.createElement('span');
            iconEl.className = 'entry-icon';
            iconEl.textContent = icon;
            var labelEl = document.createElement('span');
            labelEl.className = 'entry-label';
            labelEl.textContent = label;
            nameWrap.appendChild(iconEl);
            nameWrap.appendChild(labelEl);
            nameCell.appendChild(nameWrap);
          }

          var typeCell = document.createElement('td');
          typeCell.className = 'entry-type';
          typeCell.textContent = entry.kind;

          var sizeCell = document.createElement('td');
          sizeCell.className = 'entry-size';
          sizeCell.textContent = typeof entry.size === 'number' ? formatBytes(entry.size) : '';

          var noteCell = document.createElement('td');
          var note = describeEntryNote(entry);
          if (typeof entry.resolvedKind === 'string' && entry.resolvedKind !== entry.kind) {
            note = note
              ? note + ' | ' + entry.resolvedKind
              : entry.resolvedKind;
          }
          if (note) {
            var noteEl = document.createElement('div');
            noteEl.className = 'entry-note' + (entry.kind === 'other' ? ' warn' : '');
            noteEl.textContent = note;
            noteCell.appendChild(noteEl);
          }

          row.appendChild(nameCell);
          row.appendChild(typeCell);
          row.appendChild(sizeCell);
          row.appendChild(noteCell);
          return row;
        }

        function renderDirectory(currentPath, entries) {
          dirBodyEl.innerHTML = '';
          var fragment = document.createDocumentFragment();

          var parentPath = parentPathOf(currentPath);
          if (parentPath !== null) {
            var parentRow = document.createElement('tr');
            var nameCell = document.createElement('td');
            nameCell.appendChild(createEntryLink(parentPath, '../', '↩'));
            var typeCell = document.createElement('td');
            typeCell.className = 'entry-type';
            typeCell.textContent = 'directory';
            var sizeCell = document.createElement('td');
            sizeCell.className = 'entry-size';
            var noteCell = document.createElement('td');
            parentRow.appendChild(nameCell);
            parentRow.appendChild(typeCell);
            parentRow.appendChild(sizeCell);
            parentRow.appendChild(noteCell);
            fragment.appendChild(parentRow);
          }

          for (var i = 0; i < entries.length; i += 1) {
            fragment.appendChild(createDirRow(entries[i]));
          }

          dirBodyEl.appendChild(fragment);
          dirWrapEl.style.display = 'block';
        }

        var previewPath = parseRelativePathFromLocation();
        if (previewPath === null) {
          pathEl.textContent = 'Invalid preview path';
          setError('Invalid preview path. Expected /f/<rtws-relative-path> and no ..');
          return;
        }

        var search = new URLSearchParams(window.location.search);
        var line = parsePositiveInt(search.get('line'));
        var column = parsePositiveInt(search.get('column'));
        var authFromUrl = search.get('auth');
        var authFromStorage = null;
        try { authFromStorage = window.localStorage.getItem('dominds.authKey'); } catch {}
        var token =
          (typeof authFromUrl === 'string' && authFromUrl.trim() !== '' ? authFromUrl.trim() : null) ||
          (typeof authFromStorage === 'string' && authFromStorage.trim() !== '' ? authFromStorage.trim() : null);

        pathEl.textContent = previewPath.length > 0 ? previewPath : '.';
        if (line !== null) {
          metaEl.textContent = 'Line ' + String(line) + (column !== null ? ':' + String(column) : '');
        } else {
          metaEl.textContent = '';
        }

        var headers = { Accept: 'application/json' };
        if (token !== null) {
          headers['Authorization'] = 'Bearer ' + token;
        }

        resetViews();
        fetch('/api/workspace/entry?path=' + encodeURIComponent(previewPath), {
          method: 'GET',
          headers: headers,
          cache: 'no-store'
        })
          .then(function (resp) {
            return resp.json().catch(function () { return {}; }).then(function (payload) {
              return { ok: resp.ok, status: resp.status, payload: payload };
            });
          })
          .then(function (result) {
            if (!result.ok || !result.payload || result.payload.success !== true || typeof result.payload.kind !== 'string') {
              var msg = result.payload && typeof result.payload.error === 'string' && result.payload.error !== ''
                ? result.payload.error
                : ('Request failed: HTTP ' + String(result.status));
              setError(msg);
              return;
            }

            showReady();
            pathEl.textContent =
              typeof result.payload.path === 'string' && result.payload.path.length > 0
                ? result.payload.path
                : '.';

            if (result.payload.kind === 'file' && typeof result.payload.raw === 'string') {
              var lang = detectLang(typeof result.payload.path === 'string' ? result.payload.path : previewPath);
              var sizeText = formatBytes(result.payload.size);
              var metaItems = [];
              if (line !== null) metaItems.push('Line ' + String(line) + (column !== null ? ':' + String(column) : ''));
              metaItems.push(lang);
              if (sizeText) metaItems.push(sizeText);
              metaEl.textContent = metaItems.join(' | ');
              renderFile(result.payload.raw, lang, line, column);
              return;
            }

            if (result.payload.kind === 'directory' && Array.isArray(result.payload.entries)) {
              metaEl.textContent = 'directory | ' + String(result.payload.entries.length) + ' entries';
              renderDirectory(
                typeof result.payload.path === 'string' ? result.payload.path : previewPath,
                result.payload.entries,
              );
              return;
            }

            setError('Invalid preview payload');
          })
          .catch(function (err) {
            var msg = err && typeof err.message === 'string' ? err.message : 'Failed to load workspace entry';
            setError(msg);
          });
      })();
    </script>
  </body>
</html>`;

  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(html);
  return true;
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
    if (pathname === '/api/priming/scripts' && req.method === 'GET') {
      return await handleListPrimingScripts(req, res);
    }

    if (pathname === '/api/priming/save-current-course' && req.method === 'POST') {
      return await handleSaveCurrentCoursePriming(req, res);
    }

    // Dialog list endpoint
    if (pathname === '/api/dialogs' && req.method === 'GET') {
      const urlObj = new URL(req.url ?? '', 'http://127.0.0.1');
      const status = parseDialogStatusFromUrl(urlObj);
      if (!status) {
        respondJson(res, 400, { success: false, error: 'Invalid status' });
        return true;
      }
      return await handleGetDialogs(res, status);
    }

    if (pathname === '/api/dialogs/run-control-counts' && req.method === 'GET') {
      return await handleGetRunControlCounts(res);
    }

    // Resolve dialog status by id without relying on frontend-maintained lists.
    if (pathname === '/api/dialogs/resolve-status' && req.method === 'GET') {
      return await handleResolveDialogStatus(req, res);
    }

    // Create dialog endpoint
    if (pathname === '/api/dialogs' && req.method === 'POST') {
      return await handleCreateDialog(req, res, context);
    }

    // Move dialogs between status directories (running/completed/archived)
    if (pathname === '/api/dialogs/move' && req.method === 'POST') {
      return await handleMoveDialogs(req, res, context);
    }

    if (
      pathname.startsWith('/api/dialogs/') &&
      pathname.endsWith('/fork') &&
      req.method === 'POST'
    ) {
      const parts = pathname.split('/');
      const rawRoot = parts[3];
      if (!rawRoot) {
        respondJson(res, 400, { success: false, error: 'Missing root dialog id' });
        return true;
      }
      return await handleForkDialog(req, res, context, rawRoot.replace(/%2F/g, '/'));
    }

    // Delete a dialog (root dialogs only for now)
    if (
      pathname.startsWith('/api/dialogs/') &&
      !pathname.endsWith('/hierarchy') &&
      !pathname.endsWith('/fork') &&
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
      const urlObj = new URL(req.url ?? '', 'http://127.0.0.1');
      const fromStatusRaw = urlObj.searchParams.get('fromStatus');
      if (
        fromStatusRaw !== 'running' &&
        fromStatusRaw !== 'completed' &&
        fromStatusRaw !== 'archived'
      ) {
        respondJson(res, 400, { error: 'Invalid fromStatus' });
        return true;
      }
      return await handleDeleteDialog(res, { rootId, selfId, fromStatus: fromStatusRaw }, context);
    }

    // Get full hierarchy for a single root dialog
    if (
      pathname.startsWith('/api/dialogs/') &&
      pathname.endsWith('/hierarchy') &&
      req.method === 'GET'
    ) {
      const parts = pathname.split('/');
      const rootId = parts[3].replace(/%2F/g, '/');
      const urlObj = new URL(req.url ?? '', 'http://127.0.0.1');
      const status = parseDialogStatusFromUrl(urlObj);
      if (!status) {
        respondJson(res, 400, { success: false, error: 'Invalid status' });
        return true;
      }
      return await handleGetDialogHierarchy(res, rootId, status);
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
      const urlObj = new URL(req.url ?? '', 'http://127.0.0.1');
      const status = parseDialogStatusFromUrl(urlObj);
      if (!status) {
        respondJson(res, 400, { success: false, error: 'Invalid status' });
        return true;
      }
      return await handleGetDialogArtifact(req, res, { rootId, selfId }, status);
    }

    // Get specific dialog
    if (pathname.startsWith('/api/dialogs/') && req.method === 'GET') {
      const parts = pathname.split('/');
      const selfId = (parts[4] || parts[3]).replace(/%2F/g, '/');
      const rootId = parts[3].replace(/%2F/g, '/');
      const urlObj = new URL(req.url ?? '', 'http://127.0.0.1');
      const status = parseDialogStatusFromUrl(urlObj);
      if (!status) {
        respondJson(res, 400, { success: false, error: 'Invalid status' });
        return true;
      }
      const dialog: DialogIdent = { selfId, rootId, status };
      return await handleGetDialog(res, dialog, status);
    }

    // Taskdocs endpoint
    if (pathname === '/api/task-documents' && req.method === 'GET') {
      return await handleGetTaskDocuments(res);
    }

    // Tools registry endpoint (snapshot)
    if (pathname === '/api/tools-registry' && req.method === 'GET') {
      return await handleGetToolsRegistry(req, res);
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

    // Read workspace file or directory content for markdown preview links.
    if (pathname === '/api/workspace/entry' && req.method === 'GET') {
      return await handleReadWorkspaceEntry(req, res);
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

    if (pathname === '/api/team_mgmt/manual' && req.method === 'POST') {
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
  'dialog-persistence',
  'interruption-resumption',
  'diligence-push',
  'auth',
  'dominds-terminology',
  'cli-usage',
  'mottos',
  'encapsulated-taskdoc',
  'memory-system',
  'mcp-support',
  'context-health',
  'team_mgmt-toolset',
  'i18n',
  'txt-editing-tools',
  'fbr',
  'agent-priming',
  'q4h',
  'roadmap',
  'OEC-philosophy',
  'design.md',
  'dialog-system.md',
  'dialog-persistence.md',
  'interruption-resumption.md',
  'diligence-push.md',
  'auth.md',
  'dominds-terminology.md',
  'cli-usage.md',
  'mottos.md',
  'encapsulated-taskdoc.md',
  'memory-system.md',
  'mcp-support.md',
  'context-health.md',
  'team_mgmt-toolset.md',
  'i18n.md',
  'txt-editing-tools.md',
  'fbr.md',
  'agent-priming.md',
  'q4h.md',
  'roadmap.md',
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

  // In development, prefer source docs so live doc fixes show up immediately without rebuilding dist/docs.
  for (const filePath of [...candidatesFallback, ...candidates]) {
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

const WORKSPACE_FILE_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;
type WorkspacePreviewEntryKind = 'directory' | 'file' | 'other';
type WorkspacePreviewResolvedKind = WorkspacePreviewEntryKind | 'broken' | 'outside_rtws';

function ensurePathSuffixSeparator(input: string): string {
  if (input.endsWith(path.sep)) return input;
  return `${input}${path.sep}`;
}

function isWithinResolvedRoot(targetAbsPath: string, rootAbsPath: string): boolean {
  if (targetAbsPath === rootAbsPath) return true;
  return targetAbsPath.startsWith(ensurePathSuffixSeparator(rootAbsPath));
}

function normalizeRtwsRelativePath(
  input: string,
  options: Readonly<{ allowRoot: boolean }>,
): string | null {
  const trimmed = input.trim();
  if (trimmed.includes('\0')) return null;
  if (trimmed.includes('\\')) return null;
  if (path.posix.isAbsolute(trimmed)) return null;
  const normalized = path.posix.normalize(trimmed);
  if (normalized === '..') return null;
  if (normalized === '.' || normalized.length < 1) {
    return options.allowRoot ? '' : null;
  }
  if (normalized.startsWith('../')) return null;
  if (normalized.includes('/../')) return null;
  if (normalized.startsWith('/')) return null;
  const segments = normalized.split('/');
  if (segments.some((segment) => segment.length < 1 || segment === '.' || segment === '..')) {
    return null;
  }
  return normalized;
}

function parseWorkspacePreviewPathname(pathname: string): string | null {
  if (pathname === '/f' || pathname === '/f/') return '';
  if (!pathname.startsWith('/f/')) return null;

  const tail = pathname.slice('/f/'.length);
  if (tail.length < 1) return '';

  const rawParts = tail.split('/');
  const decodedParts: string[] = [];
  for (const rawPart of rawParts) {
    if (rawPart.length < 1) continue;

    let decoded: string;
    try {
      decoded = decodeURIComponent(rawPart);
    } catch {
      return null;
    }

    if (decoded.length < 1) continue;
    if (decoded.includes('/') || decoded.includes('\\') || decoded.includes('\0')) {
      return null;
    }
    decodedParts.push(decoded);
  }

  return normalizeRtwsRelativePath(decodedParts.join('/'), { allowRoot: true });
}

async function getWorkspaceRootRealAbs(): Promise<string> {
  const workspaceRootAbs = path.resolve(process.cwd());
  try {
    return await fsPromises.realpath(workspaceRootAbs);
  } catch {
    return workspaceRootAbs;
  }
}

function classifyWorkspaceEntryKind(followStat: {
  isDirectory: () => boolean;
  isFile: () => boolean;
}): WorkspacePreviewEntryKind {
  if (followStat.isDirectory()) return 'directory';
  if (followStat.isFile()) return 'file';
  return 'other';
}

async function resolveWorkspacePreviewPath(pathRel: string): Promise<{
  workspaceRootAbs: string;
  workspaceRootRealAbs: string;
  candidateAbsPath: string;
  resolvedAbsPath: string;
}> {
  const workspaceRootAbs = path.resolve(process.cwd());
  const workspaceRootRealAbs = await getWorkspaceRootRealAbs();
  const candidateAbsPath =
    pathRel.length < 1 ? workspaceRootAbs : path.resolve(workspaceRootAbs, pathRel);

  if (!isWithinResolvedRoot(candidateAbsPath, workspaceRootAbs)) {
    const error = new Error(`Workspace preview path escaped rtws: ${pathRel}`);
    (error as Error & { code?: string }).code = 'OUTSIDE_RTWS';
    throw error;
  }

  const resolvedAbsPath = await fsPromises.realpath(candidateAbsPath);
  if (!isWithinResolvedRoot(resolvedAbsPath, workspaceRootRealAbs)) {
    const error = new Error(`Workspace preview path resolved outside rtws: ${pathRel}`);
    (error as Error & { code?: string }).code = 'OUTSIDE_RTWS';
    throw error;
  }

  return {
    workspaceRootAbs,
    workspaceRootRealAbs,
    candidateAbsPath,
    resolvedAbsPath,
  };
}

async function listWorkspaceDirectoryEntries(params: {
  pathRel: string;
  dirAbsPath: string;
  workspaceRootRealAbs: string;
}): Promise<
  Array<{
    name: string;
    path: string;
    kind: WorkspacePreviewEntryKind;
    resolvedKind: WorkspacePreviewResolvedKind;
    size?: number;
    isSymlink: boolean;
    symlinkTarget?: string;
  }>
> {
  const entryNames = await fsPromises.readdir(params.dirAbsPath);
  const entries = await Promise.all(
    entryNames.map(async (name) => {
      const childRelPath = params.pathRel.length < 1 ? name : `${params.pathRel}/${name}`;
      const childAbsPath = path.resolve(process.cwd(), childRelPath);
      const lstat = await fsPromises.lstat(childAbsPath);
      const isSymlink = lstat.isSymbolicLink();
      let symlinkTarget: string | undefined;
      if (isSymlink) {
        try {
          symlinkTarget = await fsPromises.readlink(childAbsPath);
        } catch {
          symlinkTarget = undefined;
        }
      }

      let resolvedKind: WorkspacePreviewResolvedKind;
      let kind: WorkspacePreviewEntryKind;
      let size: number | undefined;

      try {
        const resolvedChildAbsPath = await fsPromises.realpath(childAbsPath);
        if (!isWithinResolvedRoot(resolvedChildAbsPath, params.workspaceRootRealAbs)) {
          resolvedKind = 'outside_rtws';
          kind = 'other';
        } else {
          const followStat = await fsPromises.stat(childAbsPath);
          resolvedKind = classifyWorkspaceEntryKind(followStat);
          kind = resolvedKind;
          size = followStat.isFile() ? followStat.size : undefined;
        }
      } catch (error: unknown) {
        if (getErrorCode(error) === 'ENOENT') {
          resolvedKind = 'broken';
          kind = 'other';
        } else {
          throw error;
        }
      }

      return {
        name,
        path: childRelPath,
        kind,
        resolvedKind,
        size,
        isSymlink,
        symlinkTarget,
      };
    }),
  );

  entries.sort((a, b) => {
    const rank = (kind: WorkspacePreviewEntryKind): number => {
      switch (kind) {
        case 'directory':
          return 0;
        case 'file':
          return 1;
        case 'other':
          return 2;
      }
    };
    const rankDiff = rank(a.kind) - rank(b.kind);
    if (rankDiff !== 0) return rankDiff;
    return a.name.localeCompare(b.name);
  });

  return entries;
}

async function readFileHead(fileAbsPath: string, maxBytes: number): Promise<Buffer> {
  const file = await fsPromises.open(fileAbsPath, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await file.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}

async function handleReadWorkspaceEntry(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const urlObj = new URL(req.url ?? '', 'http://127.0.0.1');
  const pathRaw = urlObj.searchParams.get('path');
  const pathRel =
    typeof pathRaw === 'string' ? normalizeRtwsRelativePath(pathRaw, { allowRoot: true }) : '';

  if (pathRel === null) {
    respondJson(res, 400, { success: false, error: 'Invalid workspace path' });
    return true;
  }

  try {
    const resolved = await resolveWorkspacePreviewPath(pathRel);
    const stat = await fsPromises.stat(resolved.candidateAbsPath);

    if (stat.isDirectory()) {
      const entries = await listWorkspaceDirectoryEntries({
        pathRel,
        dirAbsPath: resolved.resolvedAbsPath,
        workspaceRootRealAbs: resolved.workspaceRootRealAbs,
      });
      respondJson(res, 200, {
        success: true,
        kind: 'directory',
        path: pathRel,
        entries,
      });
      return true;
    }

    if (!stat.isFile()) {
      respondJson(res, 400, {
        success: false,
        error: 'Path must resolve to a file or directory',
        path: pathRel,
      });
      return true;
    }
    if (stat.size > WORKSPACE_FILE_PREVIEW_MAX_BYTES) {
      respondJson(res, 413, {
        success: false,
        error: `File too large for preview (max ${WORKSPACE_FILE_PREVIEW_MAX_BYTES} bytes)`,
        path: pathRel,
        size: stat.size,
      });
      return true;
    }

    const raw = await fsPromises.readFile(resolved.candidateAbsPath, 'utf-8');
    respondJson(res, 200, {
      success: true,
      kind: 'file',
      path: pathRel,
      raw,
      size: stat.size,
    });
    return true;
  } catch (error: unknown) {
    const code = getErrorCode(error);
    if (code === 'ENOENT') {
      respondJson(res, 404, { success: false, error: 'Path not found', path: pathRel });
      return true;
    }
    if (code === 'OUTSIDE_RTWS') {
      respondJson(res, 403, {
        success: false,
        error: 'Path resolves outside rtws',
        path: pathRel,
      });
      return true;
    }
    log.error('Failed to read workspace entry', error, { path: pathRel });
    respondJson(res, 500, { success: false, error: 'Failed to read workspace entry' });
    return true;
  }
}

async function handleGetToolsRegistry(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  try {
    await registerEnabledAppsToolProxies({ rtwsRootAbs: process.cwd() });
    const urlObj = new URL(req.url ?? '', 'http://127.0.0.1');
    const rootIdRaw = urlObj.searchParams.get('rootId');
    const selfIdRaw = urlObj.searchParams.get('selfId');
    const agentIdRaw = urlObj.searchParams.get('agentId');
    const taskDocPathRaw = urlObj.searchParams.get('taskDocPath');
    const rootId = typeof rootIdRaw === 'string' ? rootIdRaw.trim() : '';
    const selfId = typeof selfIdRaw === 'string' ? selfIdRaw.trim() : '';
    const requestedAgentId = typeof agentIdRaw === 'string' ? agentIdRaw.trim() : '';
    const requestedTaskDocPath = typeof taskDocPathRaw === 'string' ? taskDocPathRaw.trim() : '';

    const resolveDialogMetadata = async (): Promise<DialogMetadataFile | null> => {
      if (rootId === '' || selfId === '') {
        return null;
      }

      const requestedStatus = parseDialogStatusFromUrl(urlObj);
      const statusOrder = [
        'running',
        'completed',
        'archived',
      ] as const satisfies readonly DialogStatusKind[];
      const candidateStatuses =
        requestedStatus === null
          ? statusOrder
          : ([
              requestedStatus,
              ...statusOrder.filter((status) => status !== requestedStatus),
            ] as const);

      for (const status of candidateStatuses) {
        const dialogId = new DialogID(selfId, rootId);
        const metadata = await DialogPersistence.loadDialogMetadata(dialogId, status);
        if (metadata) {
          return metadata;
        }
      }
      return null;
    };

    const dialogMetadata = await resolveDialogMetadata();
    const agentId = dialogMetadata?.agentId ?? requestedAgentId;
    const taskDocPath = dialogMetadata?.taskDocPath ?? requestedTaskDocPath;

    let snapshot = createToolsRegistrySnapshot();
    if (agentId !== '') {
      const team = await Team.load();
      const member = team.getMember(agentId);
      if (!member) {
        respondJson(res, 404, {
          success: false,
          error: `Unknown team member: ${agentId}`,
        });
        return true;
      }

      const dynamicToolsetNames = await Team.listDynamicToolsetNamesForMember({
        member,
        taskDocPath,
        rtwsRootAbs: process.cwd(),
      });
      const includeToolsetNames = member.listResolvedToolsetNames({
        onMissing: 'silent',
        dynamicToolsetNames,
      });
      snapshot = createToolsRegistrySnapshot({ includeToolsetNames });
    }

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
    const workspace = process.cwd();
    const healthData = {
      ok: true,
      timestamp: formatUnifiedTimestamp(new Date()),
      server: 'dominds',
      version,
      // `workspace` is the canonical name used by WebUI indicators.
      // Keep `rtws` for backward compatibility.
      workspace,
      rtws: workspace,
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
async function handleGetDialogs(res: ServerResponse, status: DialogStatusKind): Promise<boolean> {
  try {
    const rootDialogs: Array<{
      rootId: string;
      agentId: string;
      taskDocPath: string;
      status: 'running' | 'completed' | 'archived';
      currentCourse: number;
      createdAt: string;
      lastModified: string;
      displayState?: DialogLatestFile['displayState'];
      subdialogCount: number;
    }> = [];

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
        displayState: latest?.displayState,
        subdialogCount,
      });
    }

    respondJson(res, 200, { success: true, dialogs: rootDialogs });
    return true;
  } catch (error) {
    log.error('Error getting root dialogs:', error);
    respondJson(res, 500, { success: false, error: 'Failed to get root dialogs' });
    return true;
  }
}

async function handleGetRunControlCounts(res: ServerResponse): Promise<boolean> {
  try {
    const counts = await getRunControlCountsSnapshot();
    respondJson(res, 200, {
      success: true,
      counts: {
        proceeding: counts.proceeding,
        resumable: counts.resumable,
      },
    });
    return true;
  } catch (error) {
    log.error('Error getting run control counts:', error);
    respondJson(res, 500, { success: false, error: 'Failed to get run control counts' });
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
async function handleGetDialogHierarchy(
  res: ServerResponse,
  rootId: string,
  status: DialogStatusKind,
): Promise<boolean> {
  try {
    const rootMeta = await DialogPersistence.loadRootDialogMetadata(new DialogID(rootId), status);
    if (!rootMeta) {
      respondJson(res, 404, {
        success: false,
        error: `Root dialog ${rootId} not found in ${status}`,
      });
      return true;
    }

    // Load latest.yaml for root dialog currentCourse and lastModified timestamp
    const rootLatest: DialogLatestFile | null = await DialogPersistence.loadDialogLatest(
      new DialogID(rootId),
      status,
    );

    const rootInfo = {
      id: rootMeta.id,
      agentId: rootMeta.agentId,
      taskDocPath: rootMeta.taskDocPath,
      status,
      currentCourse: rootLatest?.currentCourse || 1,
      createdAt: rootMeta.createdAt,
      lastModified: rootLatest?.lastModified || rootMeta.createdAt,
      displayState: rootLatest?.displayState,
    };

    let subdialogs: Array<{
      selfId: string;
      rootId: string;
      supdialogId?: string;
      agentId: string;
      taskDocPath: string;
      status: 'running' | 'completed' | 'archived';
      currentCourse: number;
      createdAt: string;
      lastModified: string;
      displayState?: DialogLatestFile['displayState'];
      sessionSlug?: string;
      assignmentFromSup?: DialogMetadataFile['assignmentFromSup'];
    }> = [];

    const dialogIds = await DialogPersistence.listAllDialogIds(status);
    for (const dialogId of dialogIds) {
      if (dialogId.rootId !== rootId || dialogId.selfId === rootId) {
        continue;
      }
      const meta = await DialogPersistence.loadDialogMetadata(dialogId, status);
      if (!meta) {
        continue;
      }

      const subLatest = await DialogPersistence.loadDialogLatest(dialogId, status);
      const derivedSupdialogId =
        meta.assignmentFromSup?.callerDialogId &&
        meta.assignmentFromSup.callerDialogId.trim() !== ''
          ? meta.assignmentFromSup.callerDialogId
          : typeof meta.supdialogId === 'string' && meta.supdialogId.trim() !== ''
            ? meta.supdialogId
            : undefined;

      subdialogs.push({
        selfId: meta.id,
        rootId,
        supdialogId: derivedSupdialogId,
        agentId: meta.agentId,
        taskDocPath: meta.taskDocPath,
        status,
        currentCourse: subLatest?.currentCourse || 1,
        createdAt: meta.createdAt,
        lastModified: subLatest?.lastModified || meta.createdAt,
        displayState: subLatest?.displayState,
        sessionSlug: meta.sessionSlug,
        assignmentFromSup: meta.assignmentFromSup,
      });
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
    const parsed: unknown = JSON.parse(body);
    if (!isRecord(parsed)) {
      const payload = makeCreateDialogFailure('unknown', 'CREATE_FAILED', 'Invalid JSON body');
      respondJson(res, 400, payload);
      return true;
    }
    const request = parseCreateDialogInput(parsed);
    if ('status' in request) {
      respondJson(res, request.status, {
        kind: 'failure',
        requestId: request.requestId,
        errorCode: request.errorCode,
        error: request.error,
      });
      return true;
    }

    const { requestId, agentId, taskDocPath, priming } = request;

    // Generate dialog ID
    const generatedId = generateDialogID();
    const dialogId = new DialogID(generatedId);

    // Create dialog UI based on context
    // Always use DiskFileDialogStore for file-based persistence
    const dialogUI: DialogStore = new DiskFileDialogStore(dialogId);

    // Create RootDialog
    const dialog = new RootDialog(dialogUI, taskDocPath, dialogId, agentId);
    dialog.setPersistenceStatus('running');
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
      priming: buildRootDialogPrimingMetadata(priming),
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
        displayState: { kind: 'idle_waiting_user' },
        disableDiligencePush: defaultDisableDiligencePush,
        diligencePushRemainingBudget: dialog.diligencePushRemainingBudget,
      },
    }));

    if (priming && priming.scriptRefs.length > 0) {
      await applyPrimingScriptsToDialog({
        dialog,
        agentId,
        status: 'running',
        priming,
      });
    }

    // Dialog is registered with the global registry on creation
    // No need to call registerDialog

    respondJson(res, 201, {
      kind: 'success',
      requestId,
      selfId: dialogId.selfId,
      rootId: dialogId.rootId,
      agentId,
      taskDocPath,
    });
    broadcastDialogCreates(context.clients, {
      type: 'dialogs_created',
      scope: { kind: 'root', rootId: dialogId.selfId },
      status: 'running',
      createdRootIds: [dialogId.selfId],
      timestamp: formatUnifiedTimestamp(new Date()),
    });

    return true;
  } catch (error: unknown) {
    log.error('Error creating dialog:', error);
    const message = error instanceof Error ? error.message : 'Failed to create dialog';
    const payload = makeCreateDialogFailure('unknown', 'CREATE_FAILED', message);
    respondJson(res, 500, payload);
    return true;
  }
}

async function handleForkDialog(
  req: IncomingMessage,
  res: ServerResponse,
  context: ApiRouteContext,
  rootIdRaw: string,
): Promise<boolean> {
  try {
    const body = await readRequestBody(req);
    const parsed: unknown = JSON.parse(body);
    if (!isRecord(parsed)) {
      const payload: ApiForkDialogResponse = { success: false, error: 'Invalid JSON body' };
      respondJson(res, 400, payload);
      return true;
    }

    const courseRaw = parsed['course'];
    const genseqRaw = parsed['genseq'];
    const statusRaw = parsed['status'];
    const rootId = rootIdRaw.trim();
    const course =
      typeof courseRaw === 'number' && Number.isFinite(courseRaw) ? Math.floor(courseRaw) : 0;
    const genseq =
      typeof genseqRaw === 'number' && Number.isFinite(genseqRaw) ? Math.floor(genseqRaw) : 0;
    const status = parseDialogStatusKind(statusRaw) ?? 'running';

    if (rootId === '') {
      const payload: ApiForkDialogResponse = { success: false, error: 'rootId is required' };
      respondJson(res, 400, payload);
      return true;
    }
    if (course <= 0 || genseq <= 0) {
      const payload: ApiForkDialogResponse = {
        success: false,
        error: 'course and genseq must be positive integers',
      };
      respondJson(res, 400, payload);
      return true;
    }

    const result = await forkRootDialogTreeAtGeneration({
      sourceRootId: rootId,
      sourceStatus: status,
      course,
      genseq,
    });

    const payload: ApiForkDialogResponse = {
      success: true,
      dialog: {
        rootId: result.rootId,
        selfId: result.selfId,
        agentId: result.agentId,
        agentName: result.agentId,
        taskDocPath: result.taskDocPath,
        status: 'running',
      },
      action: result.action,
    };
    respondJson(res, 201, payload);
    broadcastDialogCreates(context.clients, {
      type: 'dialogs_created',
      scope: { kind: 'root', rootId: result.rootId },
      status: 'running',
      createdRootIds: [result.rootId],
      timestamp: formatUnifiedTimestamp(new Date()),
    });
    return true;
  } catch (error: unknown) {
    log.error('Error forking dialog:', error);
    const payload: ApiForkDialogResponse = {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to fork dialog',
    };
    respondJson(res, 500, payload);
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
      if (fromStatus === 'running' || toStatus === 'running') {
        await broadcastRunControlCounts(context.clients);
      }
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
    if (fromStatus === 'running' || toStatus === 'running') {
      await broadcastRunControlCounts(context.clients);
    }
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

async function broadcastRunControlCounts(clients: Set<WebSocket> | undefined): Promise<void> {
  if (!clients) return;
  const counts = await getRunControlCountsSnapshot();
  const data = JSON.stringify({
    type: 'run_control_counts_evt',
    proceeding: counts.proceeding,
    resumable: counts.resumable,
    timestamp: formatUnifiedTimestamp(new Date()),
  });
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
  dialog: { rootId: string; selfId: string; fromStatus: DialogStatusKind },
  context: ApiRouteContext,
): Promise<boolean> {
  try {
    const { rootId, selfId, fromStatus } = dialog;
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

    const deleted = await DialogPersistence.deleteRootDialog(new DialogID(rootId), fromStatus);
    if (!deleted) {
      respondJson(res, 404, { error: `Dialog not found in ${fromStatus}` });
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
    if (fromStatus === 'running') {
      await broadcastRunControlCounts(context.clients);
    }
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
async function handleGetDialog(
  res: ServerResponse,
  dialog: DialogIdent,
  status: DialogStatusKind,
): Promise<boolean> {
  try {
    const metadata: DialogMetadataFile | null = await DialogPersistence.loadDialogMetadata(
      new DialogID(dialog.selfId, dialog.rootId),
      status,
    );
    if (!metadata) {
      respondJson(res, 404, { success: false, error: `Dialog not found in ${status}` });
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
      status,
    );

    const dialogData = {
      id: metadata.id,
      agentId: metadata.agentId,
      status,
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

async function handleResolveDialogStatus(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  try {
    const urlObj = new URL(req.url ?? '', 'http://127.0.0.1');
    const rootIdRaw = urlObj.searchParams.get('rootId');
    const selfIdRaw = urlObj.searchParams.get('selfId');
    const rootId = typeof rootIdRaw === 'string' ? rootIdRaw.trim() : '';
    if (rootId === '') {
      respondJson(res, 400, { success: false, error: 'rootId is required' });
      return true;
    }
    const selfId = (() => {
      const raw = typeof selfIdRaw === 'string' ? selfIdRaw.trim() : '';
      return raw === '' ? rootId : raw;
    })();

    const dialogId = new DialogID(selfId, rootId);
    const candidates: DialogStatusKind[] = ['running', 'completed', 'archived'];
    for (const status of candidates) {
      const metadata = await DialogPersistence.loadDialogMetadata(dialogId, status);
      if (!metadata) continue;
      respondJson(res, 200, {
        success: true,
        dialog: {
          rootId,
          selfId,
          status,
        },
      });
      return true;
    }

    respondJson(res, 404, { success: false, error: 'Dialog not found in any status' });
    return true;
  } catch (error) {
    log.error('Error resolving dialog status:', error);
    respondJson(res, 500, { success: false, error: 'Failed to resolve dialog status' });
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
  status: DialogStatusKind,
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
      if (!st.isFile()) {
        respondJson(res, 404, { success: false, error: 'Artifact not found' });
        return true;
      }
    } catch (error) {
      if (getErrorCode(error) === 'ENOENT') {
        respondJson(res, 404, { success: false, error: 'Artifact not found' });
        return true;
      }
      throw error;
    }

    const data = await fsPromises.readFile(candAbs);
    res.writeHead(200, {
      'Content-Type': guessContentTypeFromPath(relPath),
      'Cache-Control': 'no-store',
    });
    res.end(data);
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
  // API responses are dynamic and must not be cached.
  // This is critical for multi-tab convergence (e.g. run-control counts) where stale cached GETs
  // can violate the “5s consistency” UX gates.
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
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
