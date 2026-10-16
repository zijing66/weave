import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import { I18nProvider } from './i18n/I18nProvider';
import { SessionStatusProvider } from './components/tasks/session-status-store';
import { ToastProvider } from './components/Toast';
import './index.css';

// 数据层（TanStack Query，试点起步、逐域并入）：刷新只走明确信号（SSE 帧 →
// invalidate / 变更后失效），不定时轮询、聚焦不自动重拉、失败不重试——个别查询
// （如项目列表的后台 reconcile 兜底）按需在 useQuery 里覆写。
const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: Infinity, refetchOnWindowFocus: false, retry: false },
  },
});

// 系统 notifications 的载体（Android Chromium 只认 registration.showNotification，
// 见 lib/browser-notify.ts）。仅安全上下文可注册（局域网 HTTP 下会失败，静默放弃）。
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('/sw.js').catch(() => {
    /* 注册失败只是少了系统通知，页面内 toast 照常 */
  });
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <ToastProvider>
          <SessionStatusProvider>
            <App />
          </SessionStatusProvider>
        </ToastProvider>
      </I18nProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
