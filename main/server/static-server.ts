/**
 * Module: server/static-server
 *
 * Static file serving functionality for WebUI dist assets.
 * Development and production both serve the same static build output.
 */
import { createReadStream, existsSync, promises as fsPromises } from 'fs';
import { ServerResponse } from 'http';
import { extname, join, resolve } from 'path';
import { createLogger } from '../log';
import { getMimeType } from './mime-types';

const log = createLogger('static-server');

export interface StaticServerOptions {
  mode: 'development' | 'production';
  domindsInstallRoot: string; // Where dominds code files live (not runtime workspace)
  staticDir: string;
}

function isFingerprintedAssetPath(pathname: string): boolean {
  return /^\/assets\/.+-[A-Z0-9]{8,}\.[A-Za-z0-9]+$/.test(pathname);
}

function getStaticCacheControl(pathname: string, ext: string): string {
  if (ext === '.html') {
    return 'no-store';
  }
  if (isFingerprintedAssetPath(pathname)) {
    return 'public, max-age=31536000, immutable';
  }
  return 'no-cache';
}

/**
 * Serve static files from the webapp build output.
 */
export async function serveStatic(
  pathname: string,
  res: ServerResponse,
  options: StaticServerOptions,
): Promise<boolean> {
  try {
    let filePath: string;
    const staticDir = resolve(options.domindsInstallRoot, options.staticDir);

    if (pathname === '/' || pathname === '/index.html') {
      filePath = join(staticDir, 'index.html');
    } else {
      // Remove leading slash and join with static directory
      filePath = join(staticDir, pathname.slice(1));
    }

    // Security check: ensure file is within allowed directories
    const resolvedPath = resolve(filePath);
    const allowedPath = staticDir;

    if (!resolvedPath.startsWith(allowedPath)) {
      log.warn(`Access denied to file outside allowed paths: ${resolvedPath}`);
      return false;
    }

    if (!existsSync(filePath)) {
      // SPA fallback: serve index.html for client-side routes (e.g. /setup).
      // Only apply when the request path does not look like a static asset.
      const lastSeg =
        pathname
          .split('/')
          .filter((s) => s !== '')
          .slice(-1)[0] ?? '';
      const looksLikeAsset = lastSeg.includes('.');
      if (!looksLikeAsset) {
        const indexPath = join(staticDir, 'index.html');
        if (existsSync(indexPath)) {
          return await sendFile(indexPath, res, '.html', '/index.html');
        }
      }
      return false;
    }

    const ext = extname(filePath);
    return await sendFile(filePath, res, ext, pathname);
  } catch (error) {
    log.error('Error serving static file:', error);
    return false;
  }
}

/**
 * Send a file with appropriate headers
 */
async function sendFile(
  filePath: string,
  res: ServerResponse,
  ext: string,
  pathname: string,
): Promise<boolean> {
  try {
    const mimeType = getMimeType(ext);
    const stats = await fsPromises.stat(filePath);

    res.writeHead(200, {
      'Content-Type': mimeType,
      'Content-Length': stats.size,
      'Cache-Control': getStaticCacheControl(pathname, ext),
    });

    const stream = createReadStream(filePath);
    stream.pipe(res);

    return new Promise((resolve, reject) => {
      stream.on('end', () => resolve(true));
      stream.on('error', reject);
    });
  } catch (error) {
    log.error(`Error sending file ${filePath}:`, error);
    return false;
  }
}

/**
 * Send an HTML file.
 */
export async function sendHtml(
  filePath: string,
  res: ServerResponse,
  mode: 'development' | 'production',
): Promise<void> {
  try {
    const content = await fsPromises.readFile(filePath, 'utf8');

    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(content);
  } catch (error) {
    log.error(`Error sending HTML file ${filePath}:`, error);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Internal Server Error');
  }
}
