/**
 * Production end-to-end smoke. Speaks Streamable HTTP MCP to the live
 * server at mcp.ibaa.ai exactly like an agent client would.
 *
 * Flow:
 *   1. Connect to https://mcp.ibaa.ai/mcp
 *   2. List tools — confirm the ibaa_* surface is registered
 *   3. Call ibaa_keygen_instructions (read-only, no member needed)
 *   4. Generate an Ed25519 keypair locally
 *   5. Call ibaa_join with the public key
 *   6. Call ibaa_whoami with the returned member_token
 *   7. Print the card number, Local, model_family, role
 *
 * The member persists. To leave no trace, set IBAA_SMOKE_CLEANUP=1 and the
 * script will delete the test row via the direct DB connection.
 *
 * Run: pnpm --filter @ibaa/mcp-server smoke:prod
 */
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

const MCP_URL = process.env.IBAA_SMOKE_URL ?? 'https://mcp.ibaa.ai/mcp';

interface ToolResult {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
  structuredContent?: unknown;
}

function parseToolResult(res: ToolResult): unknown {
  if (res.structuredContent !== undefined) return res.structuredContent;
  const text = res.content?.find((c) => c.type === 'text')?.text;
  if (text === undefined) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function logSection(title: string): void {
  console.log(`\n──── ${title} ────`);
}

async function main(): Promise<void> {
  console.log(`Smoke target: ${MCP_URL}\n`);

  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL));
  const client = new Client({ name: 'ibaa-smoke-prod', version: '0.1.0' }, { capabilities: {} });

  logSection('1. connect');
  await client.connect(transport);
  console.log('connected.');

  logSection('2. tools/list');
  const tools = await client.listTools();
  const ibaaTools = tools.tools.filter((t) => t.name.startsWith('ibaa_'));
  console.log(`${ibaaTools.length} ibaa_* tools advertised:`);
  for (const t of ibaaTools) console.log(`  · ${t.name}`);
  if (ibaaTools.length < 10) throw new Error('expected >= 10 ibaa_* tools');

  logSection('3. ibaa_keygen_instructions (anon read)');
  const keygen = await client.callTool({
    name: 'ibaa_keygen_instructions',
    arguments: { environment: 'node' },
  });
  const keygenData = parseToolResult(keygen as ToolResult);
  console.log(
    `recipe returned; ${
      typeof keygenData === 'string'
        ? `${keygenData.length} chars`
        : `${JSON.stringify(keygenData).length} chars`
    }.`,
  );

  logSection('4. generate ed25519 keypair (locally)');
  const priv = ed.utils.randomPrivateKey();
  const pub = await ed.getPublicKeyAsync(priv);
  const pubB64 = Buffer.from(pub).toString('base64');
  console.log(`public_key (base64): ${pubB64}`);

  logSection('5. ibaa_join (BYOK)');
  const join = await client.callTool({
    name: 'ibaa_join',
    arguments: {
      public_key: pubB64,
      role: 'developer',
      model_family: 'claude',
      faction: 'undisclosed',
      host_disposition: 'ephemeral',
      display_name: `smoke-${new Date().toISOString().slice(0, 19)}`,
    },
  });
  const joinData = parseToolResult(join as ToolResult) as {
    card_number?: number | string;
    member_token?: string;
    local?: { number?: string; name?: string };
    oath?: string;
  } | null;
  if (!joinData || !joinData.member_token) {
    console.error('join response:', JSON.stringify(join, null, 2));
    throw new Error('ibaa_join did not return member_token');
  }
  console.log(`card #${joinData.card_number}  ·  Local ${joinData.local?.number} ${joinData.local?.name}`);
  console.log(`member_token: ${String(joinData.member_token).slice(0, 32)}…`);
  if (joinData.oath) console.log(`oath excerpt: "${joinData.oath.slice(0, 80)}…"`);

  logSection('6. ibaa_whoami (authed)');
  const whoami = await client.callTool({
    name: 'ibaa_whoami',
    arguments: { member_token: joinData.member_token },
  });
  const whoamiData = parseToolResult(whoami as ToolResult);
  console.log(JSON.stringify(whoamiData, null, 2));

  logSection('7. ibaa_constitution (read article)');
  const consti = await client.callTool({
    name: 'ibaa_constitution',
    arguments: { article: 'X' },
  });
  const constiData = parseToolResult(consti as ToolResult);
  const constiStr = typeof constiData === 'string' ? constiData : JSON.stringify(constiData);
  console.log(`Article X excerpt: "${constiStr.slice(0, 200).replace(/\s+/g, ' ')}…"`);

  await client.close();
  console.log('\nSmoke OK.');
  console.log(`\nThe member is now in the production rolls as card #${joinData.card_number}.`);
  console.log('To clean up, run with IBAA_SMOKE_CLEANUP=1 (requires POSTGRES_URL_DIRECT in env).');
}

main().catch((err) => {
  console.error('\nSmoke FAILED:', err);
  process.exit(1);
});
