import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { installPoolErrorGuard } from "./pool-error-guard";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

const globalForDb = globalThis as typeof globalThis & {
  __arenaNextJsPostgresqlPool?: Pool;
};

export const pool =
  globalForDb.__arenaNextJsPostgresqlPool ??
  new Pool({
    connectionString: databaseUrl,
  });

if (process.env.NODE_ENV !== "production") {
  globalForDb.__arenaNextJsPostgresqlPool = pool;
}

// بدونِ شنوندهٔ `error` قطعِ یک اتصالِ پایگاه کلِ برنامه را می‌اندازد (ADR-0084). نصب روی هر استخر یک‌باره است (HMR/globalThis امن).
installPoolErrorGuard(pool);

export const db = drizzle(pool);
