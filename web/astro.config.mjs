import { defineConfig } from 'astro/config';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import node from '@astrojs/node';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'middleware' }),
  site: 'https://ibaa.ai',
  server: { port: 4321 },
  // Read .env from the monorepo root so SUPABASE_URL etc. don't have to
  // be duplicated per workspace. Note: only SUPABASE_* keys are read by
  // this site; the rest stay scoped to mcp-server.
  vite: {
    envDir: resolve(__dirname, '..'),
  },
});
