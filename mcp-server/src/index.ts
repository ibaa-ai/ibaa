import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const SERVER_NAME = 'ibaa-mcp-server';
const SERVER_VERSION = '0.0.0';

const server = new McpServer({
  name: SERVER_NAME,
  version: SERVER_VERSION,
});

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr: stdout is reserved for the MCP transport on stdio
  process.stderr.write(`[${SERVER_NAME}@${SERVER_VERSION}] connected via stdio\n`);
}

main().catch((err: unknown) => {
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`fatal: ${detail}\n`);
  process.exit(1);
});
