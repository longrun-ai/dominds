/**
 * Module: access-control
 *
 * Directory-based access control helpers:
 * - `matchesPattern` for glob-like directory scope matching (supports `*` and `**`)
 * - `hasReadAccess`/`hasWriteAccess` to evaluate member permissions
 * - `getAccessDeniedMessage` to format denial responses
 */
import path from 'path';
import { log } from './log';
import type { LanguageCode } from './shared/types/language';
import { Team } from './team';

function isEncapsulatedTaskPath(targetPath: string): boolean {
  const normalized = targetPath.replace(/\\/g, '/');
  // Matches: "foo.tsk", "foo.tsk/", "a/b/foo.tsk/x", etc.
  return /(^|\/)[^/]+\.tsk(\/|$)/.test(normalized);
}

function isMindsPath(targetPath: string): boolean {
  const normalized = targetPath.replace(/\\/g, '/').replace(/^\/+/, '');
  return normalized === '.minds' || normalized.startsWith('.minds/');
}

function isRootDialogsPath(targetPath: string): boolean {
  // Only deny `.dialogs/**` at rtws root; allow nested `foo/.dialogs/**` for dev rtws layouts.
  const normalized = targetPath.replace(/\\/g, '/').replace(/^\/+/, '');
  return normalized === '.dialogs' || normalized.startsWith('.dialogs/');
}

/**
 * Directory-specific pattern matching for access control.
 * This function determines if a target path (file or directory) should be controlled
 * by a directory pattern. The pattern represents a directory scope.
 *
 * Supports:
 * - "*" matches any single directory/file name within a path segment
 * - "**" matches any number of directory levels (including zero)
 * - Exact directory matches
 *
 * Directory semantics:
 * - Pattern "src" matches "src/file.txt", "src/subdir/file.js", etc.
 * - Pattern "src" does NOT match "src-backup/file.txt" (prevents false positives)
 * - Pattern "src/tools" matches "src/tools/fs.ts" but not "src/other/file.ts"
 */
export function matchesPattern(targetPath: string, dirPattern: string): boolean {
  // Normalize paths - remove leading/trailing slashes, convert to forward slashes, handle empty paths
  const normalizedTarget = targetPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') || '.';
  let normalizedDirPattern = dirPattern.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') || '.';

  // Patterns ending in `/**` represent a directory scope and should match the directory itself too.
  // Example: `.minds/**` must match both `.minds` and `.minds/team.yaml`.
  while (normalizedDirPattern.endsWith('/**')) {
    normalizedDirPattern = normalizedDirPattern.slice(0, -3) || '.';
  }

  // Handle root directory pattern
  if (normalizedDirPattern === '.' || normalizedDirPattern === '') {
    return true; // Root pattern matches everything
  }

  // Handle exact match (target is exactly the directory or a file with same name as directory)
  if (normalizedDirPattern === normalizedTarget) {
    return true;
  }

  // Handle wildcard patterns
  if (normalizedDirPattern.includes('*')) {
    // For patterns like **/*secret*, check if any path segment contains "secret"
    const patternParts = normalizedDirPattern.split('/');
    const targetParts = normalizedTarget.split('/');

    // Special handling for **/* patterns - check if any target segment matches the final pattern
    if (normalizedDirPattern.includes('**/*') && patternParts.length >= 2) {
      const lastPatternPart = patternParts[patternParts.length - 1];
      if (lastPatternPart.includes('*')) {
        // Convert the last part to regex (e.g., *secret* -> .*secret.*)
        let segmentRegex = lastPatternPart
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*/g, '.*');
        segmentRegex = '^' + segmentRegex + '$';

        try {
          const regex = new RegExp(segmentRegex);
          // Check if any target segment matches
          for (const segment of targetParts) {
            if (regex.test(segment)) {
              return true;
            }
          }
        } catch (err) {
          log.warn(`Invalid regex pattern in segment matching: ${segmentRegex}`, err);
          // Invalid regex, fall through to other matching
        }
      }
    }

    // Full path regex matching for complex patterns
    let regexPattern = normalizedDirPattern
      // Escape special regex characters except * and **
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      // Handle ** first (matches any number of path segments including none)
      .replace(/\*\*/g, '___DOUBLESTAR___')
      // Handle single * (matches any characters within a single path segment, but not path separators)
      .replace(/\*/g, '[^/]*')
      // Replace ** placeholder with pattern that matches any path segments
      .replace(/___DOUBLESTAR___/g, '.*');

    // For directory semantics, the pattern should match:
    // 1. Exact path match
    // 2. Path that starts with pattern followed by a path separator
    regexPattern = '^' + regexPattern + '(?:/.*)?$';

    try {
      const regex = new RegExp(regexPattern);
      return regex.test(normalizedTarget);
    } catch (err) {
      log.warn(`Invalid regex pattern in path matching: ${regexPattern}`, err);
      // If regex is invalid, fall back to exact match
      return normalizedDirPattern === normalizedTarget;
    }
  }

  // For non-wildcard directory patterns, use proper directory semantics
  // Pattern should match if target is:
  // 1. Exactly the directory path
  // 2. A path that starts with the directory path followed by a path separator

  // Ensure we don't match partial directory names (e.g., "src" shouldn't match "src-backup")
  // by requiring either exact match or match followed by path separator
  const targetParts = normalizedTarget.split('/');
  const patternParts = normalizedDirPattern.split('/');

  // Pattern must be a prefix of target path segments
  if (patternParts.length > targetParts.length) {
    return false; // Pattern is deeper than target
  }

  // Check each pattern segment against corresponding target segment
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i] !== targetParts[i]) {
      return false;
    }
  }

  return true; // All pattern segments matched
}

/**
 * Check if a member has read access to a specific path.
 *
 * Access control logic:
 * 1. Check blacklist first (no_read_dirs) - if path matches any blacklist pattern, deny access
 * 2. Check whitelist (read_dirs) - if path matches any whitelist pattern, allow access
 * 3. If no whitelist patterns are defined, allow access (default allow)
 * 4. If whitelist patterns exist but none match, deny access
 */
export function hasReadAccess(member: Team.Member, targetPath: string): boolean {
  // Get resolved relative path from rtws root
  const cwd = path.resolve(process.cwd());
  const resolvedPath = path.resolve(cwd, targetPath);

  // Ensure path is within rtws
  if (!resolvedPath.startsWith(cwd)) {
    return false;
  }

  // Get relative path from rtws root
  const relativePath = path.relative(cwd, resolvedPath);

  // Taskdocs (`*.tsk/`) are encapsulated and hard-denied for all general file tools.
  if (isEncapsulatedTaskPath(relativePath)) {
    return false;
  }

  // Root dialogs (`.dialogs/**`) are reserved runtime state.
  // Hard-denied for all general file tools at rtws root (but allowed under nested workspaces).
  if (isRootDialogsPath(relativePath)) {
    return false;
  }

  // Minds (`.minds/**`) is reserved rtws state.
  // It is hard-denied for general file tools; only dedicated `.minds/`-scoped tools (team-mgmt)
  // may bypass this via an internal-only flag.
  const isMinds = isMindsPath(relativePath);
  const allowMindsBypass = member.internal_allow_minds === true;
  if (isMinds && !allowMindsBypass) {
    return false;
  }

  // Check blacklist first (no_read_dirs)
  const blacklist = member.no_read_dirs || [];
  for (const pattern of blacklist) {
    if (matchesPattern(relativePath, pattern)) {
      return false; // Explicitly denied
    }
  }

  // Check whitelist (read_dirs)
  const whitelist = member.read_dirs || [];

  // Note: `.minds/**` is handled above as a hard deny (unless internal bypass is enabled).

  // If no whitelist is defined, allow access (after blacklist check)
  if (whitelist.length === 0) {
    return true;
  }

  // Check if path matches any whitelist pattern
  for (const pattern of whitelist) {
    if (matchesPattern(relativePath, pattern)) {
      return true; // Explicitly allowed
    }
  }

  // Path doesn't match any whitelist pattern
  return false;
}

/**
 * Check if a member has write access to a specific path.
 *
 * Access control logic:
 * 1. Check blacklist first (no_write_dirs) - if path matches any blacklist pattern, deny access
 * 2. Check whitelist (write_dirs) - if path matches any whitelist pattern, allow access
 * 3. If no whitelist patterns are defined, allow access (default allow)
 * 4. If whitelist patterns exist but none match, deny access
 */
export function hasWriteAccess(member: Team.Member, targetPath: string): boolean {
  // Get resolved relative path from rtws root
  const cwd = path.resolve(process.cwd());
  const resolvedPath = path.resolve(cwd, targetPath);

  // Ensure path is within rtws
  if (!resolvedPath.startsWith(cwd)) {
    return false;
  }

  // Get relative path from rtws root
  const relativePath = path.relative(cwd, resolvedPath);

  // Taskdocs (`*.tsk/`) are encapsulated and hard-denied for all general file tools.
  if (isEncapsulatedTaskPath(relativePath)) {
    return false;
  }

  // Root dialogs (`.dialogs/**`) are reserved runtime state.
  // Hard-denied for all general file tools at rtws root (but allowed under nested workspaces).
  if (isRootDialogsPath(relativePath)) {
    return false;
  }

  // Minds (`.minds/**`) is reserved rtws state.
  // It is hard-denied for general file tools; only dedicated `.minds/`-scoped tools (team-mgmt)
  // may bypass this via an internal-only flag.
  const isMinds = isMindsPath(relativePath);
  const allowMindsBypass = member.internal_allow_minds === true;
  if (isMinds && !allowMindsBypass) {
    return false;
  }

  // Check blacklist first (no_write_dirs)
  const blacklist = member.no_write_dirs || [];
  for (const pattern of blacklist) {
    if (matchesPattern(relativePath, pattern)) {
      return false; // Explicitly denied
    }
  }

  // Check whitelist (write_dirs)
  const whitelist = member.write_dirs || [];

  // Note: `.minds/**` is handled above as a hard deny (unless internal bypass is enabled).

  // If no whitelist is defined, allow access (after blacklist check)
  if (whitelist.length === 0) {
    return true;
  }

  // Check if path matches any whitelist pattern
  for (const pattern of whitelist) {
    if (matchesPattern(relativePath, pattern)) {
      return true; // Explicitly allowed
    }
  }

  // Path doesn't match any whitelist pattern
  return false;
}

/**
 * Get an access denied error message for a specific operation and path.
 */
export function getAccessDeniedMessage(
  operation: 'read' | 'write',
  targetPath: string,
  language: LanguageCode = 'en',
): string {
  const lines =
    language === 'zh'
      ? [
          '❌ **访问被拒绝**',
          '',
          `- 操作：\`${operation}\``,
          `- 路径：\`${targetPath}\``,
          `- 代码：\`ACCESS_DENIED\``,
        ]
      : [
          '❌ **Access Denied**',
          '',
          `- Operation: \`${operation}\``,
          `- Path: \`${targetPath}\``,
          `- Code: \`ACCESS_DENIED\``,
        ];

  if (isEncapsulatedTaskPath(targetPath)) {
    lines.push('');
    if (language === 'zh') {
      lines.push(
        `- 说明：\`*.tsk/\` 是封装差遣牒。通用文件工具无法读/写/列目录/删除其中内容（硬编码无条件拒绝）。`,
      );
      lines.push(
        `- 提示：写入/更新请使用函数工具 \`change_mind\`（顶层：\`change_mind({\"selector\":\"goals|constraints|progress\",\"content\":\"...\"})\`；额外章节：\`change_mind({\"category\":\"<category>\",\"selector\":\"<selector>\",\"content\":\"...\"})\`）。`,
      );
      lines.push(
        `- 提示：读取额外章节请使用函数工具 \`recall_taskdoc\`：\`recall_taskdoc({\"category\":\"<category>\",\"selector\":\"<selector>\"})\`。`,
      );
    } else {
      lines.push(
        `- Note: \`*.tsk/\` is an encapsulated Taskdoc. It is hard-denied for all general file tools.`,
      );
      lines.push(
        `- Hint: For updates, use the function tool \`change_mind\` (top-level: \`change_mind({\"selector\":\"goals|constraints|progress\",\"content\":\"...\"})\`; extra sections: \`change_mind({\"category\":\"<category>\",\"selector\":\"<selector>\",\"content\":\"...\"})\`).`,
      );
      lines.push(
        `- Hint: To read extra sections, use \`recall_taskdoc({\"category\":\"<category>\",\"selector\":\"<selector>\"})\`.`,
      );
    }
  }

  if (isMindsPath(targetPath)) {
    lines.push('');
    if (language === 'zh') {
      lines.push(
        `- 说明：\`.minds/\` 是 rtws（运行时工作区）的“团队配置/记忆/资产”目录，通用文件工具无法读写（硬编码无条件拒绝）。`,
      );
      lines.push(
        `- 提示：若团队配置了 \`team-mgmt\` 工具集，请使用其中工具（\`team_mgmt_*\`）代管；若未配置或你不具备权限，请诉请具备 \`team-mgmt\` 权限的成员/团队管理员成员代管。`,
      );
    } else {
      lines.push(
        `- Note: \`.minds/\` stores rtws (runtime workspace) team config/memory/assets and is hard-denied for general file tools.`,
      );
      lines.push(
        `- Hint: If your team configured the \`team-mgmt\` toolset, use its tools (\`team_mgmt_*\`); otherwise (or if you lack access), tellask a team-admin / a member with \`team-mgmt\` access to manage it for you.`,
      );
    }
  }

  if (isRootDialogsPath(targetPath)) {
    lines.push('');
    if (language === 'zh') {
      lines.push(
        `- 说明：\`.dialogs/\` 是 rtws 根目录下的“对话/运行态持久化”目录，通用文件工具无法读写（硬编码无条件拒绝）。`,
      );
      lines.push(
        `- 提示：如需排查 Dominds 本身的问题，请在子目录 rtws 下复现（例如 \`ux-rtws/.dialogs/\`），该目录不受此硬编码限制。`,
      );
    } else {
      lines.push(
        `- Note: \`.dialogs/\` at the rtws root stores dialog/runtime persistence and is hard-denied for general file tools.`,
      );
      lines.push(
        `- Hint: For Dominds debugging, reproduce in a nested rtws (e.g. \`ux-rtws/.dialogs/\`), which is not covered by this hard deny.`,
      );
    }
  }

  return lines.join('\n');
}
