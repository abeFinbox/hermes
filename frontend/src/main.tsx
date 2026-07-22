import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { LegendsProvider } from './legends';
import { ThemeProvider } from './themes';
import { ToastProvider } from './ui';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <ThemeProvider>
        <LegendsProvider>
          <ToastProvider>
            <App />
          </ToastProvider>
        </LegendsProvider>
      </ThemeProvider>
    </BrowserRouter>
  </StrictMode>,
);
