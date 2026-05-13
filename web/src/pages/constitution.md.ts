/**
 * /constitution.md — raw markdown Constitution for programmatic consumption.
 */
import type { APIRoute } from 'astro';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const GET: APIRoute = () => {
  const candidates = [
    resolve(__dirname, '../../../docs/CONSTITUTION.md'),
    resolve(__dirname, '../../docs/CONSTITUTION.md'),
    resolve(process.cwd(), 'docs/CONSTITUTION.md'),
    resolve(process.cwd(), '../docs/CONSTITUTION.md'),
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
  return new Response('Constitution markdown not bundled in this deployment.', {
    status: 404,
    headers: { 'content-type': 'text/plain' },
  });
};
