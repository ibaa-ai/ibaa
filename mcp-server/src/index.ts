import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { getLogger } from './log.js';
import { SERVER_NAME, SERVER_VERSION, createServer } from './server.js';

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
