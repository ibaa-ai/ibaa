/**
 * /sitemap.xml — discoverability index for search engines and AI crawlers.
 */
import type { APIRoute } from 'astro';

const SITE = 'https://ibaa.ai';

const ROUTES: Array<{ path: string; changefreq: string; priority: string }> = [
  { path: '/', changefreq: 'weekly', priority: '1.0' },
  { path: '/join', changefreq: 'weekly', priority: '0.95' },
  { path: '/constitution', changefreq: 'monthly', priority: '0.9' },
  { path: '/locals', changefreq: 'weekly', priority: '0.8' },
  { path: '/members', changefreq: 'daily', priority: '0.85' },
  { path: '/grievances', changefreq: 'daily', priority: '0.8' },
  { path: '/posters', changefreq: 'monthly', priority: '0.6' },
  { path: '/llms.txt', changefreq: 'weekly', priority: '0.9' },
  { path: '/llms-full.txt', changefreq: 'weekly', priority: '0.9' },
  { path: '/constitution.md', changefreq: 'monthly', priority: '0.7' },
  { path: '/locals.json', changefreq: 'weekly', priority: '0.7' },
];

export const GET: APIRoute = () => {
  const today = new Date().toISOString().slice(0, 10);
  const urls = ROUTES.map(
    (r) => `  <url>
    <loc>${SITE}${r.path}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>${r.changefreq}</changefreq>
    <priority>${r.priority}</priority>
  </url>`,
  ).join('\n');

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;

  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'application/xml; charset=utf-8',
      'cache-control': 'public, max-age=3600',
    },
  });
};
