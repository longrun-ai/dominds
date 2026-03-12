/**
 * Module: server/mime-types
 *
 * Common MIME type mappings for static file serving
 */
import { extname } from 'path';

export const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.cjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.yaml': 'application/yaml; charset=utf-8',
  '.yml': 'application/yaml; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.ts': 'application/typescript; charset=utf-8',
  '.tsx': 'text/tsx; charset=utf-8',
  '.jsx': 'text/jsx; charset=utf-8',
  '.sh': 'application/x-sh; charset=utf-8',
  '.sql': 'application/sql; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
};

const TEXT_LIKE_MIME_TYPES = new Set<string>([
  'application/javascript',
  'application/json',
  'application/ld+json',
  'application/sql',
  'application/typescript',
  'application/x-sh',
  'application/x-shellscript',
  'application/xml',
  'application/yaml',
]);

/**
 * Get MIME type for a file extension
 */
export function getMimeType(ext: string): string {
  return MIME_TYPES[ext.toLowerCase()] || 'application/octet-stream';
}

export function getMimeTypeFromPath(filePath: string): string {
  return getMimeType(extname(filePath));
}

function hasPrefix(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.length < signature.length) return false;
  for (let i = 0; i < signature.length; i += 1) {
    if (bytes[i] !== signature[i]) return false;
  }
  return true;
}

function looksLikeUtf8Text(bytes: Uint8Array): boolean {
  if (bytes.length < 1) return true;
  let suspicious = 0;
  for (const byte of bytes) {
    if (byte === 0) return false;
    if (byte < 0x09) {
      suspicious += 1;
      continue;
    }
    if (byte > 0x0d && byte < 0x20) {
      suspicious += 1;
    }
  }
  return suspicious / bytes.length < 0.1;
}

export function sniffMimeType(filePath: string, bytes: Uint8Array): string {
  const fromPath = getMimeTypeFromPath(filePath);
  if (fromPath !== 'application/octet-stream') return fromPath;

  if (hasPrefix(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (hasPrefix(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (
    hasPrefix(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
    hasPrefix(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
  ) {
    return 'image/gif';
  }
  if (
    hasPrefix(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    bytes.length >= 12 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  if (hasPrefix(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf';
  if (hasPrefix(bytes, [0x50, 0x4b, 0x03, 0x04])) return 'application/zip';
  if (hasPrefix(bytes, [0x1f, 0x8b, 0x08])) return 'application/gzip';
  if (looksLikeUtf8Text(bytes)) return 'text/plain; charset=utf-8';

  return 'application/octet-stream';
}

export function isTextLikeMimeType(mimeType: string): boolean {
  const normalized = mimeType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (normalized.startsWith('text/')) return true;
  return TEXT_LIKE_MIME_TYPES.has(normalized);
}
