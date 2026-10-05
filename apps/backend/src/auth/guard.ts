import type { FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { SESSION_COOKIE_NAME } from "./cookie.js";
import { verifySessionToken } from "./jwt.js";
import { findUserById } from "./repository.js";
import type { User } from "./schema.js";

declare module "fastify" {
  interface FastifyRequest {
    authUser?: User;
  }
}

/**
 * Builds a preHandler that rejects a request with 401 unless it carries a
 * valid session cookie for an existing user, in which case it decorates the
 * request with `authUser`. This is the guard every protected route depends
 * on (NBK-3).
 */
export function createAuthGuard(pool: Pool) {
  return async function authGuard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const token = request.cookies[SESSION_COOKIE_NAME];
    const payload = token ? verifySessionToken(token) : null;
    const user = payload ? await findUserById(pool, payload.sub) : null;

    if (!user) {
      await reply.status(401).send({ message: "Authentication required." });
      return;
    }

    request.authUser = user;
  };
}
