// Where the landing page and the app live. On production the app has its own host (app.tremor.in);
// everywhere else (localhost, previews) it is served at /app on the same host.
export const ON_APP_HOST = location.hostname.startsWith('app.');
const PROD = location.hostname === 'tremor.in' || location.hostname.endsWith('.tremor.in');
// app.tremor.in is live (CNAME app -> Vercel at GoDaddy, added 2026-11-17).
const APP_HOST_LIVE = true;
export const APP_URL = PROD && (APP_HOST_LIVE || ON_APP_HOST) ? 'https://app.tremor.in' : '/app';
export const HOME_URL = PROD ? 'https://tremor.in' : '/';
export const APP_BASE = ON_APP_HOST ? '/' : '/app'; // path the app lives at on the current host
