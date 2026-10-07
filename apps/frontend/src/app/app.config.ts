import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { provideApiConfiguration } from './api/api-configuration';
import { routes } from './app.routes';
import { withCredentialsInterceptor } from './auth/with-credentials.interceptor';
import { provideAppIcons } from './shared/fluent-icons';
import { environment } from '../environments/environment';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideAnimationsAsync(),
    provideRouter(routes),
    // The session cookie set by POST /auth/login is httpOnly, so the
    // browser must be told to send/receive cookies on requests to the
    // backend's different-port origin — Angular's HttpClient otherwise
    // defaults to same-origin credentials.
    provideHttpClient(withInterceptors([withCredentialsInterceptor])),
    provideApiConfiguration(environment.apiBaseUrl),
    provideAppIcons(),
  ],
};
