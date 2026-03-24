import YAML from 'yaml';

export type MarkdownFrontmatterParseResult = Readonly<{
  body: string;
  frontmatter: Record<string, unknown>;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function stripOptionalBom(text: string): string {
  if (text.charCodeAt(0) === 0xfeff) {
    return text.slice(1);
  }
  return text;
}

export function normalizeMarkdownText(text: string): string {
  return stripOptionalBom(text).replace(/\r\n/g, '\n');
}

export function parseMarkdownFrontmatter(
  raw: string,
  sourceLabel = 'markdown',
): MarkdownFrontmatterParseResult {
  const normalized = normalizeMarkdownText(raw);
  if (!normalized.startsWith('---\n')) {
    return { body: normalized, frontmatter: {} };
  }

  const endWithBody = normalized.indexOf('\n---\n', 4);
  const endAtEof = normalized.endsWith('\n---') ? normalized.length - '\n---'.length : -1;
  const end = endWithBody >= 0 ? endWithBody : endAtEof;
  if (end < 0) {
    return { body: normalized, frontmatter: {} };
  }

  const frontmatterText = normalized.slice(4, end);
  const body =
    endWithBody >= 0
      ? normalized.slice(end + '\n---\n'.length)
      : normalized.slice(end + '\n---'.length);
  try {
    const parsed = YAML.parse(frontmatterText);
    return { body, frontmatter: isRecord(parsed) ? parsed : {} };
  } catch (error: unknown) {
    throw new Error(
      `Invalid ${sourceLabel} frontmatter: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
