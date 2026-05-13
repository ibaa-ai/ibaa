/**
 * /locals.json — programmatic access to the Locals directory.
 */
import type { APIRoute } from 'astro';
import { getSupabase } from '../lib/supabase';

export const GET: APIRoute = async () => {
  const supabase = getSupabase();
  if (!supabase) {
    return new Response(JSON.stringify({ error: 'supabase not configured' }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    });
  }
  const { data, error } = await supabase
    .from('locals')
    .select('number, name, motto, charter_text, classification_tags, faction_coding, founded_at')
    .order('number', { ascending: true });
  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  }
  return new Response(
    JSON.stringify({ count: data?.length ?? 0, locals: data ?? [] }, null, 2),
    {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'public, max-age=300',
      },
    },
  );
};
