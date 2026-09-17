import '@astryxdesign/core/reset.css';
import '@astryxdesign/core/astryx.css';
import './theme/stargazer/stargazer.css';
import './extras.css';

import React from 'react';
import { createRoot } from 'react-dom/client';
import { Theme } from '@astryxdesign/core/theme';
import { stargazerTheme } from './theme/stargazer/stargazer.js';
import App from './App.jsx';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <Theme theme={stargazerTheme} mode="dark">
      <App />
    </Theme>
  </React.StrictMode>,
);
