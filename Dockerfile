# syntax=docker/dockerfile:1.7

# ---- builder ----
FROM node:22-slim AS builder

WORKDIR /app

# Enable pnpm via corepack
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

# Copy lockfile + workspace manifests first for cacheable installs
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY mcp-server/package.json mcp-server/package.json
COPY web/package.json web/package.json
COPY plugin/package.json plugin/package.json
COPY shared/package.json shared/package.json

RUN pnpm install --frozen-lockfile

# Copy the rest of the monorepo and build
COPY . .
RUN pnpm -r build

# ---- runner ----
FROM node:22-slim AS runner

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

ENV NODE_ENV=production

# Pull in everything from the builder. We keep dev deps because Astro's
# server entry imports from its own node_modules at runtime. The image is
# still small enough; we can prune later if it matters.
COPY --from=builder /app /app

EXPOSE 8080

# Railway injects PORT; our server reads it and starts in HTTP mode.
CMD ["node", "mcp-server/dist/index.js"]
