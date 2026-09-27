import '@astryxdesign/core/reset.css';
import '@astryxdesign/core/astryx.css';
import './theme/stargazer/stargazer.css';
import './extras.css';

// 1km Bortle grid API (DreamHost MySQL). Served from app.alexrock.com;
// override per-deployment via window.BORTLE_1KM_API before this runs.
if (typeof window !== 'undefined' && !window.BORTLE_1KM_API) {
  window.BORTLE_1KM_API = 'https://app.alexrock.com/bortle.php';
}

import React from 'react';
import { createRoot } from 'react-dom/client';
import { Theme } from '@astryxdesign/core/theme';
import { stargazerTheme } from './theme/stargazer/stargazer.js';
import App from './App.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <Theme theme={stargazerTheme} mode="dark">
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </Theme>
  </React.StrictMode>,
);
