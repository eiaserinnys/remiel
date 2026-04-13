import pg from "pg";

let pool: pg.Pool | null = null;

export function getPool(connectionString?: string): pg.Pool {
  if (pool) return pool;
  const url = connectionString ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is required");
  }
  pool = new pg.Pool({ connectionString: url });
  return pool;
}

export function resetPool(): void {
  pool = null;
}
