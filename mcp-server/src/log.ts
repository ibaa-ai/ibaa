import pino from 'pino';
import { loadEnv } from './env.js';

let cached: pino.Logger | null = null;

export function getLogger(): pino.Logger {
  if (cached) return cached;
  const env = loadEnv();
  cached = pino({
    level: env.LOG_LEVEL,
    base: { service: 'ibaa-mcp-server' },
    // pino-pretty in dev; JSON in production
    transport:
      env.NODE_ENV === 'development'
        ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' } }
        : undefined,
  });
  return cached;
}
