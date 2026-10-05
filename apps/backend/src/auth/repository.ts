import type { Pool } from "pg";
import type { User } from "./schema.js";

interface UserRow {
  id: string;
  email: string;
  created_at: Date;
}

interface UserRowWithHash extends UserRow {
  password_hash: string;
}

function toUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * Inserts a new user with an already-hashed password. Raw SQL per ADR-0003.
 * Throws (Postgres unique_violation, code 23505) if the email is already taken.
 */
export async function createUser(pool: Pool, email: string, passwordHash: string): Promise<User> {
  const { rows } = await pool.query<UserRow>(
    "INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email, created_at",
    [email, passwordHash],
  );
  return toUser(rows[0]);
}

/** Finds a user (with password hash) by email, for login verification. */
export async function findUserByEmailWithHash(
  pool: Pool,
  email: string,
): Promise<(User & { passwordHash: string }) | null> {
  const { rows } = await pool.query<UserRowWithHash>(
    "SELECT id, email, password_hash, created_at FROM users WHERE email = $1",
    [email],
  );
  const row = rows[0];
  if (!row) return null;
  return { ...toUser(row), passwordHash: row.password_hash };
}

/** Finds a user by id, for guard/session resolution. */
export async function findUserById(pool: Pool, id: string): Promise<User | null> {
  const { rows } = await pool.query<UserRow>("SELECT id, email, created_at FROM users WHERE id = $1", [id]);
  const row = rows[0];
  return row ? toUser(row) : null;
}
