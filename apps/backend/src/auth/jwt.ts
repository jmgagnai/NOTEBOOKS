import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET ?? "dev-only-insecure-secret-change-me";
const JWT_EXPIRES_IN = "7d";

export interface SessionTokenPayload {
  sub: string; // user id
}

/** Signs a session JWT carrying the user's id as `sub`. */
export function signSessionToken(userId: string): string {
  return jwt.sign({ sub: userId } satisfies SessionTokenPayload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

/** Verifies a session JWT, returning its payload, or `null` if invalid/expired. */
export function verifySessionToken(token: string): SessionTokenPayload | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (typeof decoded === "object" && decoded !== null && typeof decoded.sub === "string") {
      return { sub: decoded.sub };
    }
    return null;
  } catch {
    return null;
  }
}
