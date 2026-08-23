import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App';
import './style.css';

const root = document.getElementById('root');
if (!root) throw new Error('SubTwin options root is unavailable.');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
