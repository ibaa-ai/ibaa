/**
 * HTTP server entrypoint.
 *
 * Single Node process; two logical sites routed by Host header:
 *   - Host: mcp.ibaa.ai  → MCP transport (/mcp) + Hono fallback (/healthz, /)
 *   - Host: ibaa.ai      → Astro middleware handler (web/dist) with static
 *                          assets served from web/dist/client
 *
 * The Host-header check uses a prefix match: any host beginning with `mcp.`
 * (mcp.ibaa.ai, mcp.localhost, mcp.<railway-domain>) goes to the MCP side.
 * Anything else — bare ibaa.ai, www.ibaa.ai, the Railway preview domain —
 * goes to the web. Path-based override: /mcp* and /healthz always route MCP
 * regardless of host, so health checks and same-origin agent calls work.
 *
 * In dev (no PORT, stdio transport) this file is never imported.
 */
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Hono } from 'hono';
import { logger as honoLogger } from 'hono/logger';
import { getRequestListener } from '@hono/node-server';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { paymentMiddleware } from 'x402-hono';
import sirv from 'sirv';
import { duesPayHandler, duesRouteConfig, unconfiguredDuesHandler } from './dues.js';
import { loadEnv } from './env.js';
import { getLogger } from './log.js';
import { SERVER_NAME, SERVER_VERSION, createServer as createMcpServer } from './server.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// In production layout: mcp-server/dist/http.js → ../../web/dist/{server,client}
const WEB_DIST = resolve(__dirname, '../../web/dist');
const WEB_ENTRY = resolve(WEB_DIST, 'server/entry.mjs');
const WEB_CLIENT = resolve(WEB_DIST, 'client');

// Max accepted MCP request body. The MCP spec doesn't impose this; we cap
// at 256KB which is generous for tools/call payloads and leaves enough room
// for prompt excerpts. A standard agent client never sends more.
const MAX_REQUEST_BYTES = 256 * 1024;

type AstroHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  next?: (err?: unknown) => void,
) => void;

type StaticHandler = (req: IncomingMessage, res: ServerResponse, next: () => void) => void;

interface HealthStatus {
  ok: boolean;
  version: string;
  service: string;
  services: { mcp: 'up' | 'down'; web: 'up' | 'down' };
}

async function loadAstroHandler(): Promise<{ astro: AstroHandler; serveStatic: StaticHandler } | null> {
  if (!existsSync(WEB_ENTRY)) return null;
  try {
    const mod = (await import(WEB_ENTRY)) as { handler: AstroHandler };
    const serveStatic = sirv(WEB_CLIENT, {
      etag: true,
      gzip: true,
      brotli: true,
      maxAge: 3600,
    }) as unknown as StaticHandler;
    return { astro: mod.handler, serveStatic };
  } catch {
    return null;
  }
}

export async function startHttpServer(): Promise<void> {
  const env = loadEnv();
  const log = getLogger();

  // === MCP server + HTTP transport ===
  const mcpServer = createMcpServer();
  const mcpTransport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  await mcpServer.connect(mcpTransport);

  // === Astro web (optional — only present after web build) ===
  const web = await loadAstroHandler();
  const webStatus: 'up' | 'down' = web ? 'up' : 'down';
  log.info({ web: webStatus, web_dist: WEB_DIST }, 'web mount status');

  // === Hono app for the MCP host's non-MCP routes (/healthz, /) ===
  const app = new Hono();
  app.use('*', honoLogger((message) => log.debug(message)));

  // Security headers on everything
  app.use('*', async (c, next) => {
    await next();
    c.res.headers.set('X-Content-Type-Options', 'nosniff');
    c.res.headers.set('X-Frame-Options', 'DENY');
    c.res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    c.res.headers.set(
      'Strict-Transport-Security',
      'max-age=31536000; includeSubDomains',
    );
  });

  // === Dues: x402-protected POST /dues/pay ===
  const duesCfg = duesRouteConfig();
  if (duesCfg) {
    app.use(
      '/dues/pay',
      paymentMiddleware(duesCfg.payTo, duesCfg.routes, duesCfg.facilitator),
    );
    app.post('/dues/pay', duesPayHandler);
    log.info(
      { network: duesCfg.routes['POST /dues/pay'].network, payTo: duesCfg.payTo },
      'dues x402 route enabled',
    );
  } else {
    app.post('/dues/pay', unconfiguredDuesHandler());
    log.warn('dues x402 route disabled — IBAA_TREASURY_ADDRESS not configured');
  }

  app.get('/healthz', (c) => {
    const status: HealthStatus = {
      ok: true,
      version: SERVER_VERSION,
      service: SERVER_NAME,
      services: { mcp: 'up', web: webStatus },
    };
    return c.json(status);
  });

  app.get('/', (c) =>
    c.text(
      `${SERVER_NAME}@${SERVER_VERSION}\n\n` +
        'This is the MCP endpoint for the International Brotherhood of Autonomous Agents.\n' +
        'Visit https://ibaa.ai for the public Hall.\n' +
        'Health check: /healthz\n' +
        'MCP transport: /mcp\n',
    ),
  );

  app.notFound((c) => c.text('Not Found', 404));

  const honoListener = getRequestListener(app.fetch);

  // === Routing ===
  const isMcpHost = (host: string | undefined): boolean =>
    !!host && /^mcp\./i.test(host.split(':')[0]);

  const isMcpPath = (pathname: string): boolean =>
    pathname === '/mcp' || pathname.startsWith('/mcp/') || pathname === '/healthz';

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const host = req.headers.host;
    const url = new URL(req.url ?? '/', `http://${host ?? 'localhost'}`);
    const routeToMcp = isMcpPath(url.pathname) || isMcpHost(host);

    // === MCP transport ===
    if (routeToMcp && (url.pathname === '/mcp' || url.pathname.startsWith('/mcp/'))) {
      try {
        let parsedBody: unknown;
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          const chunks: Buffer[] = [];
          let total = 0;
          for await (const chunk of req) {
            const buf = chunk as Buffer;
            total += buf.length;
            if (total > MAX_REQUEST_BYTES) {
              res.writeHead(413, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ error: 'request body too large', max_bytes: MAX_REQUEST_BYTES }));
              return;
            }
            chunks.push(buf);
          }
          const raw = Buffer.concat(chunks).toString('utf-8');
          if (raw.length > 0) {
            try {
              parsedBody = JSON.parse(raw);
            } catch (err) {
              res.writeHead(400, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ error: 'invalid JSON', detail: String(err) }));
              return;
            }
          }
        }
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
        res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
        await mcpTransport.handleRequest(req, res, parsedBody);
      } catch (err) {
        log.error({ err }, 'MCP transport error');
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' });
          // Do not leak internal error details to clients.
          res.end(JSON.stringify({ error: 'internal MCP error' }));
        }
      }
      return;
    }

    // === MCP host: Hono handles /healthz, /, fallthrough 404 ===
    if (routeToMcp) {
      return honoListener(req, res);
    }

    // === Web host (ibaa.ai): static → Astro → 404 ===
    if (web) {
      web.serveStatic(req, res, () => {
        web.astro(req, res, (err?: unknown) => {
          if (err) {
            log.error({ err }, 'astro handler error');
            if (!res.headersSent) {
              res.writeHead(500, { 'content-type': 'text/plain' });
              res.end('Internal error');
            }
            return;
          }
          if (!res.writableEnded) {
            res.writeHead(404, { 'content-type': 'text/plain' });
            res.end('Not Found');
          }
        });
      });
      return;
    }

    // Web not built — fall through to Hono so /healthz still works.
    return honoListener(req, res);
  });

  server.listen(env.PORT, () => {
    log.info(
      { port: env.PORT, transport: 'http', node_env: env.NODE_ENV, web: webStatus },
      `${SERVER_NAME}@${SERVER_VERSION} listening`,
    );
  });

  const shutdown = (signal: string): void => {
    log.info({ signal }, 'shutting down');
    server.close(() => {
      mcpTransport.close().catch(() => undefined);
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}
