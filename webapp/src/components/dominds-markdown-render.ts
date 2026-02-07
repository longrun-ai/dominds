import DOMPurify, { type Config as DomPurifyConfig } from 'dompurify';
import MarkdownIt from 'markdown-it';
import './dominds-code-block';
import './dominds-math-block';
import './dominds-mermaid-block';

type MarkdownRenderKind = { kind: 'chat' } | { kind: 'tooltip' };

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
  ADD_ATTR: [...allowedCustomElementAttrs, 'id', 'target', 'rel'],
};

const md = new MarkdownIt({
  html: false,
  breaks: true,
  linkify: true,
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

md.renderer.rules.link_open = (tokens, idx, options, _env, self): string => {
  const token = tokens[idx];
  const href = token.attrGet('href');
  if (typeof href === 'string' && /^https?:\/\//i.test(href.trim())) {
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
  _opts: MarkdownRenderKind = { kind: 'chat' },
): string {
  try {
    const rendered = md.render(input);
    return DOMPurify.sanitize(rendered, domPurifyConfig);
  } catch (error) {
    console.error('Markdown rendering error:', error);
    return escapeHtmlText(input);
  }
}
