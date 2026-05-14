import { defineMiddleware, sequence } from 'astro:middleware';
import { buildHomepageMarkdown } from './lib/wellKnown';

/**
 * Agent-discoverability middleware.
 *
 * 1. Adds RFC 8288 Link headers pointing at our .well-known endpoints so
 *    crawlers can find the MCP server card / API catalog / skills index
 *    without scraping HTML.
 *
 * 2. Content negotiation: when Accept includes text/markdown, serve a
 *    markdown overview of the page instead of HTML. We only handle the
 *    homepage explicitly; other pages fall through to HTML for now
 *    (markdown for press/constitution can be added later).
 */

const LINK_HEADER = [
  '</.well-known/api-catalog>; rel="api-catalog"; type="application/linkset+json"',
  '</.well-known/mcp/server-card.json>; rel="service-desc"; type="application/json"',
  '</.well-known/agent-skills/index.json>; rel="https://agentskills.io/rel/index"; type="application/json"',
  '</constitution>; rel="service-doc"; type="text/html"',
  '<https://mcp.ibaa.ai/healthz>; rel="status"; type="application/json"',
].join(', ');

const linkHeaders = defineMiddleware(async (_ctx, next) => {
  const response = await next();
  // Only attach to HTML responses — JSON endpoints already self-describe.
  const ct = response.headers.get('content-type') ?? '';
  if (ct.startsWith('text/html')) {
    response.headers.set('Link', LINK_HEADER);
  }
  return response;
});

const markdownNegotiation = defineMiddleware(async (ctx, next) => {
  // Only the homepage participates in negotiation today. Cheap path check
  // first so we never read request.headers during prerender of other pages
  // (Astro warns when prerendered routes touch request.headers).
  const path = ctx.url.pathname;
  if (path !== '/' && path !== '/index') {
    return next();
  }
  const accept = ctx.request.headers.get('accept') ?? '';
  if (!accept.includes('text/markdown')) {
    return next();
  }
  return new Response(buildHomepageMarkdown(), {
    headers: {
      'content-type': 'text/markdown; charset=utf-8',
      'cache-control': 'public, max-age=300',
      Vary: 'Accept',
    },
  });
});

export const onRequest = sequence(markdownNegotiation, linkHeaders);
