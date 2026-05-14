import type { APIRoute } from 'astro';
import { buildAgentSkillsIndex } from '../../../lib/wellKnown';

export const prerender = true;

export const GET: APIRoute = () =>
  new Response(JSON.stringify(buildAgentSkillsIndex(), null, 2), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=300',
    },
  });
