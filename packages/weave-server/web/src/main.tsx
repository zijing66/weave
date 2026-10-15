import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { I18nProvider } from './i18n/I18nProvider';
import { SessionStatusProvider } from './components/tasks/session-status-store';
import { ToastProvider } from './components/Toast';
import './index.css';

// 系统 notifications 的载体（Android Chromium 只认 registration.showNotification，
// 见 lib/browser-notify.ts）。仅安全上下文可注册（局域网 HTTP 下会失败，静默放弃）。
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('/sw.js').catch(() => {
    /* 注册失败只是少了系统通知，页面内 toast 照常 */
  });
}

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
