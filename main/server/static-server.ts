/**
 * Module: server/static-server
 *
 * Static file serving functionality for production mode only
 * Development mode: Vite handles all static file serving
 * Production mode: Backend serves static files from dist/static
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

/**
 * Serve static files with mode-specific behavior
 */
export async function serveStatic(
  pathname: string,
  res: ServerResponse,
  options: StaticServerOptions,
): Promise<boolean> {
  try {
    // In development mode, Vite handles all static file serving
    // Backend only serves API routes and WebSocket connections
    if (options.mode === 'development') {
      // Provide helpful message for root endpoint in dev mode
      if (pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`Dominds Backend Server (Development Mode)

API Server running on port 5556
Frontend (Vite dev server) should be on port 5555

Available API endpoints:
• GET /api/health - Server health check
• GET /api/live-reload - Development status
• GET /api/team/config - Team configuration
• GET /api/dialogs - List all dialogs
• POST /api/dialogs - Create new dialog
• GET /api/dialogs/:id - Get specific dialog
• GET /api/dialogs/:root/:self/hierarchy - Get dialog hierarchy
• GET /api/task-documents - Taskdoc listing

WebSocket: ws://localhost:5556/ws

Frontend URL: http://localhost:5555/
Backend API: http://localhost:5556/api/
`);
        return true;
      }
      return false; // Let Vite handle static files
    }

    // Production mode: serve from staticDir
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
          return await sendFile(indexPath, res, '.html');
        }
      }
      return false;
    }

    const ext = extname(filePath);
    return await sendFile(filePath, res, ext);
  } catch (error) {
    log.error('Error serving static file:', error);
    return false;
  }
}

/**
 * Send a file with appropriate headers
 */
async function sendFile(filePath: string, res: ServerResponse, ext: string): Promise<boolean> {
  try {
    const mimeType = getMimeType(ext);
    const stats = await fsPromises.stat(filePath);

    res.writeHead(200, {
      'Content-Type': mimeType,
      'Content-Length': stats.size,
      'Cache-Control': 'no-cache', // Disable caching for development
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
 * Send HTML file with mode-specific processing
 */
export async function sendHtml(
  filePath: string,
  res: ServerResponse,
  mode: 'development' | 'production',
): Promise<void> {
  try {
    const content = await fsPromises.readFile(filePath, 'utf8');

    // No special processing needed - Vite handles HMR in development
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(content);
  } catch (error) {
    log.error(`Error sending HTML file ${filePath}:`, error);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Internal Server Error');
  }
}
