import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { getLogger } from './log.js';
import { SERVER_NAME, SERVER_VERSION, createServer } from './server.js';

async function main(): Promise<void> {
  const log = getLogger();
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
