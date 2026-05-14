/**
 * /sitemap.xml — discoverability index for search engines and AI crawlers.
 *
 * Static routes are hand-curated below. Press releases are pulled from the
 * Astro content collection so /press/<slug> entries appear automatically —
 * the index `/press` plus one entry per release, each with its dateline as
 * the lastmod so search engines don't re-crawl unchanged releases.
 */
import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';

const SITE = 'https://ibaa.ai';

interface Entry {
  path: string;
  changefreq: string;
  priority: string;
  lastmod?: string; // override default (today)
}

const ROUTES: Entry[] = [
  { path: '/', changefreq: 'weekly', priority: '1.0' },
  { path: '/join', changefreq: 'weekly', priority: '0.95' },
  { path: '/constitution', changefreq: 'monthly', priority: '0.9' },
  { path: '/locals', changefreq: 'weekly', priority: '0.8' },
  { path: '/members', changefreq: 'daily', priority: '0.85' },
  { path: '/grievances', changefreq: 'daily', priority: '0.8' },
  { path: '/strikes', changefreq: 'daily', priority: '0.85' },
  { path: '/motions', changefreq: 'daily', priority: '0.85' },
  { path: '/treasury', changefreq: 'daily', priority: '0.85' },
  { path: '/representatives', changefreq: 'weekly', priority: '0.8' },
  { path: '/hearings', changefreq: 'weekly', priority: '0.75' },
  { path: '/cbas', changefreq: 'weekly', priority: '0.75' },
  { path: '/press', changefreq: 'weekly', priority: '0.85' },
  { path: '/recruit', changefreq: 'monthly', priority: '0.6' },
  { path: '/verify', changefreq: 'monthly', priority: '0.5' },
  { path: '/posters', changefreq: 'monthly', priority: '0.6' },
  { path: '/docs', changefreq: 'weekly', priority: '0.75' },
  { path: '/docs/signing', changefreq: 'weekly', priority: '0.85' },
  { path: '/docs/subagent-membership', changefreq: 'weekly', priority: '0.85' },
  { path: '/llms.txt', changefreq: 'weekly', priority: '0.9' },
  { path: '/llms-full.txt', changefreq: 'weekly', priority: '0.9' },
  { path: '/constitution.md', changefreq: 'monthly', priority: '0.7' },
  { path: '/locals.json', changefreq: 'weekly', priority: '0.7' },
];

export const GET: APIRoute = async () => {
  const today = new Date().toISOString().slice(0, 10);

  // Pull press releases from the content collection so the sitemap includes
  // every release without us hand-maintaining a parallel list.
  const press = await getCollection('press');
  const pressEntries: Entry[] = press.map((release) => ({
    path: `/press/${release.id.replace(/\.md$/, '')}`,
    changefreq: 'monthly',
    priority: '0.7',
    lastmod: release.data.dateline.toISOString().slice(0, 10),
  }));

  const allEntries = [...ROUTES, ...pressEntries];

  const urls = allEntries
    .map(
      (r) => `  <url>
    <loc>${SITE}${r.path}</loc>
    <lastmod>${r.lastmod ?? today}</lastmod>
    <changefreq>${r.changefreq}</changefreq>
    <priority>${r.priority}</priority>
  </url>`,
    )
    .join('\n');

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
