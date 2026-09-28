FROM docker.io/oven/bun:1-alpine AS build
WORKDIR /app
COPY package.json bun.lock tsconfig.json ./
RUN bun install --frozen-lockfile
COPY scripts ./scripts
COPY src ./src
RUN bun run build

FROM docker.io/oven/bun:1-alpine
WORKDIR /app
COPY --from=build /app/dist ./
ENV NODE_ENV=production \
    MANIFEST_DIR=/app/manifests \
    STATE_DIR=/app/.portent
CMD ["bun", "run", "start"]
