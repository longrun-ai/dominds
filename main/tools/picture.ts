import type { FuncResultContentItem } from '@longrun-ai/kernel/types/storage';
import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { getAccessDeniedMessage, hasReadAccess, hasWriteAccess } from '../access-control';
import type { Dialog } from '../dialog';
import { DialogPersistence } from '../persistence';
import { getWorkLanguage } from '../runtime/work-language';
import type { FuncTool, ToolArguments, ToolCallOutput } from '../tool';
import { toolFailure, toolSuccess } from '../tool';

const PICTURE_MAX_BYTES = 50 * 1024 * 1024;

type SupportedImageMimeType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
type ImageContentItem = Extract<FuncResultContentItem, { type: 'input_image' }>;

function ok(content: string, contentItems?: FuncResultContentItem[]): ToolCallOutput {
  return toolSuccess(content, contentItems);
}

function fail(content: string): ToolCallOutput {
  return toolFailure(content);
}

function formatYamlCodeBlock(yaml: string): string {
  return `\`\`\`yaml\n${yaml}\n\`\`\``;
}

function yamlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function ensureInsideWorkspace(rel: string): string {
  const absPath = path.resolve(process.cwd(), rel);
  const cwd = path.resolve(process.cwd());
  const relative = path.relative(cwd, absPath);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    return absPath;
  }
  throw new Error('Path must be within rtws (runtime workspace)');
}

function requirePathArg(args: ToolArguments): string {
  const value = args['path'];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('Invalid arguments: `path` must be a non-empty string');
  }
  return value.trim();
}

function optionalBooleanArg(args: ToolArguments, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new Error(`Invalid arguments: \`${key}\` must be a boolean`);
  }
  return value;
}

function extToMimeType(relPath: string): SupportedImageMimeType | null {
  switch (path.extname(relPath).toLowerCase()) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.gif':
      return 'image/gif';
    default:
      return null;
  }
}

function mimeTypeToExt(mimeType: SupportedImageMimeType): string {
  switch (mimeType) {
    case 'image/png':
      return 'png';
    case 'image/jpeg':
      return 'jpg';
    case 'image/webp':
      return 'webp';
    case 'image/gif':
      return 'gif';
    default: {
      const _exhaustive: never = mimeType;
      return _exhaustive;
    }
  }
}

function parseSupportedMimeType(value: unknown): SupportedImageMimeType | null {
  switch (value) {
    case 'image/png':
    case 'image/jpeg':
    case 'image/webp':
    case 'image/gif':
      return value;
    default:
      return null;
  }
}

function detectImageMimeType(bytes: Buffer): SupportedImageMimeType | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  if (
    bytes.length >= 6 &&
    (bytes.subarray(0, 6).toString('ascii') === 'GIF87a' ||
      bytes.subarray(0, 6).toString('ascii') === 'GIF89a')
  ) {
    return 'image/gif';
  }
  return null;
}

function validateImageBytesMatchMimeType(bytes: Buffer, mimeType: SupportedImageMimeType): void {
  const detected = detectImageMimeType(bytes);
  if (detected === null) {
    throw new Error('Image bytes do not match a supported PNG/JPEG/WebP/GIF signature');
  }
  if (detected !== mimeType) {
    throw new Error(`Image bytes are ${detected}, but path/mime_type declares ${mimeType}`);
  }
}

function stripDataUrlPrefix(value: string): { base64: string; mimeType?: SupportedImageMimeType } {
  const trimmed = value.trim();
  if (!trimmed.startsWith('data:')) return { base64: trimmed };
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(trimmed);
  if (!match) return { base64: trimmed };
  const mimeType = parseSupportedMimeType(match[1]);
  return {
    base64: match[2] ?? '',
    ...(mimeType === null ? {} : { mimeType }),
  };
}

function isStrictBase64Payload(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0) return false;
  return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
}

function decodeStrictBase64(value: string): Buffer {
  const normalized = value.replace(/\s+/g, '');
  if (!isStrictBase64Payload(normalized)) {
    throw new Error('Image data must be strict base64 or a base64 data URL');
  }
  return Buffer.from(normalized, 'base64');
}

function sanitizePathSegment(value: string): string {
  const cleaned = value.replace(/[^0-9A-Za-z._-]/g, '_').replace(/_+/g, '_');
  const trimmed = cleaned.replace(/^_+|_+$/g, '');
  return trimmed.length > 0 ? trimmed.slice(0, 96) : 'picture';
}

async function persistPictureArtifact(args: {
  dlg: Dialog;
  toolName: string;
  mimeType: SupportedImageMimeType;
  bytes: Buffer;
}): Promise<ImageContentItem> {
  const eventsBase = DialogPersistence.getDialogEventsPath(args.dlg.id, args.dlg.status);
  const relPath = path.posix.join(
    'artifacts',
    'workspace',
    sanitizePathSegment(args.toolName),
    `${Date.now().toString(36)}-${randomUUID()}.${mimeTypeToExt(args.mimeType)}`,
  );
  const absPath = path.join(eventsBase, ...relPath.split('/'));
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, args.bytes);
  return {
    type: 'input_image',
    mimeType: args.mimeType,
    byteLength: args.bytes.length,
    artifact: {
      rootId: args.dlg.id.rootId,
      selfId: args.dlg.id.selfId,
      status: args.dlg.status,
      relPath,
    },
  };
}

function formatPictureResultYaml(args: {
  status: 'ok';
  action: 'read_picture' | 'write_picture';
  path: string;
  mimeType: SupportedImageMimeType;
  byteLength: number;
  artifactRelPath: string;
}): string {
  return formatYamlCodeBlock(
    [
      `status: ${args.status}`,
      `action: ${args.action}`,
      `path: ${yamlQuote(args.path)}`,
      `mime_type: ${yamlQuote(args.mimeType)}`,
      `byte_length: ${String(args.byteLength)}`,
      `artifact_rel_path: ${yamlQuote(args.artifactRelPath)}`,
      'llm_context: image_attached',
    ].join('\n'),
  );
}

export const readPictureTool: FuncTool = {
  type: 'func',
  name: 'read_picture',
  description:
    'Read a PNG/JPEG/WebP/GIF image from rtws and attach it as an image content item for the next LLM context.',
  descriptionI18n: {
    en: 'Read a PNG/JPEG/WebP/GIF image from rtws and attach it as an image content item for the next LLM context.',
    zh: '读取 rtws 中的 PNG/JPEG/WebP/GIF 图片，并作为图片 content item 放入后续 LLM 上下文。',
  },
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      path: {
        type: 'string',
        description:
          'rtws-relative image path to read. Supported extensions: .png, .jpg, .jpeg, .webp, .gif.',
      },
    },
    required: ['path'],
  },
  argsValidation: 'dominds',
  call: async (dlg, caller, args): Promise<ToolCallOutput> => {
    const language = getWorkLanguage();
    try {
      const relPath = requirePathArg(args);
      if (!hasReadAccess(caller, relPath)) {
        return fail(getAccessDeniedMessage('read', relPath, language));
      }
      const mimeType = extToMimeType(relPath);
      if (mimeType === null) {
        return fail(
          'Unsupported image extension. Supported extensions: .png, .jpg, .jpeg, .webp, .gif',
        );
      }
      const absPath = ensureInsideWorkspace(relPath);
      const stat = await fs.stat(absPath);
      if (!stat.isFile()) return fail(`Path is not a file: ${relPath}`);
      if (stat.size <= 0 || stat.size > PICTURE_MAX_BYTES) {
        return fail(`Image must be between 1 byte and ${String(PICTURE_MAX_BYTES)} bytes`);
      }
      const bytes = await fs.readFile(absPath);
      validateImageBytesMatchMimeType(bytes, mimeType);
      const item = await persistPictureArtifact({
        dlg,
        toolName: 'read_picture',
        mimeType,
        bytes,
      });
      return ok(
        formatPictureResultYaml({
          status: 'ok',
          action: 'read_picture',
          path: relPath,
          mimeType,
          byteLength: bytes.length,
          artifactRelPath: item.artifact.relPath,
        }),
        [item],
      );
    } catch (error: unknown) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  },
};

export const writePictureTool: FuncTool = {
  type: 'func',
  name: 'write_picture',
  description:
    'Write a PNG/JPEG/WebP/GIF image to rtws from strict base64 or a base64 data URL, then attach the written image as a content item.',
  descriptionI18n: {
    en: 'Write a PNG/JPEG/WebP/GIF image to rtws from strict base64 or a base64 data URL, then attach the written image as a content item.',
    zh: '把 strict base64 或 base64 data URL 写成 rtws 中的 PNG/JPEG/WebP/GIF 图片，并把写出的图片作为 content item 返回。',
  },
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      path: {
        type: 'string',
        description:
          'rtws-relative destination image path. Supported extensions: .png, .jpg, .jpeg, .webp, .gif.',
      },
      data_base64: {
        type: 'string',
        description: 'Strict base64 image payload, or a base64 data URL.',
      },
      mime_type: {
        type: 'string',
        description:
          'Optional MIME type. Supported values: image/png, image/jpeg, image/webp, image/gif.',
      },
      overwrite: {
        type: 'boolean',
        description: 'Whether to overwrite an existing file. Defaults to false.',
      },
    },
    required: ['path', 'data_base64'],
  },
  argsValidation: 'dominds',
  call: async (dlg, caller, args): Promise<ToolCallOutput> => {
    const language = getWorkLanguage();
    try {
      const relPath = requirePathArg(args);
      if (!hasWriteAccess(caller, relPath)) {
        return fail(getAccessDeniedMessage('write', relPath, language));
      }
      const rawData = args['data_base64'];
      if (typeof rawData !== 'string' || rawData.trim() === '') {
        return fail('Invalid arguments: `data_base64` must be a non-empty string');
      }
      const parsedData = stripDataUrlPrefix(rawData);
      const explicitMimeType = parseSupportedMimeType(args['mime_type']);
      if (args['mime_type'] !== undefined && explicitMimeType === null) {
        return fail(
          'Unsupported mime_type. Supported values: image/png, image/jpeg, image/webp, image/gif',
        );
      }
      const pathMimeType = extToMimeType(relPath);
      if (pathMimeType === null) {
        return fail(
          'Unsupported image extension. Supported extensions: .png, .jpg, .jpeg, .webp, .gif',
        );
      }
      const mimeType = explicitMimeType ?? parsedData.mimeType ?? pathMimeType;
      if (mimeType !== pathMimeType) {
        return fail(`mime_type ${mimeType} does not match destination extension for ${relPath}`);
      }
      const bytes = decodeStrictBase64(parsedData.base64);
      if (bytes.length <= 0 || bytes.length > PICTURE_MAX_BYTES) {
        return fail(`Image must be between 1 byte and ${String(PICTURE_MAX_BYTES)} bytes`);
      }
      validateImageBytesMatchMimeType(bytes, mimeType);
      const overwrite = optionalBooleanArg(args, 'overwrite') ?? false;
      const absPath = ensureInsideWorkspace(relPath);
      if (!overwrite) {
        try {
          await fs.stat(absPath);
          return fail(`File already exists: ${relPath}. Pass overwrite=true to replace it.`);
        } catch (error: unknown) {
          if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
            throw error;
          }
        }
      }
      await fs.mkdir(path.dirname(absPath), { recursive: true });
      await fs.writeFile(absPath, bytes);
      const item = await persistPictureArtifact({
        dlg,
        toolName: 'write_picture',
        mimeType,
        bytes,
      });
      return ok(
        formatPictureResultYaml({
          status: 'ok',
          action: 'write_picture',
          path: relPath,
          mimeType,
          byteLength: bytes.length,
          artifactRelPath: item.artifact.relPath,
        }),
        [item],
      );
    } catch (error: unknown) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  },
};
