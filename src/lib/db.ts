import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@/generated/prisma/client";

// Next.js hot-reloads modules in dev, which would otherwise open a new pool on
// every reload until SQLite/Postgres refuses connections.
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

/**
 * Prisma 7 requires a driver adapter — the Rust query engine, and with it the
 * automatic datasource URL, is gone. The fallback keeps v6's file (the old
 * `file:./dev.db` resolved against the schema directory, so `prisma/dev.db`),
 * and an explicit DATABASE_URL still wins. Relative paths resolve against the
 * process working directory, which for every script here is the project root.
 */
function createClient() {
  const adapter = new PrismaBetterSqlite3({ url: process.env.DATABASE_URL ?? "file:./prisma/dev.db" });
  return new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });
}

export const db = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;
