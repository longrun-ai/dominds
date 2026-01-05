/**
 * Module: id
 *
 * Utility functions for generating unique identifiers
 * Used across the application without creating circular dependencies
 */

import * as crypto from 'crypto';

/**
 * Generate a unique dialog ID
 * Format: aa/bb/cccccccc where a,b are random bytes and c is time-based
 */
export function generateDialogID(): string {
  // a, b: 8-bit random values derived from a single Math.random() call
  // c: lower 32 bits of system time
  const r16 = Math.floor(Math.random() * 0x10000) & 0xffff; // two random bytes
  const aByte = r16 & 0xff;
  const bByte = (r16 >>> 8) & 0xff;
  const time32 = (Date.now() & 0xffffffff) >>> 0;

  const a = aByte.toString(16).padStart(2, '0');
  const b = bByte.toString(16).padStart(2, '0');
  const c = time32.toString(16).padStart(8, '0');
  return `${a}/${b}/${c}`;
}

/**
 * Generate deterministic hash ID for tool call content.
 * Uses MD5 (faster, shorter output than SHA256) + local counter.
 *
 * @param content - The content to hash (e.g., "tool_name\nheadline\nbody")
 * @param localCounter - Incremented per tool call in current parsing session
 * @returns Short hash string (8 characters)
 */
export function generateContentHash(content: string, localCounter: number): string {
  const payload = `${content}\n${localCounter}`;
  return crypto.createHash('md5').update(payload).digest('hex').substring(0, 8);
}
