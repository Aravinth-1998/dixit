import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';

function boot() {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}

// Load the card manifest first so we know what extension the cards use
// (svg for placeholders, png for the real deck, etc.). Avoid top-level
// await — Vite's default target doesn't support it.
fetch('/cards/manifest.json')
  .then(r => r.json())
  .then(m => {
    (window as any).__DIXIT_CARD_EXT__ = m.ext || 'svg';
  })
  .catch(() => {
    (window as any).__DIXIT_CARD_EXT__ = 'svg';
  })
  .finally(boot);
