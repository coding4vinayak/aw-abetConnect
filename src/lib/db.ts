import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

// Next.js hot-reloads modules in dev, which would otherwise open a new pool on
// every reload until SQLite/Postgres refuses connections.
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

/**
 * Prisma 7 requires a driver adapter — the Rust query engine, and with it the
 * automatic datasource URL, is gone. Postgres is the only runtime database:
 * the fallback matches `docker-compose.yml`, so `docker compose up -d` is all
 * local development needs, and an explicit DATABASE_URL (production) wins.
 */
function createClient() {
  const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL ?? "postgresql://abetConnect:abetConnect@localhost:5432/abetConnect",
  });
  return new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });
}

export const db = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;
