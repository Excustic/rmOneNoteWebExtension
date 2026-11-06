import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../styles/global.css';
import { OptionsApp } from './OptionsApp';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root mount element #root not found in options.html');
}

createRoot(container).render(
  <StrictMode>
    <OptionsApp />
  </StrictMode>,
);
