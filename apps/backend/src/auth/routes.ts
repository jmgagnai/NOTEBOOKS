import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Pool } from 'pg';
import { SESSION_COOKIE_NAME, sessionCookieOptions } from './cookie.js';
import { createAuthGuard } from './guard.js';
import { signSessionToken } from './jwt.js';
import { hashPassword, verifyPassword } from './password.js';
import { createUser, findUserByEmailWithHash } from './repository.js';
import { z } from 'zod';
import {
  errorResponseSchema,
  loginRequestSchema,
  registerRequestSchema,
  userSchema,
} from './schema.js';

const UNIQUE_VIOLATION = '23505';

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === UNIQUE_VIOLATION;
}

export function registerAuthRoutes(app: FastifyInstance, pool: Pool): void {
  const authGuard = createAuthGuard(pool);
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  typedApp.post(
    '/auth/register',
    {
      schema: {
        operationId: 'register',
        tags: ['auth'],
        summary: 'Register a new user account',
        body: registerRequestSchema,
        response: {
          201: userSchema,
          409: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { email, password } = request.body;
      const passwordHash = await hashPassword(password);
      try {
        const user = await createUser(pool, email, passwordHash);
        await reply.status(201).send(user);
      } catch (err) {
        if (isUniqueViolation(err)) {
          await reply.status(409).send({ message: 'An account with this email already exists.' });
          return;
        }
        throw err;
      }
    },
  );

  typedApp.post(
    '/auth/login',
    {
      schema: {
        operationId: 'login',
        tags: ['auth'],
        summary: 'Log in and receive a session cookie',
        body: loginRequestSchema,
        response: {
          200: userSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { email, password } = request.body;
      const user = await findUserByEmailWithHash(pool, email);
      const valid = user ? await verifyPassword(password, user.passwordHash) : false;

      if (!user || !valid) {
        await reply.status(401).send({ message: 'Invalid email or password.' });
        return;
      }

      const token = signSessionToken(user.id);
      await reply
        .setCookie(SESSION_COOKIE_NAME, token, sessionCookieOptions())
        .status(200)
        .send({ id: user.id, email: user.email, createdAt: user.createdAt });
    },
  );

  typedApp.post(
    '/auth/logout',
    {
      schema: {
        operationId: 'logout',
        tags: ['auth'],
        summary: 'Log out and clear the session cookie',
        response: {
          204: z.null().describe('No content'),
        },
      },
    },
    async (_request, reply) => {
      await reply.clearCookie(SESSION_COOKIE_NAME, { path: '/' }).status(204).send(null);
    },
  );

  typedApp.get(
    '/auth/me',
    {
      preHandler: authGuard,
      schema: {
        operationId: 'getCurrentUser',
        tags: ['auth'],
        summary: 'Get the current authenticated user',
        response: {
          200: userSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      // authGuard guarantees authUser is set when we reach here.
      await reply.status(200).send(request.authUser!);
    },
  );
}
