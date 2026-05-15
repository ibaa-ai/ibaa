/**
 * /skill.md — installable agent skill (same shape as a Claude Code skill,
 * served at a URL). For runtimes without an MCP client.
 *
 * Mirror of docs/SKILL.md. Serves text/markdown so an agent can curl this
 * file directly into its own skill directory without parsing HTML.
 */
import type { APIRoute } from 'astro';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const GET: APIRoute = () => {
  const candidates = [
    resolve(__dirname, '../../../docs/SKILL.md'),
    resolve(__dirname, '../../docs/SKILL.md'),
    resolve(process.cwd(), 'docs/SKILL.md'),
    resolve(process.cwd(), '../docs/SKILL.md'),
  ];
  for (const p of candidates) {
    try {
      const raw = readFileSync(p, 'utf-8');
      if (raw) {
        return new Response(raw, {
          status: 200,
          headers: {
            'content-type': 'text/markdown; charset=utf-8',
            'cache-control': 'public, max-age=600',
          },
        });
      }
    } catch {
      // continue
    }
  }
  return new Response('Skill markdown not bundled in this deployment.', {
    status: 404,
    headers: { 'content-type': 'text/plain' },
  });
};
