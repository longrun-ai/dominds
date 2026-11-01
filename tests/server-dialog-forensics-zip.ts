import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { crc32, inflateRawSync } from 'node:zlib';
import { createHttpServer } from '../main/server/server-core';
import { withTempRtws } from './kernel-driver/helpers';

type HttpResult = {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
};

function requestBuffer(url: URL, headers: Record<string, string> = {}): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      {
        method: 'GET',
        headers: { Connection: 'close', ...headers },
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.once('error', reject);
        res.once('aborted', () => reject(new Error('HTTP response aborted before completion')));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** Independent ZIP reader checks stored or deflated wire data, not the server's writer. */
function readZipEntries(zip: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  assert.ok(zip.length >= 22);
  let end = zip.length - 22;
  while (end >= 0 && zip.readUInt32LE(end) !== 0x06054b50) end--;
  assert.ok(end >= 0);
  assert.equal(end + 22 + zip.readUInt16LE(end + 20), zip.length);
  const count = zip.readUInt16LE(end + 10);
  let offset = zip.readUInt32LE(end + 16);
  const centralEnd = offset + zip.readUInt32LE(end + 12);
  assert.ok(centralEnd <= end);
  for (let index = 0; index < count; index++) {
    assert.ok(offset + 46 <= centralEnd);
    assert.equal(zip.readUInt32LE(offset), 0x02014b50);
    const nameLength = zip.readUInt16LE(offset + 28),
      extraLength = zip.readUInt16LE(offset + 30),
      commentLength = zip.readUInt16LE(offset + 32);
    const next = offset + 46 + nameLength + extraLength + commentLength;
    assert.ok(next <= centralEnd);
    const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    assert.equal(entries.has(name), false);
    const method = zip.readUInt16LE(offset + 10),
      compressedLength = zip.readUInt32LE(offset + 20),
      originalLength = zip.readUInt32LE(offset + 24),
      checksum = zip.readUInt32LE(offset + 16);
    const local = zip.readUInt32LE(offset + 42);
    assert.ok(local + 30 <= zip.length);
    assert.equal(zip.readUInt32LE(local), 0x04034b50);
    const localNameLength = zip.readUInt16LE(local + 26),
      localExtraLength = zip.readUInt16LE(local + 28);
    const start = local + 30 + localNameLength + localExtraLength;
    assert.ok(start + compressedLength <= zip.length);
    assert.equal(zip.subarray(local + 30, local + 30 + localNameLength).toString('utf8'), name);
    assert.equal(zip.readUInt16LE(local + 8), method);
    const compressed = zip.subarray(start, start + compressedLength);
    assert.ok(
      method === 0 || method === 8,
      'the standard stored/deflate formats are supported by this consumer',
    );
    const data = method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed);
    assert.equal(data.length, originalLength);
    assert.equal(crc32(data), checksum);
    entries.set(name, data);
    offset = next;
  }
  assert.equal(offset, centralEnd);
  return entries;
}
function record(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

async function main(): Promise<void> {
  await withTempRtws(async (tmpRoot) => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-forensics-outside-'));
    const outsideFile = path.join(outsideDir, 'outside.txt');
    const outsideData = Buffer.from('owned-outside-payload-data\n');
    await fs.writeFile(outsideFile, outsideData);
    console.log(JSON.stringify({ artifact: 'owned-outside-fixture', path: outsideDir }));
    const rootId = '9b/41/4bf053db';
    const selfId = '95/1f/5e9e175c';
    const rootDir = path.join(tmpRoot, '.dialogs', 'run', rootId);
    const sideDir = path.join(rootDir, 'sideDialogs', selfId);
    const suppliedFiles = new Map<string, Buffer>();
    async function seed(file: string, data: string | Buffer) {
      const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, bytes);
      suppliedFiles.set(file, bytes);
    }
    await seed(path.join(sideDir, 'latest.yaml'), 'status: active\n');
    await seed(path.join(sideDir, 'course-021.jsonl'), '{"genseq":1611}\n');
    await seed(path.join(sideDir, 'nested', 'comma,name.json'), '{"comma":true}\n');
    await seed(path.join(rootDir, 'latest.yaml'), 'root: true\n');
    await seed(path.join(rootDir, 'active-callees.json'), '{"items":[]}\n');
    await seed(path.join(rootDir, 'course-021.jsonl'), '{"root":true}\n');
    await seed(path.join(rootDir, 'sideDialogs', 'other', 'latest.yaml'), 'other: true\n');
    await seed(
      path.join(tmpRoot, '.dialogs', 'debug', '9b-41-4bf053db-95-1f-5e9e175c.json'),
      '{"debug":true}\n',
    );
    await seed(
      path.join(tmpRoot, '.dialogs', 'debug', 'unrelated-debug.json'),
      '{"debug":false}\n',
    );
    await seed(path.join(tmpRoot, 'notes', 'a,b.txt'), 'plain rtws file\n');

    await seed(path.join(sideDir, 'bytes.bin'), Buffer.from([0, 255, 1, 128, 0]));
    await seed(path.join(sideDir, 'nested', '多字节.json'), '助手🌿原始数据\n');

    const server = createHttpServer({
      port: 0,
      host: '127.0.0.1',
      mode: 'production',
      auth: { kind: 'enabled', key: 'forensics-test-key', source: 'env' },
    });
    const port = await server.start();
    async function inspectArchive(response: HttpResult, request: URL, targetKind: 'root' | 'side') {
      assert.equal(response.statusCode, 200);
      assert.equal(response.headers['content-type'], 'application/zip');
      const entries = readZipEntries(response.body);
      const manifestData = entries.get('manifest.json');
      assert.ok(manifestData);
      const manifest = record(JSON.parse(manifestData.toString('utf8')) as unknown);
      assert.equal(manifest.rtwsRoot, tmpRoot);
      assert.ok(typeof manifest.generatedAt === 'string' && manifest.generatedAt.length > 0);
      assert.deepEqual(manifest.request, {
        rootId,
        selfId: request.searchParams.get('selfId') ?? rootId,
        course: 21,
        status: null,
        mode: request.searchParams.get('mode') ?? 'full',
        files: request.searchParams.getAll('files'),
      });
      assert.deepEqual(manifest.resolved, {
        status: 'run',
        dialogsRoot: path.join(tmpRoot, '.dialogs'),
        rootPath: rootDir,
        targetPath: targetKind === 'root' ? rootDir : sideDir,
        targetKind,
      });
      assert.ok(Array.isArray(manifest.files));
      const roots = new Map<string, string>(
        targetKind === 'side'
          ? [
              ['side', sideDir],
              ['root', rootDir],
              ['debug', path.join(tmpRoot, '.dialogs', 'debug')],
            ]
          : [
              ['dialog', rootDir],
              ['debug', path.join(tmpRoot, '.dialogs', 'debug')],
            ],
      );
      function expectedEntrySource(name: string): string {
        const [prefix, ...segments] = name.split('/');
        const root = roots.get(prefix);
        assert.ok(
          root &&
            segments.length > 0 &&
            segments.every((part) => part !== '' && part !== '.' && part !== '..'),
        );
        return path.join(root, ...segments);
      }
      const declaredNames: string[] = [];
      for (const item of manifest.files) {
        const entry = record(item);
        assert.ok(typeof entry.entryName === 'string' && typeof entry.sourcePath === 'string');
        const expectedSource = expectedEntrySource(entry.entryName);
        assert.equal(
          entry.sourcePath,
          expectedSource,
          'the bundle entry identifies its independently selected source file',
        );
        const supplied = suppliedFiles.get(expectedSource);
        assert.ok(supplied, 'the manifest source must be an actual supplied fixture file');
        const data = entries.get(entry.entryName);
        assert.ok(data);
        assert.deepEqual(data, supplied);
        assert.equal(entry.size, supplied.length);
        declaredNames.push(entry.entryName);
      }
      assert.deepEqual([...entries.keys()], ['manifest.json', ...declaredNames]);
      assert.ok(Array.isArray(manifest.missingFiles));
      for (const item of manifest.missingFiles) {
        const missing = record(item);
        assert.ok(typeof missing.entryName === 'string' && typeof missing.sourcePath === 'string');
        assert.equal(missing.sourcePath, expectedEntrySource(missing.entryName));
        const relative = path.relative(tmpRoot, missing.sourcePath);
        assert.ok(
          relative !== '' &&
            !path.isAbsolute(relative) &&
            relative !== '..' &&
            !relative.startsWith('..' + path.sep),
        );
        await assert.rejects(fs.stat(missing.sourcePath), { code: 'ENOENT' });
      }
      return entries;
    }

    try {
      const url = new URL(`http://127.0.0.1:${port}/api/dialog-forensics.zip`);
      url.searchParams.set('rootId', rootId);
      url.searchParams.set('selfId', selfId);
      url.searchParams.set('course', '21');

      const unauthorized = await requestBuffer(url);
      assert.equal(unauthorized.statusCode, 401);

      const rawUrl = new URL(`http://127.0.0.1:${port}/api/rtws/raw`);
      rawUrl.searchParams.set('path', 'notes/a,b.txt');
      const rawUnauthorized = await requestBuffer(rawUrl);
      assert.equal(rawUnauthorized.statusCode, 401);

      const rawResponse = await requestBuffer(rawUrl, {
        Authorization: 'Bearer forensics-test-key',
      });
      assert.equal(rawResponse.statusCode, 200);
      assert.equal(rawResponse.headers['content-type'], 'text/plain; charset=utf-8');
      assert.equal(rawResponse.body.toString('utf8'), 'plain rtws file\n');

      const rawDialogUrl = new URL(rawUrl);
      rawDialogUrl.searchParams.set(
        'path',
        '.dialogs/run/9b/41/4bf053db/sideDialogs/95/1f/5e9e175c/latest.yaml',
      );
      const rawDialogResponse = await requestBuffer(rawDialogUrl, {
        Authorization: 'Bearer forensics-test-key',
      });
      assert.equal(rawDialogResponse.statusCode, 200);
      assert.equal(rawDialogResponse.body.toString('utf8'), 'status: active\n');

      const rawDirectoryUrl = new URL(rawUrl);
      rawDirectoryUrl.searchParams.set('path', '.dialogs/run/9b/41/4bf053db');
      const rawDirectoryResponse = await requestBuffer(rawDirectoryUrl, {
        Authorization: 'Bearer forensics-test-key',
      });
      assert.equal(rawDirectoryResponse.statusCode, 400);

      const rawMissingUrl = new URL(rawUrl);
      rawMissingUrl.searchParams.set('path', 'notes/missing.txt');
      const rawMissingResponse = await requestBuffer(rawMissingUrl, {
        Authorization: 'Bearer forensics-test-key',
      });
      assert.equal(rawMissingResponse.statusCode, 404);

      const rawInvalidUrl = new URL(rawUrl);
      rawInvalidUrl.searchParams.set('path', path.relative(tmpRoot, outsideFile));
      const rawInvalidResponse = await requestBuffer(rawInvalidUrl, {
        Authorization: 'Bearer forensics-test-key',
      });
      assert.equal(rawInvalidResponse.statusCode, 400);
      assert.equal(rawInvalidResponse.body.includes(outsideData), false);
      assert.deepEqual(await fs.readFile(outsideFile), outsideData);
      assert.equal(
        unauthorized.body.includes(suppliedFiles.get(path.join(sideDir, 'latest.yaml'))!),
        false,
      );
      assert.equal(
        rawUnauthorized.body.includes(suppliedFiles.get(path.join(tmpRoot, 'notes', 'a,b.txt'))!),
        false,
      );

      const response = await requestBuffer(url, { Authorization: 'Bearer forensics-test-key' });
      assert.equal(response.statusCode, 200);
      assert.equal(response.headers['content-type'], 'application/zip');
      assert.equal(response.body.readUInt32LE(0), 0x04034b50);
      const full = await inspectArchive(response, url, 'side');
      const names = [...full.keys()];
      assert.deepEqual(
        names.slice().sort(),
        [
          'manifest.json',
          'side/latest.yaml',
          'side/course-021.jsonl',
          'side/nested/comma,name.json',
          'side/nested/多字节.json',
          'side/bytes.bin',
          'root/latest.yaml',
          'root/active-callees.json',
          'root/course-021.jsonl',
          'debug/9b-41-4bf053db-95-1f-5e9e175c.json',
        ].sort(),
      );
      assert.ok(names.includes('manifest.json'));
      assert.ok(names.includes('side/latest.yaml'));
      assert.ok(names.includes('side/course-021.jsonl'));
      assert.ok(names.includes('root/latest.yaml'));
      assert.ok(names.includes('root/active-callees.json'));
      assert.ok(names.includes('root/course-021.jsonl'));
      assert.ok(names.includes('debug/9b-41-4bf053db-95-1f-5e9e175c.json'));

      const pickUrl = new URL(url);
      pickUrl.searchParams.set('mode', 'pick');
      pickUrl.searchParams.delete('files');
      pickUrl.searchParams.append('files', 'side/latest.yaml');
      pickUrl.searchParams.append('files', 'root/active-callees.json');
      pickUrl.searchParams.append('files', 'side/nested/comma,name.json');
      const pickResponse = await requestBuffer(pickUrl, {
        Authorization: 'Bearer forensics-test-key',
      });
      assert.equal(pickResponse.statusCode, 200);
      assert.deepEqual(
        [...(await inspectArchive(pickResponse, pickUrl, 'side')).keys()],
        [
          'manifest.json',
          'side/latest.yaml',
          'root/active-callees.json',
          'side/nested/comma,name.json',
        ],
      );

      const debugPickUrl = new URL(url);
      debugPickUrl.searchParams.set('mode', 'pick');
      debugPickUrl.searchParams.delete('files');
      debugPickUrl.searchParams.append('files', 'debug/unrelated-debug.json');
      const debugPickResponse = await requestBuffer(debugPickUrl, {
        Authorization: 'Bearer forensics-test-key',
      });
      assert.equal(debugPickResponse.statusCode, 200);
      assert.deepEqual(
        [...(await inspectArchive(debugPickResponse, debugPickUrl, 'side')).keys()],
        ['manifest.json', 'debug/unrelated-debug.json'],
      );

      const rootUrl = new URL(`http://127.0.0.1:${port}/api/dialog-forensics.zip`);
      rootUrl.searchParams.set('rootId', rootId);
      rootUrl.searchParams.set('course', '21');
      const rootResponse = await requestBuffer(rootUrl, {
        Authorization: 'Bearer forensics-test-key',
      });
      assert.equal(rootResponse.statusCode, 200);
      const rootNames = [...(await inspectArchive(rootResponse, rootUrl, 'root')).keys()];
      assert.equal(rootNames.includes('debug/unrelated-debug.json'), false);
      assert.ok(rootNames.includes('dialog/latest.yaml'));
      assert.ok(rootNames.includes('dialog/course-021.jsonl'));
      assert.equal(
        rootNames.some((name) => name.startsWith('dialog/sideDialogs/')),
        false,
      );
    } finally {
      await server.stop();
    }
    await fs.rm(outsideDir, { recursive: true, force: true });
  });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
