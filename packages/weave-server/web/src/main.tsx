import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { I18nProvider } from './i18n/I18nProvider';
import { SessionStatusProvider } from './components/tasks/session-status-store';
import { ToastProvider } from './components/Toast';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <I18nProvider>
      <ToastProvider>
        <SessionStatusProvider>
          <App />
        </SessionStatusProvider>
      </ToastProvider>
    </I18nProvider>
  </React.StrictMode>,
);
