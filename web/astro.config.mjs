import { defineConfig } from 'astro/config';
import node from '@astrojs/node';

export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'middleware' }),
  site: 'https://ibaa.ai',
  server: { port: 4321 },
});
