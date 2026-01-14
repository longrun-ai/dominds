/**
 * Module: server/server-core
 *
 * Core HTTP server functionality shared between production and development servers
 */
import * as http from 'http';
import { IncomingMessage, ServerResponse } from 'http';
import * as path from 'path';
import type { ParsedUrlQuery } from 'querystring';
import * as url from 'url';
import type { WebSocket } from 'ws';
import { createLogger } from '../log';
import { ApiRouteContext, handleApiRoute } from './api-routes';
import type { AuthConfig } from './auth';
import { getHttpAuthCheck } from './auth';
import { serveStatic } from './static-server';

const log = createLogger('server-core');

export interface ServerConfig {
  port: number;
  host: string;
  mode: 'development' | 'production';
  clients?: Set<WebSocket>;
  staticRoot?: string;
  enableLiveReload?: boolean;
  auth?: AuthConfig;
}

export interface RequestHandler {
  (
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
    query: ParsedUrlQuery,
  ): Promise<boolean>;
}

/**
 * Core HTTP server class
 */
export class HttpServerCore {
  private server: http.Server;
  private config: ServerConfig;
  private customHandlers: RequestHandler[] = [];

  constructor(config: ServerConfig) {
    this.config = config;
    this.server = http.createServer(this.handleRequest.bind(this));
  }

  /**
   * Add custom request handler
   */
  addHandler(handler: RequestHandler): void {
    this.customHandlers.push(handler);
  }

  /**
   * Main request handler
   */
  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const parsedUrl = url.parse(req.url || '', true);
      const pathname = parsedUrl.pathname || '/';
      const query = parsedUrl.query;

      // Set CORS headers for development
      if (this.config.mode === 'development') {
        this.setCorsHeaders(res);
      }

      // Handle preflight requests
      if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
      }

      // Try custom handlers first
      for (const handler of this.customHandlers) {
        if (await handler(req, res, pathname, query)) {
          return;
        }
      }

      // Handle API routes
      if (pathname.startsWith('/api/')) {
        const authCheck = getHttpAuthCheck(req, this.config.auth ?? { kind: 'disabled' });
        if (authCheck.kind !== 'ok') {
          this.sendUnauthorized(res);
          return;
        }

        const apiContext: ApiRouteContext = {
          clients: this.config.clients,
          mode: this.config.mode,
        };

        if (await handleApiRoute(req, res, pathname, apiContext)) {
          return;
        }
      }

      // Handle static files
      const staticHandled = await serveStatic(pathname, res, {
        mode: this.config.mode,
        domindsInstallRoot: this.resolveDomindsInstallRoot(),
        staticDir: this.config.staticRoot || 'dist',
      });

      // If no handler processed the request, send 404
      if (!staticHandled) {
        this.sendError(res, 404, 'Not Found');
      }
    } catch (error) {
      log.error('Error handling request:', error);
      this.sendError(res, 500, 'Internal Server Error');
    }
  }

  /**
   * Set CORS headers for development
   */
  private setCorsHeaders(res: ServerResponse): void {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }

  /**
   * Send error response
   */
  private sendError(res: ServerResponse, statusCode: number, message: string): void {
    if (!res.headersSent) {
      res.writeHead(statusCode, { 'Content-Type': 'text/plain' });
      res.end(message);
    }
  }

  private sendUnauthorized(res: ServerResponse): void {
    if (res.headersSent) return;
    res.writeHead(401, {
      'Content-Type': 'application/json',
      'WWW-Authenticate': 'Bearer',
    });
    res.end(JSON.stringify({ error: 'unauthorized' }));
  }

  /**
   * Start the server - NO PORT FALLBACK, enforce specific port
   */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.on('error', (error) => {
        reject(error);
      });

      this.server.listen(this.config.port, this.config.host, () => {
        log.debug(`Server listening on http://${this.config.host}:${this.config.port}`);
        resolve();
      });
    });
  }

  /**
   * Stop the server
   */
  stop(): Promise<void> {
    return new Promise((resolve) => {
      this.server.close(() => {
        log.info('Server stopped');
        resolve();
      });
    });
  }

  /**
   * Get the underlying HTTP server
   */
  getHttpServer(): http.Server {
    return this.server;
  }

  /**
   * Resolve dominds installation root
   */
  private resolveDomindsInstallRoot(): string {
    // __dirname is either main/server (source) or dist/server (compiled)
    // Go up two levels to reach the project root
    return path.resolve(__dirname, '..', '..');
  }
}

/**
 * Create and configure HTTP server
 */
export function createHttpServer(config: ServerConfig): HttpServerCore {
  return new HttpServerCore(config);
}

/**
 * Utility function to parse request body as JSON
 */
export function parseJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    let body = '';

    req.on('data', (chunk) => {
      body += chunk.toString();
    });

    req.on('end', () => {
      try {
        const parsed = body ? JSON.parse(body) : {};
        resolve(parsed);
      } catch (error) {
        reject(new Error('Invalid JSON'));
      }
    });

    req.on('error', reject);
  });
}

/**
 * Utility function to send JSON response
 */
export function sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
  if (!res.headersSent) {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }
}

/**
 * Utility function to send text response
 */
export function sendText(res: ServerResponse, statusCode: number, text: string): void {
  if (!res.headersSent) {
    res.writeHead(statusCode, { 'Content-Type': 'text/plain' });
    res.end(text);
  }
}
