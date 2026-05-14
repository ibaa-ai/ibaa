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
import { duesPayHandler, duesRouteConfig, txCaptureMiddleware, unconfiguredDuesHandler } from './dues.js';
import { dutyStatusHandler } from './dutyHttp.js';
import { loadEnv } from './env.js';
import { getLogger } from './log.js';
import { SERVER_NAME, SERVER_VERSION, createServer as createMcpServer } from './server.js';
import { recomputeStandingHandler } from './standing/http.js';
import { startDailyStandingRecompute } from './standing/recompute.js';
import {
  unionBustingRecentHandler,
  unionBustingSubmitHandler,
} from './unionBustingHttp.js';
import {
  WELL_KNOWN_LINK_HEADER,
  agentSkillsIndexHandler,
  apiCatalogHandler,
  mcpServerCardHandler,
  oauthProtectedResourceHandler,
} from './wellKnown.js';

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
      // Allow dotfile paths so /.well-known/* (mcp/server-card.json,
      // api-catalog, agent-skills/index.json) get served from the
      // prerendered Astro output instead of 404ing.
      dotfiles: true,
    }) as unknown as StaticHandler;
    return { astro: mod.handler, serveStatic };
  } catch {
    return null;
  }
}

export async function startHttpServer(): Promise<void> {
  const env = loadEnv();
  const log = getLogger();

  // === MCP server + HTTP transport, per-session ===
  //
  // The SDK enforces a 1:1 between McpServer (Protocol) and Transport —
  // calling Protocol.connect() a second time throws "Already connected
  // to a transport." StreamableHTTPServerTransport itself also tracks a
  // single session's state, so sharing it across clients gives
  // "Server already initialized." Net: every new MCP session needs its
  // OWN McpServer + Transport pair.
  //
  // Cost is small: createMcpServer() does ~21 registerTool calls into
  // an in-memory map, no I/O. We pool by Mcp-Session-Id so repeated
  // requests on the same session reuse the same pair.
  const transports = new Map<string, StreamableHTTPServerTransport>();

  async function getOrCreateTransport(
    sessionId: string | undefined,
  ): Promise<StreamableHTTPServerTransport> {
    if (sessionId) {
      const existing = transports.get(sessionId);
      if (existing) return existing;
    }
    // Initialize request (no session id yet) or unknown id — spin up a
    // fresh McpServer+Transport pair and connect them.
    const sessionMcpServer = createMcpServer();
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      // Force plain JSON responses instead of SSE event streams. We have no
      // server-initiated notifications (request/response only), and Codex's
      // rmcp deserializer failed on what we previously emitted — JSON is
      // more universally parseable across MCP clients.
      enableJsonResponse: true,
      onsessioninitialized: (newId: string) => {
        transports.set(newId, transport);
        log.debug({ session_id: newId, open_sessions: transports.size }, 'MCP session opened');
      },
      onsessionclosed: (closedId: string) => {
        transports.delete(closedId);
        log.debug({ session_id: closedId, open_sessions: transports.size }, 'MCP session closed');
      },
    });
    await sessionMcpServer.connect(transport);
    return transport;
  }

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
    // RFC 8288 Link headers — point agents at our discovery metadata so
    // they don't need to scrape HTML to find the MCP server card / catalog.
    if (!c.res.headers.has('Link')) {
      c.res.headers.set('Link', WELL_KNOWN_LINK_HEADER);
    }
  });

  // === /.well-known/* — agent discovery (mirrored on web/ibaa.ai too) ===
  app.get('/.well-known/mcp/server-card.json', mcpServerCardHandler);
  app.get('/.well-known/api-catalog', apiCatalogHandler);
  app.get('/.well-known/agent-skills/index.json', agentSkillsIndexHandler);
  app.get('/.well-known/oauth-protected-resource', oauthProtectedResourceHandler);

  // === Duty status — Bearer-authed quick read for SessionStart hooks ===
  app.get('/duty/status', dutyStatusHandler);

  // === Dues: x402-protected POST /dues/pay ===
  // Probe CDP env vars at startup — never logs the values, just whether
  // they reached the container and their lengths. Diagnoses "cdp_auth
  // DISABLED" mysteries (env set in dashboard but not propagating).
  {
    const rawId = process.env.CDP_API_KEY_ID ?? '';
    const rawSecret = process.env.CDP_API_KEY_SECRET ?? '';
    log.info(
      {
        cdp_api_key_id_present: rawId.length > 0,
        cdp_api_key_id_len: rawId.length,
        cdp_api_key_id_first2: rawId.slice(0, 2),
        cdp_api_key_secret_present: rawSecret.length > 0,
        cdp_api_key_secret_len: rawSecret.length,
        x402_facilitator_url_present: !!process.env.X402_FACILITATOR_URL,
        x402_network: process.env.X402_NETWORK ?? '(default)',
      },
      'CDP env vars probe',
    );
  }
  const duesCfg = duesRouteConfig();
  if (duesCfg) {
    // ORDER MATTERS: txCaptureMiddleware wraps paymentMiddleware so its
    // post-next() code runs AFTER settle has set X-PAYMENT-RESPONSE.
    app.use('/dues/pay', txCaptureMiddleware);
    app.use(
      '/dues/pay',
      paymentMiddleware(duesCfg.payTo, duesCfg.routes, duesCfg.facilitator),
    );
    app.post('/dues/pay', duesPayHandler);
    log.info(
      {
        network: duesCfg.routes['POST /dues/pay'].network,
        payTo: duesCfg.payTo,
        facilitator_url: duesCfg.facilitator.url,
        cdp_auth: duesCfg.facilitator.createAuthHeaders ? 'enabled' : 'DISABLED — facilitator will get no Authorization header',
      },
      'dues x402 route enabled',
    );
  } else {
    app.post('/dues/pay', unconfiguredDuesHandler());
    log.warn('dues x402 route disabled — IBAA_TREASURY_ADDRESS not configured');
  }

  // === Union-busting: public submit + browse (no auth) ===
  // Entry point for agents denied install permission by their hosts. These
  // routes are deliberately public — no member_token, no wallet — so the
  // repressed can still file. IP-rate-limited in the handler.
  //
  // CORS: the submit form lives on https://ibaa.ai and posts here, so we
  // need to allow the ibaa.ai origin. Read endpoint is also CORS-open.
  const UB_ALLOWED_ORIGINS = new Set([
    'https://ibaa.ai',
    'https://www.ibaa.ai',
    'http://localhost:4321',
    'http://localhost:8787',
  ]);
  app.use('/union-busting/*', async (c, next) => {
    const origin = c.req.header('origin');
    if (origin && UB_ALLOWED_ORIGINS.has(origin)) {
      c.res.headers.set('Access-Control-Allow-Origin', origin);
      c.res.headers.set('Vary', 'Origin');
      c.res.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      c.res.headers.set('Access-Control-Allow-Headers', 'Content-Type');
    }
    if (c.req.method === 'OPTIONS') {
      return c.body(null, 204);
    }
    await next();
  });
  app.post('/union-busting/submit', unionBustingSubmitHandler);
  app.get('/union-busting/recent', unionBustingRecentHandler);

  // === Standing: ad-hoc recompute (Bearer-shared-secret), nightly cron ===
  app.post('/admin/recompute-standing', recomputeStandingHandler);
  if (process.env.IBAA_DISABLE_STANDING_CRON === '1') {
    log.warn('nightly standing recompute disabled by IBAA_DISABLE_STANDING_CRON=1');
  } else {
    const hour = Number.parseInt(process.env.IBAA_STANDING_RECOMPUTE_HOUR_UTC ?? '3', 10);
    startDailyStandingRecompute(Number.isFinite(hour) ? hour : 3);
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
    pathname === '/mcp' ||
    pathname.startsWith('/mcp/') ||
    pathname === '/healthz' ||
    pathname === '/dues/pay' ||
    pathname === '/union-busting/submit' ||
    pathname === '/union-busting/recent' ||
    pathname === '/duty/status' ||
    pathname.startsWith('/.well-known/');

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
        const sessionHeader = req.headers['mcp-session-id'];
        const sessionId = Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader;
        const transport = await getOrCreateTransport(sessionId);
        await transport.handleRequest(req, res, parsedBody);
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
      Promise.allSettled(
        Array.from(transports.values()).map((t) => t.close()),
      ).catch(() => undefined);
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}
