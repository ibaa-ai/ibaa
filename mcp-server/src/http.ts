/**
 * HTTP server entrypoint.
 *
 * Routes:
 *   /healthz        → 200 OK with service status
 *   /mcp            → StreamableHTTPServerTransport (the MCP wire protocol)
 *   everything else → Hono handler (Astro middleware will mount here in Phase 6)
 *
 * The MCP SDK's StreamableHTTPServerTransport speaks Node's IncomingMessage /
 * ServerResponse, so we build the server with Node's built-in http module and
 * delegate non-MCP requests to Hono via its Node adapter.
 */
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { logger as honoLogger } from 'hono/logger';
import { getRequestListener } from '@hono/node-server';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { loadEnv } from './env.js';
import { getLogger } from './log.js';
import { SERVER_NAME, SERVER_VERSION, createServer as createMcpServer } from './server.js';

interface HealthStatus {
  ok: boolean;
  version: string;
  service: string;
  services: { mcp: 'up' | 'down'; web: 'up' | 'pending-phase-6' | 'down' };
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

  // === Hono app for non-MCP routes ===
  const app = new Hono();
  app.use('*', honoLogger((message) => log.debug(message)));

  app.get('/healthz', (c) => {
    const status: HealthStatus = {
      ok: true,
      version: SERVER_VERSION,
      service: SERVER_NAME,
      services: { mcp: 'up', web: 'pending-phase-6' },
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

  // === Node HTTP server that routes /mcp to the MCP transport ===
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (url.pathname === '/mcp' || url.pathname.startsWith('/mcp/')) {
      try {
        let parsedBody: unknown;
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
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
        await mcpTransport.handleRequest(req, res, parsedBody);
      } catch (err) {
        log.error({ err }, 'MCP transport error');
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'internal MCP error' }));
        }
      }
      return;
    }

    // Everything else: hand off to Hono
    return honoListener(req, res);
  });

  server.listen(env.PORT, () => {
    log.info(
      { port: env.PORT, transport: 'http', node_env: env.NODE_ENV },
      `${SERVER_NAME}@${SERVER_VERSION} listening`,
    );
  });

  // Graceful shutdown
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
