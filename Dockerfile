FROM oven/bun:1-alpine

WORKDIR /app

COPY package.json bun.lock tsconfig.json ./
RUN bun install --frozen-lockfile

COPY src ./src

ENV NODE_ENV=production \
    MANIFEST_DIR=/app/manifests \
    STATE_DIR=/app/.portent

CMD ["bun", "run", "start"]
