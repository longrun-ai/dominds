import { formatUnifiedTimestamp } from '@longrun-ai/kernel/utils/time';
import fsPromises from 'fs/promises';
import type { ServerResponse } from 'http';
import * as path from 'path';

const FORENSICS_STATUS_DIRS = ['run', 'done', 'archive', 'malformed'] as const;
type ForensicsStatusDir = (typeof FORENSICS_STATUS_DIRS)[number];
type ForensicsMode = 'full' | 'pick';

type ForensicsLocatorRequest = {
  rootId: string;
  selfId: string;
  requestedStatus: ForensicsStatusDir | undefined;
};

type ForensicsRequest = ForensicsLocatorRequest & {
  course: number | undefined;
  mode: ForensicsMode;
  files: readonly string[];
};

type ZipEntry = {
  name: string;
  data: Buffer;
};

type CollectedEntry = ZipEntry & {
  sourcePath: string;
};

type MissingFile = {
  entryName: string;
  sourcePath: string;
};

type ResolvedForensicsPaths = {
  dialogsRoot: string;
  status: ForensicsStatusDir;
  rootPath: string;
  targetPath: string;
  targetKind: 'root' | 'side';
};

type DialogForensicsManifest = {
  generatedAt: string;
  rtwsRoot: string;
  request: {
    rootId: string;
    selfId: string;
    course: number | null;
    status: ForensicsStatusDir | null;
    mode: ForensicsMode;
    files: readonly string[];
  };
  resolved: {
    status: ForensicsStatusDir;
    dialogsRoot: string;
    rootPath: string;
    targetPath: string;
    targetKind: 'root' | 'side';
  };
  files: Array<{
    entryName: string;
    sourcePath: string;
    size: number;
  }>;
  missingFiles: MissingFile[];
};

class BadForensicsRequestError extends Error {}
class ForensicsNotFoundError extends Error {}

function badRequest(message: string): never {
  throw new BadForensicsRequestError(message);
}

function notFound(message: string): never {
  throw new ForensicsNotFoundError(message);
}

const ROOT_DIAGNOSTIC_FILE_NAMES = [
  'latest.yaml',
  'dialog.yaml',
  'drive-watch.json',
  'active-callees.json',
  'sideDialog-responses.json',
  'q4h.yaml',
  'backend-drive-stalls.jsonl',
  'wake-queue.jsonl',
  'asker-stack.jsonl',
] as const;

const CRC32_TABLE = (() => {
  const table: number[] = [];
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table.push(value >>> 0);
  }
  return table;
})();

function respondJson(res: ServerResponse, statusCode: number, data: unknown): void {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(data));
}

function isPositiveIntegerText(raw: string): boolean {
  if (raw === '') return false;
  for (const char of raw) {
    if (char < '0' || char > '9') return false;
  }
  return true;
}

function parsePositiveInteger(raw: string | null, fieldName: string): number | undefined {
  if (raw === null || raw.trim() === '') return undefined;
  if (!isPositiveIntegerText(raw)) {
    badRequest(`${fieldName} must be a positive integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    badRequest(`${fieldName} must be a positive integer`);
  }
  return value;
}

function normalizeStatus(raw: string | null): ForensicsStatusDir | undefined {
  if (raw === null || raw.trim() === '') return undefined;
  switch (raw) {
    case 'run':
    case 'running':
      return 'run';
    case 'done':
    case 'completed':
      return 'done';
    case 'archive':
    case 'archived':
      return 'archive';
    case 'malformed':
      return 'malformed';
    default:
      badRequest(
        'status must be one of run, running, done, completed, archive, archived, malformed',
      );
  }
}

function normalizeMode(raw: string | null): ForensicsMode {
  if (raw === null || raw.trim() === '') return 'full';
  if (raw === 'full' || raw === 'pick') return raw;
  badRequest('mode must be full or pick');
}

function hasTraversalSegment(value: string): boolean {
  const parts = value.split('/');
  return parts.some((part) => part === '' || part === '.' || part === '..');
}

function parseDialogId(raw: string | null, fieldName: string): string {
  if (raw === null || raw.trim() === '') {
    badRequest(`${fieldName} is required`);
  }
  if (raw.includes(String.fromCharCode(92)) || raw.includes(String.fromCharCode(0))) {
    badRequest(`${fieldName} must be a slash-separated relative dialog id`);
  }
  if (path.isAbsolute(raw) || hasTraversalSegment(raw)) {
    badRequest(`${fieldName} must not contain empty or traversal path segments`);
  }
  return raw;
}

function validateBundleEntryName(name: string, fieldName: string): void {
  if (
    name === '' ||
    name.startsWith('/') ||
    name.includes(String.fromCharCode(92)) ||
    name.includes(String.fromCharCode(0)) ||
    hasTraversalSegment(name)
  ) {
    badRequest(`${fieldName} must be a safe bundle entry path`);
  }
}

function parseRepeatedSafeBundlePaths(
  requestUrl: URL,
  queryName: string,
  fieldName: string,
): readonly string[] {
  const paths = requestUrl.searchParams
    .getAll(queryName)
    .map((raw) => raw.trim().replace(/\/+$/, ''))
    .filter((raw) => raw !== '');
  const unique = [...new Set(paths)];
  for (const item of unique) {
    validateBundleEntryName(item, fieldName);
  }
  return unique;
}

function parseFileSelection(requestUrl: URL): readonly string[] {
  return parseRepeatedSafeBundlePaths(requestUrl, 'files', 'files');
}

function parseForensicsLocatorRequest(requestUrl: URL): ForensicsLocatorRequest {
  const rootId = parseDialogId(requestUrl.searchParams.get('rootId'), 'rootId');
  const selfId = parseDialogId(requestUrl.searchParams.get('selfId') ?? rootId, 'selfId');
  return {
    rootId,
    selfId,
    requestedStatus: normalizeStatus(requestUrl.searchParams.get('status')),
  };
}

function parseForensicsRequest(requestUrl: URL): ForensicsRequest {
  const locator = parseForensicsLocatorRequest(requestUrl);
  const mode = normalizeMode(requestUrl.searchParams.get('mode'));
  const files = parseFileSelection(requestUrl);
  if (mode === 'pick' && files.length === 0) {
    badRequest('mode=pick requires at least one files= parameter');
  }
  return {
    ...locator,
    course: parsePositiveInteger(requestUrl.searchParams.get('course'), 'course'),
    mode,
    files,
  };
}

function isNodeFileNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
  );
}

async function pathExists(pathAbs: string): Promise<boolean> {
  try {
    await fsPromises.access(pathAbs);
    return true;
  } catch (error: unknown) {
    if (isNodeFileNotFound(error)) return false;
    throw error;
  }
}

async function resolveForensicsPaths(
  request: ForensicsLocatorRequest,
): Promise<ResolvedForensicsPaths> {
  const dialogsRoot = path.join(process.cwd(), '.dialogs');
  const statuses = request.requestedStatus ? [request.requestedStatus] : FORENSICS_STATUS_DIRS;
  const targetKind = request.selfId === request.rootId ? 'root' : 'side';
  for (const status of statuses) {
    const rootPath = path.join(dialogsRoot, status, request.rootId);
    const targetPath =
      targetKind === 'root' ? rootPath : path.join(rootPath, 'sideDialogs', request.selfId);
    if (await pathExists(targetPath)) {
      return { dialogsRoot, status, rootPath, targetPath, targetKind };
    }
  }
  notFound(
    `dialog records not found for rootId=${request.rootId}, selfId=${request.selfId}, status=${request.requestedStatus ?? 'auto'}`,
  );
}

function toZipEntryName(...parts: string[]): string {
  let joined = parts.join('/').split(String.fromCharCode(92)).join('/');
  while (joined.startsWith('/')) joined = joined.slice(1);
  while (joined.includes('//')) joined = joined.replace('//', '/');
  validateBundleEntryName(joined, 'zip entry');
  return joined;
}

function sourcePathForBundleEntry(resolved: ResolvedForensicsPaths, entryName: string): string {
  validateBundleEntryName(entryName, 'file');
  const [prefix, ...restParts] = entryName.split('/');
  if (restParts.length === 0) {
    badRequest(`files must include a path after ${prefix}`);
  }
  const relativePath = path.join(...restParts);
  switch (prefix) {
    case 'side':
      if (resolved.targetKind !== 'side') {
        badRequest('side/* files can only be selected for a side dialog');
      }
      return path.join(resolved.targetPath, relativePath);
    case 'root':
      if (resolved.targetKind !== 'side') {
        badRequest('root/* files can only be selected when selfId is a side dialog');
      }
      return path.join(resolved.rootPath, relativePath);
    case 'dialog':
      if (resolved.targetKind !== 'root') {
        badRequest('dialog/* files can only be selected when selfId equals rootId');
      }
      return path.join(resolved.rootPath, relativePath);
    case 'debug':
      if (restParts.length !== 1) {
        badRequest('debug selections must be direct debug filenames');
      }
      return path.join(resolved.dialogsRoot, 'debug', restParts[0]);
    default:
      badRequest('files must start with side/, root/, dialog/, or debug/');
  }
}

async function collectFileIfPresent(
  entries: CollectedEntry[],
  missingFiles: MissingFile[],
  sourcePath: string,
  entryName: string,
): Promise<void> {
  try {
    const stat = await fsPromises.stat(sourcePath);
    if (!stat.isFile()) {
      missingFiles.push({ entryName, sourcePath });
      return;
    }
    entries.push({
      name: entryName,
      data: await fsPromises.readFile(sourcePath),
      sourcePath,
    });
  } catch (error: unknown) {
    if (isNodeFileNotFound(error)) {
      missingFiles.push({ entryName, sourcePath });
      return;
    }
    throw error;
  }
}

async function collectTree(
  entries: CollectedEntry[],
  rootPath: string,
  entryPrefix: string,
  relativeDir = '',
): Promise<void> {
  const dirPath = path.join(rootPath, relativeDir);
  const dirents = await fsPromises.readdir(dirPath, { withFileTypes: true });
  dirents.sort((left, right) => left.name.localeCompare(right.name));
  for (const dirent of dirents) {
    if (dirent.name === '.' || dirent.name === '..') continue;
    const nextRelative = relativeDir === '' ? dirent.name : path.join(relativeDir, dirent.name);
    const sourcePath = path.join(rootPath, nextRelative);
    if (dirent.isDirectory()) {
      await collectTree(entries, rootPath, entryPrefix, nextRelative);
      continue;
    }
    if (dirent.isFile()) {
      entries.push({
        name: toZipEntryName(entryPrefix, nextRelative),
        data: await fsPromises.readFile(sourcePath),
        sourcePath,
      });
    }
  }
}

async function collectOptionalRootFiles(
  entries: CollectedEntry[],
  missingFiles: MissingFile[],
  rootPath: string,
  entryPrefix: 'root' | 'dialog',
  course: number | undefined,
): Promise<void> {
  const names: string[] = [...ROOT_DIAGNOSTIC_FILE_NAMES];
  if (course !== undefined) {
    names.push(`course-${String(course).padStart(3, '0')}.jsonl`);
  }
  for (const name of names) {
    const entryName = toZipEntryName(entryPrefix, name);
    await collectFileIfPresent(entries, missingFiles, path.join(rootPath, name), entryName);
  }
}

function filenameContainsDialogParts(filename: string, rootId: string, selfId: string): boolean {
  const parts = [...rootId.split('/'), ...selfId.split('/')];
  return parts.every((part) => filename.includes(part));
}

async function collectDebugFiles(
  entries: CollectedEntry[],
  missingFiles: MissingFile[],
  dialogsRoot: string,
  rootId: string,
  selfId: string,
): Promise<void> {
  const debugPath = path.join(dialogsRoot, 'debug');
  let dirents;
  try {
    dirents = await fsPromises.readdir(debugPath, { withFileTypes: true });
  } catch (error: unknown) {
    if (isNodeFileNotFound(error)) {
      missingFiles.push({ entryName: 'debug/', sourcePath: debugPath });
      return;
    }
    throw error;
  }
  dirents.sort((left, right) => left.name.localeCompare(right.name));
  for (const dirent of dirents) {
    if (!dirent.isFile() || !filenameContainsDialogParts(dirent.name, rootId, selfId)) continue;
    const sourcePath = path.join(debugPath, dirent.name);
    entries.push({
      name: toZipEntryName('debug', dirent.name),
      data: await fsPromises.readFile(sourcePath),
      sourcePath,
    });
  }
}

async function collectPickedFiles(
  entries: CollectedEntry[],
  missingFiles: MissingFile[],
  resolved: ResolvedForensicsPaths,
  request: ForensicsRequest,
): Promise<void> {
  for (const entryName of request.files) {
    await collectFileIfPresent(
      entries,
      missingFiles,
      sourcePathForBundleEntry(resolved, entryName),
      entryName,
    );
  }
}

function assertUniqueEntries(entries: CollectedEntry[]): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.name)) {
      throw new Error(`duplicate forensics zip entry: ${entry.name}`);
    }
    seen.add(entry.name);
  }
}

function buildManifest(params: {
  request: ForensicsRequest;
  resolved: ResolvedForensicsPaths;
  entries: CollectedEntry[];
  missingFiles: MissingFile[];
}): DialogForensicsManifest {
  return {
    generatedAt: formatUnifiedTimestamp(new Date()),
    rtwsRoot: process.cwd(),
    request: {
      rootId: params.request.rootId,
      selfId: params.request.selfId,
      course: params.request.course ?? null,
      status: params.request.requestedStatus ?? null,
      mode: params.request.mode,
      files: params.request.files,
    },
    resolved: {
      status: params.resolved.status,
      dialogsRoot: params.resolved.dialogsRoot,
      rootPath: params.resolved.rootPath,
      targetPath: params.resolved.targetPath,
      targetKind: params.resolved.targetKind,
    },
    files: params.entries.map((entry) => ({
      entryName: entry.name,
      sourcePath: entry.sourcePath,
      size: entry.data.byteLength,
    })),
    missingFiles: params.missingFiles,
  };
}

async function collectDialogForensicsZip(request: ForensicsRequest): Promise<Buffer> {
  const resolved = await resolveForensicsPaths(request);
  const entries: CollectedEntry[] = [];
  const missingFiles: MissingFile[] = [];

  if (request.mode === 'pick') {
    await collectPickedFiles(entries, missingFiles, resolved, request);
  } else if (resolved.targetKind === 'side') {
    await collectTree(entries, resolved.targetPath, 'side');
    await collectOptionalRootFiles(
      entries,
      missingFiles,
      resolved.rootPath,
      'root',
      request.course,
    );
    await collectDebugFiles(
      entries,
      missingFiles,
      resolved.dialogsRoot,
      request.rootId,
      request.selfId,
    );
  } else {
    await collectOptionalRootFiles(
      entries,
      missingFiles,
      resolved.rootPath,
      'dialog',
      request.course,
    );
    await collectDebugFiles(
      entries,
      missingFiles,
      resolved.dialogsRoot,
      request.rootId,
      request.selfId,
    );
  }

  assertUniqueEntries(entries);
  const manifest = buildManifest({ request, resolved, entries, missingFiles });
  const zipEntries: ZipEntry[] = [
    {
      name: 'manifest.json',
      data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'),
    },
    ...entries.map((entry) => ({ name: entry.name, data: entry.data })),
  ];
  return buildStoreZip(zipEntries);
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function toDosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

function writeUInt32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value >>> 0, 0);
  return buffer;
}

function writeUInt16(value: number): Buffer {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value, 0);
  return buffer;
}

function buildStoreZip(entries: ZipEntry[]): Buffer {
  if (entries.length > 0xffff) {
    throw new Error('forensics zip has too many entries for non-ZIP64 output');
  }
  const now = toDosDateTime(new Date());
  const generalPurposeUtf8Flag = 0x0800;
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuffer = Buffer.from(entry.name, 'utf8');
    const checksum = crc32(entry.data);
    if (nameBuffer.byteLength > 0xffff) {
      throw new Error(`zip entry name is too long: ${entry.name}`);
    }
    if (entry.data.byteLength > 0xffffffff || offset > 0xffffffff) {
      throw new Error('forensics zip is too large for non-ZIP64 output');
    }

    const localHeader = Buffer.concat([
      writeUInt32(0x04034b50),
      writeUInt16(20),
      writeUInt16(generalPurposeUtf8Flag),
      writeUInt16(0),
      writeUInt16(now.time),
      writeUInt16(now.date),
      writeUInt32(checksum),
      writeUInt32(entry.data.byteLength),
      writeUInt32(entry.data.byteLength),
      writeUInt16(nameBuffer.byteLength),
      writeUInt16(0),
      nameBuffer,
    ]);
    localParts.push(localHeader, entry.data);

    const centralHeader = Buffer.concat([
      writeUInt32(0x02014b50),
      writeUInt16(20),
      writeUInt16(20),
      writeUInt16(generalPurposeUtf8Flag),
      writeUInt16(0),
      writeUInt16(now.time),
      writeUInt16(now.date),
      writeUInt32(checksum),
      writeUInt32(entry.data.byteLength),
      writeUInt32(entry.data.byteLength),
      writeUInt16(nameBuffer.byteLength),
      writeUInt16(0),
      writeUInt16(0),
      writeUInt16(0),
      writeUInt16(0),
      writeUInt32(0),
      writeUInt32(offset),
      nameBuffer,
    ]);
    centralParts.push(centralHeader);
    offset += localHeader.byteLength + entry.data.byteLength;
    if (offset > 0xffffffff) {
      throw new Error('forensics zip is too large for non-ZIP64 output');
    }
  }

  const centralDirectory = Buffer.concat(centralParts);
  if (centralDirectory.byteLength > 0xffffffff) {
    throw new Error('forensics zip central directory is too large for non-ZIP64 output');
  }
  const endOfCentralDirectory = Buffer.concat([
    writeUInt32(0x06054b50),
    writeUInt16(0),
    writeUInt16(0),
    writeUInt16(entries.length),
    writeUInt16(entries.length),
    writeUInt32(centralDirectory.byteLength),
    writeUInt32(offset),
    writeUInt16(0),
  ]);
  return Buffer.concat([...localParts, centralDirectory, endOfCentralDirectory]);
}

function forensicsZipFilename(request: ForensicsRequest): string {
  const safe = `${request.rootId}-${request.selfId}`.split('/').join('-');
  return `dominds-dialog-forensics-${safe}.zip`;
}

export async function handleDialogForensicsZipRoute(
  reqUrl: string | undefined,
  res: ServerResponse,
): Promise<boolean> {
  const requestUrl = new URL(reqUrl ?? '/', 'http://127.0.0.1');
  let request: ForensicsRequest;
  try {
    request = parseForensicsRequest(requestUrl);
  } catch (error: unknown) {
    respondJson(res, 400, {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
    return true;
  }

  try {
    const zipBuffer = await collectDialogForensicsZip(request);
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${forensicsZipFilename(request)}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(zipBuffer);
    return true;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    respondJson(
      res,
      error instanceof BadForensicsRequestError
        ? 400
        : error instanceof ForensicsNotFoundError
          ? 404
          : 500,
      {
        success: false,
        error: message,
      },
    );
    return true;
  }
}
