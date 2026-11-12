# Build the platform-neutral dist-vps artifact locally first; install Linux runtime dependencies here.
FROM oven/bun:1.4.2-alpine AS dependencies
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
COPY patches ./patches
COPY apps/auth-api/package.json ./apps/auth-api/package.json
COPY packages/ui/package.json ./packages/ui/package.json
COPY packages/brand/package.json ./packages/brand/package.json
COPY packages/contracts/package.json ./packages/contracts/package.json
COPY packages/i18n/package.json ./packages/i18n/package.json
COPY packages/logging/package.json ./packages/logging/package.json
COPY packages/telemetry/package.json ./packages/telemetry/package.json
COPY packages/user-errors/package.json ./packages/user-errors/package.json
COPY packages/team-client/package.json ./packages/team-client/package.json
COPY packages/whatsapp/package.json ./packages/whatsapp/package.json
COPY remote/api/package.json ./remote/api/package.json
RUN bun install --production --ignore-scripts --frozen-lockfile --filter @openbot/auth-api

FROM oven/bun:1.4.2-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY LICENSE ./LICENSE
COPY --from=dependencies /app/node_modules ./node_modules
COPY packages ./packages
COPY apps/auth-api/package.json ./apps/auth-api/package.json
COPY apps/auth-api/dist-vps ./apps/auth-api/dist-vps
COPY apps/auth-api/migrations ./apps/auth-api/migrations
COPY apps/auth-api/src/vps ./apps/auth-api/src/vps
COPY apps/auth-api/src/server/runtime-env.ts ./apps/auth-api/src/server/runtime-env.ts
COPY apps/auth-api/vps/load-secrets.sh /usr/local/bin/openbot-secrets
USER bun
EXPOSE 3100
HEALTHCHECK --interval=15s --timeout=5s --retries=4 CMD bun -e 'const r=await fetch("http://127.0.0.1:3100/health/ready");process.exit(r.ok?0:1)'
ENTRYPOINT ["/bin/sh", "/usr/local/bin/openbot-secrets", "bun", "apps/auth-api/src/vps/main.ts"]
