export const SESSION_COOKIE_NAME = 'session';

/**
 * Cookie options for issuing the session cookie on login.
 *
 * `sameSite: "lax"` is enough here: the frontend dev server and the backend
 * are different origins (different ports) but the same registrable domain
 * (localhost), which SameSite treats as same-site. `secure` is tied to
 * NODE_ENV so local http dev still works (browsers drop Secure cookies over
 * plain http) while anything deployed gets it.
 */
export function sessionCookieOptions(): {
  httpOnly: true;
  sameSite: 'lax';
  secure: boolean;
  path: '/';
  maxAge: number;
} {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 24 * 7, // 7 days, in seconds
  };
}
