// Where the landing page and the app live. On production the app has its own host (app.tremor.in);
// everywhere else (localhost, previews) it is served at /app on the same host.
export const ON_APP_HOST = location.hostname.startsWith('app.');
const PROD = location.hostname === 'tremor.in' || location.hostname.endsWith('.tremor.in');
// Flip to true once app.tremor.in resolves (CNAME app -> cname.vercel-dns.com at the DNS host).
const APP_HOST_LIVE = false;
export const APP_URL = PROD && (APP_HOST_LIVE || ON_APP_HOST) ? 'https://app.tremor.in' : '/app';
export const HOME_URL = PROD ? 'https://tremor.in' : '/';
export const APP_BASE = ON_APP_HOST ? '/' : '/app'; // path the app lives at on the current host
