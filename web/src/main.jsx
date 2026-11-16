import { StrictMode, lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import Landing from './pages/Landing.jsx';
import { ON_APP_HOST } from './lib/site.js';

// The app (prover, wasm, viem) is code-split so the landing page stays light.
const AppPage = lazy(() => import('./pages/AppPage.jsx'));
const isApp = ON_APP_HOST || location.pathname.startsWith('/app');

createRoot(document.getElementById('root')).render(
  <StrictMode>
    {isApp ? <Suspense fallback={<div className="min-h-[100dvh] bg-bg" />}><AppPage /></Suspense> : <Landing />}
  </StrictMode>,
);
