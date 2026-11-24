import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.js';
import { applyTheme, readSavedTheme } from './theme.js';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Renderer root element #root was not found');

applyTheme(readSavedTheme());

createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
