# abetConnect — production image from the verified standalone build.
#
# Layout mirrors what is already proven on this machine:
#   npm ci → prisma generate → next build → node .next/standalone/server.js
# The only difference is the DATABASE_URL it is pointed at (see compose.yml
# for the Postgres wiring, or mount /data for SQLite).

FROM node:20-alpine AS base
RUN apk add --no-cache libc6-compat openssl

FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci

FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Build-time only: collecting page data must not touch a real database.
ENV DATABASE_URL="file:./dev.db"
RUN npx prisma generate && npm run build

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
# Default to a persistent path; override per deploy. The migrate step in the
# entrypoint applies the committed history before the first request lands.
ENV DATABASE_URL="file:/data/dev.db"
ENV PORT=3000
RUN addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 nextjs \
 && mkdir -p /data && chown nextjs:nodejs /data
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/prisma ./prisma
# src/ + tsconfig travel too, for one reason only: the documented demo seed
# (`compose exec app npx tsx prisma/seed.ts`) resolves @/ imports through them.
COPY --from=builder --chown=nextjs:nodejs /app/src ./src
COPY --from=builder --chown=nextjs:nodejs /app/tsconfig.json ./tsconfig.json
# The whole tree the image was built and tested with — not a subset. A partial
# node_modules is how the prisma CLI lost its own dependencies mid-deploy.
COPY --from=deps --chown=nextjs:nodejs /app/node_modules ./node_modules
USER nextjs
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health | grep -q '"ok":true'
CMD ["sh", "-c", "npx prisma migrate deploy && node server.js"]
