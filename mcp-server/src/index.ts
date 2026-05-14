import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { getLogger } from './log.js';
import { SERVER_NAME, SERVER_VERSION, createServer } from './server.js';

// Bump the default 10-listener cap on shared event emitters (process,
// sockets, etc.). The MCP Streamable HTTP transport, Postgres pool, and
// x402 middleware each register their own close/error listeners — under
// load they pile up past 10 and Node prints noisy MaxListenersExceeded
// warnings. 50 gives headroom while still flagging a real leak if one
// blows past it. Run with `node --trace-warnings` to see the source.
process.setMaxListeners(50);

/**
 * Transport selection:
 *   - If PORT is set in env (Railway sets this automatically) → HTTP server
 *   - Otherwise → stdio (local dev, MCP client running us as a child process)
 */
async function main(): Promise<void> {
  const log = getLogger();

  if (process.env.PORT) {
    const { startHttpServer } = await import('./http.js');
    await startHttpServer();
    return;
  }

  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info({ transport: 'stdio' }, `${SERVER_NAME}@${SERVER_VERSION} connected`);
}

main().catch((err: unknown) => {
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`fatal: ${detail}\n`);
  process.exit(1);
});
