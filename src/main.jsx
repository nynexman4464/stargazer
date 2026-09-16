import '@astryxdesign/core/reset.css';
import '@astryxdesign/core/astryx.css';
import '@astryxdesign/theme-y2k/theme.css';
import './extras.css';

import React from 'react';
import { createRoot } from 'react-dom/client';
import { Theme } from '@astryxdesign/core/theme';
import { y2kTheme } from '@astryxdesign/theme-y2k/built';
import App from './App.jsx';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <Theme theme={y2kTheme} mode="dark">
      <App />
    </Theme>
  </React.StrictMode>,
);
