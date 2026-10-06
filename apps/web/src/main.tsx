import './polyfills.js';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App.js';
import { AuthProvider } from './lib/auth.js';
import './styles.css';
import { installDemo } from './demo.js';

// Demo build: one offline HTML file; routes live in memory (file viewers and previews give the page an opaque origin,
// where URL-based routers throw) and the API is answered from recorded data.
const DEMO = import.meta.env.VITE_DEMO === '1';
if (DEMO) installDemo();

// Live screens: re-read every 20 s while the tab is visible, and on focus/reconnect, so other users' changes appear without a reload.
// Edit forms opt out (refetchInterval: false) so a refresh never overwrites what the user is typing.
const qc = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: true, refetchOnReconnect: true, refetchInterval: 20_000, refetchIntervalInBackground: false } } });

const rootEl = document.getElementById('root')!;
rootEl.dataset.ok = '1';
createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      {DEMO ? (
        <MemoryRouter>
          <AuthProvider>
            <App />
          </AuthProvider>
        </MemoryRouter>
      ) : (
        <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, '') || undefined}>
          <AuthProvider>
            <App />
          </AuthProvider>
        </BrowserRouter>
      )}
    </QueryClientProvider>
  </StrictMode>,
);

if ('serviceWorker' in navigator && import.meta.env.PROD && !DEMO) {
  window.addEventListener('load', () => void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`));
}
