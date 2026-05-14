import type { APIRoute } from 'astro';
import { buildMcpServerCard } from '../../../lib/wellKnown';

export const prerender = true;

export const GET: APIRoute = () =>
  new Response(JSON.stringify(buildMcpServerCard(), null, 2), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=300',
    },
  });
