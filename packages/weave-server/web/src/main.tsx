import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { I18nProvider } from './i18n/I18nProvider';
import { SessionStatusProvider } from './components/tasks/session-status-store';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <I18nProvider>
      <SessionStatusProvider>
        <App />
      </SessionStatusProvider>
    </I18nProvider>
  </React.StrictMode>,
);
