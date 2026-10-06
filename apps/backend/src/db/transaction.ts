import type { Pool, PoolClient } from 'pg';

/**
 * Runs `work` on one connection inside a transaction, committing on success
 * and rolling back on any throw, and always releasing the connection.
 *
 * Every write in this codebase that spans more than one statement was
 * spelling this out: connect, `BEGIN`, the work, `COMMIT`, `catch` →
 * `ROLLBACK` and rethrow, `finally` → release. Six near-identical copies of a
 * shape where forgetting the `finally` leaks a connection out of the pool and
 * forgetting the `catch` leaves the transaction open — failures that show up
 * as the *next* request hanging, nowhere near the code that caused them.
 *
 * It takes a callback rather than returning a client on purpose: there is no
 * way to use it that forgets to close the transaction.
 *
 * Worth having in one place for a second reason specific to this app:
 * `pg_notify` is transactional, so "update the row and announce it" has to be
 * one transaction for a status nobody committed never to be announced — and
 * that pairing is what most of these transactions exist for.
 */
export async function inTransaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
