import { createLogger } from '../log';

const log = createLogger('mcp/tool-names');

export const TOOL_NAME_VALIDITY_RULE = '^[a-zA-Z0-9_-]{1,64}$';
const TOOL_NAME_VALIDITY_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export function isValidProviderToolName(name: string): boolean {
  return TOOL_NAME_VALIDITY_RE.test(name);
}

export type ToolNameTransform =
  | { kind: 'prefix_add'; add: string }
  | { kind: 'prefix_replace'; remove: string; add: string }
  | { kind: 'suffix_add'; add: string };

export function applyToolNameTransforms(
  originalMcpToolName: string,
  transforms: readonly ToolNameTransform[],
): string {
  let out = originalMcpToolName;
  for (const t of transforms) {
    switch (t.kind) {
      case 'prefix_add':
        out = `${t.add}${out}`;
        break;
      case 'prefix_replace':
        out = `${t.add}${out.startsWith(t.remove) ? out.slice(t.remove.length) : out}`;
        break;
      case 'suffix_add':
        out = `${out}${t.add}`;
        break;
      default: {
        const _exhaustive: never = t;
        log.warn('Unknown transform kind (exhaustiveness failure)', undefined, _exhaustive);
        break;
      }
    }
  }
  return out;
}

export type ToolFilterDecision =
  | { kind: 'accepted' }
  | { kind: 'blacklisted'; pattern: string }
  | { kind: 'not_whitelisted'; pattern: string };

export type ToolFilterConfig = {
  whitelist: readonly string[];
  blacklist: readonly string[];
};

export function decideToolExposure(
  toolName: string,
  filters: ToolFilterConfig,
): ToolFilterDecision {
  const whitelist = filters.whitelist;
  const blacklist = filters.blacklist;
  const hasWhitelist = whitelist.length > 0;
  const hasBlacklist = blacklist.length > 0;

  if (!hasBlacklist) {
    if (!hasWhitelist) {
      return { kind: 'accepted' };
    }
    const matched = matchAnyPattern(toolName, whitelist);
    return matched
      ? { kind: 'accepted' }
      : { kind: 'not_whitelisted', pattern: whitelist.join(', ') || '*' };
  }

  // Whitelist + blacklist mode:
  // - blacklist excludes, unless whitelisted (whitelist overrides blacklist)
  // - neither-listed => accepted
  const matchedWhitelist = matchAnyPattern(toolName, whitelist);
  if (matchedWhitelist) {
    return { kind: 'accepted' };
  }
  const matchedBlacklist = matchAnyPattern(toolName, blacklist);
  if (matchedBlacklist) {
    return { kind: 'blacklisted', pattern: matchedPatternName(blacklist, toolName) };
  }
  return { kind: 'accepted' };
}

function matchAnyPattern(name: string, patterns: readonly string[]): boolean {
  for (const p of patterns) {
    if (matchesWildcardPattern(name, p)) return true;
  }
  return false;
}

function matchedPatternName(patterns: readonly string[], name: string): string {
  for (const p of patterns) {
    if (matchesWildcardPattern(name, p)) return p;
  }
  // Should not happen when called correctly; return a best-effort string.
  return patterns[0] ?? '*';
}

export function matchesWildcardPattern(name: string, pattern: string): boolean {
  // Only supports '*' wildcard matching (match any substring).
  // This intentionally avoids regex special-casing and keeps config predictable.
  if (pattern === '*') return true;
  if (!pattern.includes('*')) return name === pattern;
  const parts = pattern.split('*');
  let idx = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part) continue;
    const found = name.indexOf(part, idx);
    if (found < 0) return false;
    idx = found + part.length;
  }
  if (!pattern.startsWith('*')) {
    const first = parts.find((p) => p.length > 0);
    if (first && !name.startsWith(first)) return false;
  }
  if (!pattern.endsWith('*')) {
    const reversed = [...parts].reverse();
    const last = reversed.find((p) => p.length > 0);
    if (last && !name.endsWith(last)) return false;
  }
  return true;
}
