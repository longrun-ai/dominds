import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHttpServer } from '../main/server/server-core';

type HttpResult = {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
};

async function writeText(filePath: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text);
}

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

function listZipEntryNames(zip: Buffer): string[] {
  const names: string[] = [];
  let offset = zip.length - 22;
  while (offset >= 0 && zip.readUInt32LE(offset) !== 0x06054b50) {
    offset -= 1;
  }
  assert.ok(offset >= 0, 'expected end of central directory');
  const entryCount = zip.readUInt16LE(offset + 10);
  let centralOffset = zip.readUInt32LE(offset + 16);
  for (let index = 0; index < entryCount; index += 1) {
    assert.equal(zip.readUInt32LE(centralOffset), 0x02014b50);
    const nameLength = zip.readUInt16LE(centralOffset + 28);
    const extraLength = zip.readUInt16LE(centralOffset + 30);
    const commentLength = zip.readUInt16LE(centralOffset + 32);
    names.push(zip.subarray(centralOffset + 46, centralOffset + 46 + nameLength).toString('utf8'));
    centralOffset += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}

async function main(): Promise<void> {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dominds-forensics-api-'));
  const previousCwd = process.cwd();
  process.chdir(tmpRoot);
  try {
    const rootId = '9b/41/4bf053db';
    const selfId = '95/1f/5e9e175c';
    const rootDir = path.join(tmpRoot, '.dialogs', 'run', rootId);
    const sideDir = path.join(rootDir, 'sideDialogs', selfId);
    await writeText(path.join(sideDir, 'latest.yaml'), 'status: active\n');
    await writeText(path.join(sideDir, 'course-021.jsonl'), '{"genseq":1611}\n');
    await writeText(path.join(sideDir, 'nested', 'comma,name.json'), '{"comma":true}\n');
    await writeText(path.join(rootDir, 'latest.yaml'), 'root: true\n');
    await writeText(path.join(rootDir, 'active-callees.json'), '{"items":[]}\n');
    await writeText(path.join(rootDir, 'course-021.jsonl'), '{"root":true}\n');
    await writeText(path.join(rootDir, 'sideDialogs', 'other', 'latest.yaml'), 'other: true\n');
    await writeText(
      path.join(tmpRoot, '.dialogs', 'debug', '9b-41-4bf053db-95-1f-5e9e175c.json'),
      '{"debug":true}\n',
    );
    await writeText(
      path.join(tmpRoot, '.dialogs', 'debug', 'unrelated-debug.json'),
      '{"debug":false}\n',
    );
    await writeText(path.join(tmpRoot, 'notes', 'a,b.txt'), 'plain rtws file\n');

    const server = createHttpServer({
      port: 0,
      host: '127.0.0.1',
      mode: 'production',
      auth: { kind: 'enabled', key: 'forensics-test-key', source: 'env' },
    });
    const port = await server.start();
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
      rawInvalidUrl.searchParams.set('path', '../outside.txt');
      const rawInvalidResponse = await requestBuffer(rawInvalidUrl, {
        Authorization: 'Bearer forensics-test-key',
      });
      assert.equal(rawInvalidResponse.statusCode, 400);

      const response = await requestBuffer(url, { Authorization: 'Bearer forensics-test-key' });
      assert.equal(response.statusCode, 200);
      assert.equal(response.headers['content-type'], 'application/zip');
      assert.equal(response.body.readUInt32LE(0), 0x04034b50);
      const names = listZipEntryNames(response.body);
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
      assert.deepEqual(listZipEntryNames(pickResponse.body), [
        'manifest.json',
        'side/latest.yaml',
        'root/active-callees.json',
        'side/nested/comma,name.json',
      ]);

      const debugPickUrl = new URL(url);
      debugPickUrl.searchParams.set('mode', 'pick');
      debugPickUrl.searchParams.delete('files');
      debugPickUrl.searchParams.append('files', 'debug/unrelated-debug.json');
      const debugPickResponse = await requestBuffer(debugPickUrl, {
        Authorization: 'Bearer forensics-test-key',
      });
      assert.equal(debugPickResponse.statusCode, 200);
      assert.deepEqual(listZipEntryNames(debugPickResponse.body), [
        'manifest.json',
        'debug/unrelated-debug.json',
      ]);

      const rootUrl = new URL(`http://127.0.0.1:${port}/api/dialog-forensics.zip`);
      rootUrl.searchParams.set('rootId', rootId);
      rootUrl.searchParams.set('course', '21');
      const rootResponse = await requestBuffer(rootUrl, {
        Authorization: 'Bearer forensics-test-key',
      });
      assert.equal(rootResponse.statusCode, 200);
      const rootNames = listZipEntryNames(rootResponse.body);
      assert.ok(rootNames.includes('dialog/latest.yaml'));
      assert.ok(rootNames.includes('dialog/course-021.jsonl'));
      assert.equal(
        rootNames.some((name) => name.startsWith('dialog/sideDialogs/')),
        false,
      );
    } finally {
      await server.stop();
    }
  } finally {
    process.chdir(previousCwd);
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
