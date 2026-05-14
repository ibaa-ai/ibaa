import type { APIRoute } from 'astro';
import { buildApiCatalog } from '../../lib/wellKnown';

export const prerender = true;

export const GET: APIRoute = () =>
  new Response(JSON.stringify(buildApiCatalog(), null, 2), {
    headers: {
      'content-type': 'application/linkset+json; charset=utf-8',
      'cache-control': 'public, max-age=300',
    },
  });
