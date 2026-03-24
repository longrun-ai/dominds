import DOMPurify, { type Config as DomPurifyConfig } from 'dompurify';
import MarkdownIt from 'markdown-it';
import './dominds-code-block';
import './dominds-math-block';
import './dominds-mermaid-block';

type MarkdownRenderOptions = Readonly<{
  kind: 'chat' | 'tooltip';
  allowRelativeWorkspaceLinks?: boolean;
  workspaceLinkBaseDir?: string;
}>;
type WorkspaceFileLinkTarget = {
  absolutePath: string;
  line?: number;
  column?: number;
};
type WorkspaceFilePreviewTarget = {
  relativePath: string;
  line?: number;
  column?: number;
};
type MarkdownLinkToken = {
  attrs?: Array<[string, string]> | null;
  attrGet: (name: string) => string | null;
  attrSet: (name: string, value: string) => void;
};
type MarkdownRenderEnv = Readonly<{
  allowRelativeWorkspaceLinks: boolean;
  workspaceLinkBaseDir?: string;
}>;
const WORKSPACE_FILE_PREVIEW_ROUTE = '/f';
const RTWS_PSEUDO_ROUTE_SEGMENTS = ['workspace', 'rtws', '<workspace>', '<rtws>'] as const;
const DOMINDS_RTWS_DATA_ATTR = 'data-dominds-rtws';
const DOMINDS_PREVIEW_PATH_ATTR = 'dominds-preview-path';
const DOMINDS_PREVIEW_HREF_ATTR = 'dominds-preview-href';
const DOMINDS_PREVIEW_STATE_ATTR = 'dominds-preview-state';
const DOMINDS_PREVIEW_STATE_PENDING = 'pending';
const DOMINDS_PREVIEW_STATE_READY = 'ready';
const DOMINDS_PREVIEW_STATE_INVALID = 'invalid';

function slugifyHeadingId(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  const normalized = trimmed
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

  // VSCode/GitHub-style heading slug:
  // - keep unicode letters/digits, whitespace, and hyphens
  // - drop punctuation (including fullwidth punctuation like `（ ）`)
  // - replace each whitespace char with `-` (do not collapse consecutive `-`)
  const cleaned = normalized.replace(/[^\p{Letter}\p{Number}\s-]+/gu, '');
  return cleaned.replace(/\s/g, '-').replace(/^-+|-+$/g, '');
}

function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function parseFenceLanguage(info: string): string {
  const trimmed = info.trim();
  if (trimmed.length < 1) return '';
  const spaceIndex = trimmed.indexOf(' ');
  if (spaceIndex < 0) return trimmed;
  return trimmed.slice(0, spaceIndex);
}

function parseWorkspaceHrefPath(rawHref: string): {
  rawPath: string;
  line?: number;
  column?: number;
} | null {
  const trimmed = rawHref.trim();
  const queryIdx = trimmed.indexOf('?');
  const hashIdx = trimmed.indexOf('#');
  const cutIdxCandidates = [queryIdx, hashIdx].filter((idx) => idx >= 0);
  const endIdx = cutIdxCandidates.length > 0 ? Math.min(...cutIdxCandidates) : trimmed.length;
  const hrefWithoutQueryOrHash = trimmed.slice(0, endIdx).trim();
  if (hrefWithoutQueryOrHash.length < 1) return null;

  const lineColMatch = hrefWithoutQueryOrHash.match(/^(.*):([1-9]\d*)(?::([1-9]\d*))?$/);
  let rawPath = lineColMatch ? lineColMatch[1] : hrefWithoutQueryOrHash;
  if (rawPath.length > 1 && rawPath.endsWith('/')) {
    rawPath = rawPath.replace(/\/+$/g, '');
  }
  if (rawPath.length < 1) return null;

  const lineRaw = lineColMatch?.[2];
  const columnRaw = lineColMatch?.[3];
  const line = typeof lineRaw === 'string' ? Number.parseInt(lineRaw, 10) : undefined;
  const column = typeof columnRaw === 'string' ? Number.parseInt(columnRaw, 10) : undefined;

  return {
    rawPath,
    line: typeof line === 'number' ? line : undefined,
    column: typeof column === 'number' ? column : undefined,
  };
}

function parseWorkspaceFileLinkTarget(rawHref: string): WorkspaceFileLinkTarget | null {
  const parsed = parseWorkspaceHrefPath(rawHref);
  if (parsed === null) return null;
  if (!parsed.rawPath.startsWith('/')) return null;

  let absolutePath = parsed.rawPath;
  try {
    absolutePath = decodeURIComponent(parsed.rawPath);
  } catch {
    absolutePath = parsed.rawPath;
  }
  if (!absolutePath.startsWith('/')) return null;

  return {
    absolutePath,
    line: parsed.line,
    column: parsed.column,
  };
}

function normalizeSlashPath(value: string): string {
  return value.replace(/\\/g, '/');
}

function normalizeRtwsAbsPath(value: string): string {
  const normalized = normalizeSlashPath(value).replace(/\/+/g, '/');
  if (normalized === '/') return normalized;
  return normalized.replace(/\/+$/g, '');
}

function getCurrentRtwsAbsPath(): string | null {
  if (typeof document !== 'undefined') {
    const raw = document.documentElement.getAttribute(DOMINDS_RTWS_DATA_ATTR);
    if (typeof raw === 'string') {
      const trimmed = raw.trim();
      if (trimmed.length > 0 && trimmed.startsWith('/')) {
        return normalizeRtwsAbsPath(trimmed);
      }
    }
  }
  if (typeof window === 'undefined') return null;
  try {
    const cached = window.localStorage.getItem('dominds.rtws');
    if (typeof cached !== 'string') return null;
    const trimmed = cached.trim();
    if (trimmed.length < 1 || !trimmed.startsWith('/')) return null;
    return normalizeRtwsAbsPath(trimmed);
  } catch {
    return null;
  }
}

function toRtwsRelativePath(absolutePath: string, rtwsAbsPath: string): string | null {
  const normalizedAbs = normalizeRtwsAbsPath(absolutePath);
  const normalizedRtws = normalizeRtwsAbsPath(rtwsAbsPath);
  if (normalizedAbs === normalizedRtws) return '';

  const prefix = normalizedRtws === '/' ? '/' : `${normalizedRtws}/`;
  if (!normalizedAbs.startsWith(prefix)) return null;
  const relativePath = normalizedAbs.slice(prefix.length);
  if (relativePath.includes('\0')) return null;
  if (relativePath.length < 1) return '';

  const segments = relativePath.split('/');
  if (segments.some((segment) => segment.length < 1 || segment === '.' || segment === '..')) {
    return null;
  }
  return relativePath;
}

function resolveWorkspaceFilePreviewTarget(
  linkTarget: WorkspaceFileLinkTarget,
): WorkspaceFilePreviewTarget | null {
  const rtwsAbsPath = getCurrentRtwsAbsPath();
  if (rtwsAbsPath === null) return null;
  const relativePath = toRtwsRelativePath(linkTarget.absolutePath, rtwsAbsPath);
  if (relativePath === null) return null;
  return {
    relativePath,
    line: linkTarget.line,
    column: linkTarget.column,
  };
}

function getAuthFromCurrentUrl(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const url = new URL(window.location.href);
    const auth = url.searchParams.get('auth');
    if (typeof auth !== 'string') return null;
    const trimmed = auth.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

function normalizeRtwsRelativePath(
  rawPath: string,
  options: Readonly<{ allowRoot: boolean }>,
): string | null {
  if (rawPath.includes('\0')) return null;
  if (rawPath.includes('\\')) return null;
  if (rawPath.startsWith('/')) return null;

  const normalized: string[] = [];
  for (const part of rawPath.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (normalized.length < 1) return null;
      normalized.pop();
      continue;
    }
    normalized.push(part);
  }

  const out = normalized.join('/');
  if (out.length < 1) {
    return options.allowRoot ? '' : null;
  }
  return out;
}

function normalizeWorkspacePseudoRelativePath(rawPath: string): string | null {
  const normalized = normalizeSlashPath(rawPath).replace(/\/+/g, '/').trim();
  for (const prefix of RTWS_PSEUDO_ROUTE_SEGMENTS) {
    let tail: string | null = null;
    if (normalized === prefix || normalized === `/${prefix}`) {
      tail = '';
    } else if (normalized.startsWith(`/${prefix}/`)) {
      tail = normalized.slice(prefix.length + 2);
    } else if (normalized.startsWith(`${prefix}/`)) {
      tail = normalized.slice(prefix.length + 1);
    }
    if (tail !== null) {
      return normalizeRtwsRelativePath(tail, { allowRoot: true });
    }
  }
  return null;
}

function decodeHrefPath(rawPath: string): string {
  try {
    return decodeURIComponent(rawPath);
  } catch {
    return rawPath;
  }
}

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '[::1]'
  );
}

function canRewriteSameRtwsHttpUrl(url: URL): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const current = new URL(window.location.href);
    if (url.origin === current.origin) return true;
    return (
      url.protocol === current.protocol &&
      url.port === current.port &&
      isLoopbackHost(url.hostname) &&
      isLoopbackHost(current.hostname)
    );
  } catch {
    return false;
  }
}

function extractWorkspacePseudoHrefCandidate(rawHref: string): string | null {
  const trimmed = rawHref.trim();
  if (trimmed.length < 1) return null;
  if (!/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed)) return trimmed;

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(trimmed);
  } catch {
    return null;
  }

  if (!/^https?:$/i.test(parsedUrl.protocol)) return null;
  if (!canRewriteSameRtwsHttpUrl(parsedUrl)) return null;
  return decodeHrefPath(parsedUrl.pathname);
}

function parseWorkspacePseudoLinkTarget(rawHref: string): WorkspaceFilePreviewTarget | null {
  const hrefCandidate = extractWorkspacePseudoHrefCandidate(rawHref);
  if (hrefCandidate === null) return null;
  const parsed = parseWorkspaceHrefPath(hrefCandidate);
  if (parsed === null) return null;
  const relativePath = normalizeWorkspacePseudoRelativePath(parsed.rawPath);
  if (relativePath === null) return null;
  return {
    relativePath,
    line: parsed.line,
    column: parsed.column,
  };
}

function deleteTokenAttr(token: MarkdownLinkToken, name: string): void {
  if (!Array.isArray(token.attrs)) return;
  token.attrs = token.attrs.filter(([attrName]) => attrName !== name);
}

function resolveRelativeWorkspaceFilePreviewTarget(
  rawHref: string,
  env: MarkdownRenderEnv,
): WorkspaceFilePreviewTarget | null {
  if (!env.allowRelativeWorkspaceLinks) return null;
  const trimmed = rawHref.trim();
  if (trimmed.length < 1) return null;
  if (trimmed.startsWith('#')) return null;
  if (trimmed.startsWith('//')) return null;
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed)) return null;

  const parsed = parseWorkspaceHrefPath(trimmed);
  if (parsed === null) return null;
  if (parsed.rawPath.startsWith('/')) return null;

  const baseDir =
    typeof env.workspaceLinkBaseDir === 'string'
      ? normalizeRtwsRelativePath(env.workspaceLinkBaseDir, { allowRoot: true })
      : '';
  if (baseDir === null) return null;

  const combinedPath = baseDir.length > 0 ? `${baseDir}/${parsed.rawPath}` : parsed.rawPath;
  const relativePath = normalizeRtwsRelativePath(combinedPath, { allowRoot: true });
  if (relativePath === null) return null;

  return {
    relativePath,
    line: parsed.line,
    column: parsed.column,
  };
}

function buildWorkspaceFilePreviewHref(target: WorkspaceFilePreviewTarget): string {
  const routePath =
    target.relativePath.length < 1
      ? WORKSPACE_FILE_PREVIEW_ROUTE
      : `${WORKSPACE_FILE_PREVIEW_ROUTE}/${target.relativePath
          .split('/')
          .map((segment) => encodeURIComponent(segment))
          .join('/')}`;
  const params = new URLSearchParams();
  if (typeof target.line === 'number') {
    params.set('line', String(target.line));
  }
  if (typeof target.column === 'number') {
    params.set('column', String(target.column));
  }
  const auth = getAuthFromCurrentUrl();
  if (auth !== null) {
    params.set('auth', auth);
  }
  const query = params.toString();
  if (query.length < 1) return routePath;
  return `${routePath}?${query}`;
}

function applyOpenInNewTabAttrs(token: MarkdownLinkToken): void {
  token.attrSet('target', '_blank');
  const relValue = token.attrGet('rel');
  const relTokens = new Set(
    typeof relValue === 'string'
      ? relValue
          .split(/\s+/)
          .map((part) => part.trim())
          .filter((part) => part.length > 0)
      : [],
  );
  relTokens.add('noopener');
  relTokens.add('noreferrer');
  token.attrSet('rel', Array.from(relTokens).join(' '));
}

function installDomindsMathBlockRule(md: MarkdownIt): void {
  md.block.ruler.before(
    'fence',
    'dominds_math_block',
    (state, startLine, endLine, silent): boolean => {
      const startPos = state.bMarks[startLine] + state.tShift[startLine];
      const maxPos = state.eMarks[startLine];
      const firstLine = state.src.slice(startPos, maxPos).trim();

      // Deliberately strict: only treat blocks wrapped by lines containing exactly `$$` as math.
      // This avoids accidental `$...$` in normal text (e.g. 中文/货币) being interpreted as math.
      if (firstLine !== '$$') return false;

      let nextLine = startLine + 1;
      while (nextLine < endLine) {
        const nextStart = state.bMarks[nextLine] + state.tShift[nextLine];
        const nextMax = state.eMarks[nextLine];
        const line = state.src.slice(nextStart, nextMax).trim();
        if (line === '$$') break;
        nextLine += 1;
      }

      if (nextLine >= endLine) return false;
      if (silent) return true;

      const contentStart = state.bMarks[startLine + 1];
      const contentEnd = state.bMarks[nextLine];
      const tex = state.src.slice(contentStart, contentEnd);

      const token = state.push('dominds_math_block', 'dominds-math-block', 0);
      token.block = true;
      token.content = tex.trimEnd();
      token.map = [startLine, nextLine + 1];
      token.attrSet('display', 'block');

      state.line = nextLine + 1;
      return true;
    },
  );

  md.renderer.rules.dominds_math_block = (tokens, idx): string => {
    const token = tokens[idx];
    const raw = typeof token.content === 'string' ? token.content : '';
    const display = token.attrGet('display') || 'block';
    return `<dominds-math-block display="${escapeHtmlText(display)}">${escapeHtmlText(raw)}</dominds-math-block>`;
  };
}

const allowedCustomElements = new Set<string>([
  'dominds-code-block',
  'dominds-mermaid-block',
  'dominds-math-block',
]);

const allowedCustomElementAttrs = new Set<string>(['language', 'display']);

const domPurifyConfig: DomPurifyConfig = {
  RETURN_TRUSTED_TYPE: false,
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: true,
  CUSTOM_ELEMENT_HANDLING: {
    tagNameCheck: (tagName: string) => allowedCustomElements.has(tagName),
    attributeNameCheck: (attributeName: string, tagName?: string) => {
      if (typeof tagName !== 'string') return false;
      if (!allowedCustomElements.has(tagName)) return false;
      return allowedCustomElementAttrs.has(attributeName);
    },
    allowCustomizedBuiltInElements: false,
  },
  ADD_TAGS: [...allowedCustomElements],
  ADD_ATTR: [
    ...allowedCustomElementAttrs,
    'id',
    'target',
    'rel',
    DOMINDS_PREVIEW_PATH_ATTR,
    DOMINDS_PREVIEW_HREF_ATTR,
    DOMINDS_PREVIEW_STATE_ATTR,
  ],
};

const md = new MarkdownIt({
  html: false,
  breaks: true,
  linkify: true,
});

// Only autolink explicit schemes (http/https/mailto/etc).
// Avoid fuzzy host detection like `tools.md` -> `http://tools.md/`.
md.linkify.set({
  fuzzyLink: false,
  fuzzyIP: false,
  fuzzyEmail: false,
});

md.core.ruler.push('dominds_heading_ids', (state) => {
  const used = new Set<string>();
  for (let i = 0; i < state.tokens.length; i += 1) {
    const token = state.tokens[i];
    if (!token) continue;
    if (token.type !== 'heading_open') continue;
    const inline = state.tokens[i + 1];
    if (!inline || inline.type !== 'inline') continue;

    const rawText = inline.content;
    const base = slugifyHeadingId(rawText);
    if (!base) continue;
    let id = base;
    let attempt = 2;
    while (used.has(id)) {
      id = `${base}-${attempt}`;
      attempt += 1;
    }
    used.add(id);
    token.attrSet('id', id);
  }
});

installDomindsMathBlockRule(md);

function getMarkdownRenderEnv(env: unknown): MarkdownRenderEnv {
  if (typeof env !== 'object' || env === null) {
    return { allowRelativeWorkspaceLinks: false };
  }
  const candidate = env as {
    allowRelativeWorkspaceLinks?: unknown;
    workspaceLinkBaseDir?: unknown;
  };
  return {
    allowRelativeWorkspaceLinks: candidate.allowRelativeWorkspaceLinks === true,
    workspaceLinkBaseDir:
      typeof candidate.workspaceLinkBaseDir === 'string'
        ? candidate.workspaceLinkBaseDir
        : undefined,
  };
}

md.renderer.rules.link_open = (tokens, idx, options, _env, self): string => {
  const token = tokens[idx];
  const href = token.attrGet('href');
  const env = getMarkdownRenderEnv(_env);
  if (typeof href === 'string') {
    const workspacePseudoLink = parseWorkspacePseudoLinkTarget(href);
    const workspaceFileLink = parseWorkspaceFileLinkTarget(href);
    const previewTarget =
      workspacePseudoLink ??
      (workspaceFileLink !== null
        ? resolveWorkspaceFilePreviewTarget(workspaceFileLink)
        : resolveRelativeWorkspaceFilePreviewTarget(href, env));
    if (previewTarget) {
      token.attrSet(DOMINDS_PREVIEW_PATH_ATTR, previewTarget.relativePath);
      token.attrSet(DOMINDS_PREVIEW_HREF_ATTR, buildWorkspaceFilePreviewHref(previewTarget));
      token.attrSet(DOMINDS_PREVIEW_STATE_ATTR, DOMINDS_PREVIEW_STATE_PENDING);
      deleteTokenAttr(token, 'href');
      applyOpenInNewTabAttrs(token);
      return self.renderToken(tokens, idx, options);
    }
    applyOpenInNewTabAttrs(token);
  }
  return self.renderToken(tokens, idx, options);
};

md.renderer.rules.fence = (tokens, idx): string => {
  const token = tokens[idx];
  const language = parseFenceLanguage(token.info || '');
  const code = typeof token.content === 'string' ? token.content : '';

  if (language === 'mermaid') {
    return `<dominds-mermaid-block>${escapeHtmlText(code)}</dominds-mermaid-block>`;
  }

  const attrLanguage = language.length > 0 ? language : 'plaintext';
  return `<dominds-code-block language="${escapeHtmlText(attrLanguage)}">${escapeHtmlText(code)}</dominds-code-block>`;
};

export function renderDomindsMarkdown(
  input: string,
  opts: MarkdownRenderOptions = { kind: 'chat' },
): string {
  try {
    const rendered = md.render(input, {
      allowRelativeWorkspaceLinks: opts.allowRelativeWorkspaceLinks === true,
      workspaceLinkBaseDir: opts.workspaceLinkBaseDir,
    } satisfies MarkdownRenderEnv);
    return DOMPurify.sanitize(rendered, domPurifyConfig);
  } catch (error) {
    console.error('Markdown rendering error:', error);
    return escapeHtmlText(input);
  }
}

function getAuthTokenForWorkspaceLinkCheck(): string | null {
  const authFromUrl = getAuthFromCurrentUrl();
  if (authFromUrl !== null) return authFromUrl;
  if (typeof window === 'undefined') return null;
  try {
    const authFromStorage = window.localStorage.getItem('dominds.authKey');
    if (typeof authFromStorage !== 'string') return null;
    const trimmed = authFromStorage.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

async function resolveWorkspaceEntryBatch(
  relativePaths: readonly string[],
): Promise<Map<string, boolean>> {
  const uniquePaths = Array.from(
    new Set(relativePaths.map((path) => path.trim()).filter((path) => path.length > 0)),
  );
  const resultMap = new Map<string, boolean>();
  if (uniquePaths.length < 1) return resultMap;

  const headers: Record<string, string> = { Accept: 'application/json' };
  const authToken = getAuthTokenForWorkspaceLinkCheck();
  if (authToken !== null) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }

  try {
    const response = await fetch('/api/markdown-links/resolve', {
      method: 'POST',
      headers,
      body: JSON.stringify({ paths: uniquePaths }),
      cache: 'no-store',
    });
    if (!response.ok) return resultMap;

    const payload: unknown = await response.json();
    if (typeof payload !== 'object' || payload === null) return resultMap;
    const rawResults = (payload as { results?: unknown }).results;
    if (!Array.isArray(rawResults)) return resultMap;

    for (const entry of rawResults) {
      if (typeof entry !== 'object' || entry === null) continue;
      const path = (entry as { path?: unknown }).path;
      const exists = (entry as { exists?: unknown }).exists;
      if (typeof path !== 'string' || typeof exists !== 'boolean') continue;
      resultMap.set(path, exists);
    }
    return resultMap;
  } catch {
    return resultMap;
  }
}

function unwrapAnchor(anchor: HTMLAnchorElement): void {
  const parent = anchor.parentNode;
  if (parent === null) return;
  const fragment = document.createDocumentFragment();
  while (anchor.firstChild) {
    fragment.appendChild(anchor.firstChild);
  }
  parent.replaceChild(fragment, anchor);
}

export function postprocessRenderedDomindsMarkdown(root: ParentNode): void {
  if (typeof window === 'undefined') return;
  if (!('querySelectorAll' in root)) return;

  const anchors = root.querySelectorAll('a');
  const previewAnchorsByPath = new Map<
    string,
    Array<{ anchor: HTMLAnchorElement; previewHref: string }>
  >();
  for (const anchorNode of anchors) {
    if (!(anchorNode instanceof HTMLAnchorElement)) continue;
    anchorNode.setAttribute('target', '_blank');
    const relTokens = new Set(
      (anchorNode.getAttribute('rel') ?? '')
        .split(/\s+/)
        .map((part) => part.trim())
        .filter((part) => part.length > 0),
    );
    relTokens.add('noopener');
    relTokens.add('noreferrer');
    anchorNode.setAttribute('rel', Array.from(relTokens).join(' '));

    const previewPath = anchorNode.getAttribute(DOMINDS_PREVIEW_PATH_ATTR);
    const previewHref = anchorNode.getAttribute(DOMINDS_PREVIEW_HREF_ATTR);
    const previewState = anchorNode.getAttribute(DOMINDS_PREVIEW_STATE_ATTR);
    if (typeof previewPath !== 'string' || typeof previewHref !== 'string') continue;
    if (
      previewState === DOMINDS_PREVIEW_STATE_READY ||
      previewState === DOMINDS_PREVIEW_STATE_INVALID
    ) {
      continue;
    }

    anchorNode.setAttribute(DOMINDS_PREVIEW_STATE_ATTR, DOMINDS_PREVIEW_STATE_PENDING);
    const bucket = previewAnchorsByPath.get(previewPath) ?? [];
    bucket.push({ anchor: anchorNode, previewHref });
    previewAnchorsByPath.set(previewPath, bucket);
  }

  if (previewAnchorsByPath.size < 1) return;

  void resolveWorkspaceEntryBatch(Array.from(previewAnchorsByPath.keys())).then((results) => {
    for (const [previewPath, anchorsForPath] of previewAnchorsByPath.entries()) {
      const exists = results.get(previewPath) === true;
      for (const item of anchorsForPath) {
        if (!item.anchor.isConnected) continue;
        if (exists) {
          item.anchor.setAttribute('href', item.previewHref);
          item.anchor.setAttribute(DOMINDS_PREVIEW_STATE_ATTR, DOMINDS_PREVIEW_STATE_READY);
          continue;
        }
        item.anchor.setAttribute(DOMINDS_PREVIEW_STATE_ATTR, DOMINDS_PREVIEW_STATE_INVALID);
        unwrapAnchor(item.anchor);
      }
    }
  });
}
