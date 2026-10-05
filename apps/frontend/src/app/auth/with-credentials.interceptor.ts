import { HttpInterceptorFn } from '@angular/common/http';

/**
 * Attaches the session cookie to every request. The generated
 * ng-openapi-gen client doesn't expose a per-call `withCredentials` option,
 * so this is the one place that opts every backend call into sending/
 * receiving cookies across the frontend/backend origin boundary.
 */
export const withCredentialsInterceptor: HttpInterceptorFn = (req, next) => {
  return next(req.clone({ withCredentials: true }));
};
