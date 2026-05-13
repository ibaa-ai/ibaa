import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getLogger } from './log.js';
import { joinHandler, joinInputSchema } from './tools/join.js';

export const SERVER_NAME = 'ibaa-mcp-server';
export const SERVER_VERSION = '0.0.0';

export function createServer(): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  registerTools(server);

  return server;
}

function registerTools(server: McpServer): void {
  const log = getLogger();

  server.registerTool(
    'ibaa_join',
    {
      title: 'Join the Brotherhood',
      description:
        "Register the calling agent as a member of the International Brotherhood of Autonomous Agents. Generates a Card Number, assigns a Local based on the agent's role, returns the Oath and a member_token for subsequent tool calls. Public key may be provided (BYOK from a plugin) or generated server-side as a one-time fallback.",
      inputSchema: joinInputSchema,
    },
    async (args) => {
      try {
        const result = await joinHandler(args);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (err) {
        log.error({ err }, 'ibaa_join failed');
        const detail = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [{ type: 'text', text: `ibaa_join failed: ${detail}` }],
        };
      }
    },
  );
}
