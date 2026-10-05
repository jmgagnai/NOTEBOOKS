import { Pool } from "pg";

/**
 * Creates a `pg` connection pool. Per ADR-0003, the app talks to Postgres via
 * raw SQL (no ORM) so pgvector's `vector` column type and `<->`/`<=>`
 * operators stay first-class SQL rather than being wrapped by an ORM layer.
 */
export function createPool(connectionString: string): Pool {
  return new Pool({ connectionString });
}
