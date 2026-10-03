import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// Dev: Vite serves the SPA on :9527 and proxies /api → the weave daemon on
// :6420, stripping the /api prefix (the daemon serves its routes unprefixed).
// Production: the daemon itself statically hosts the built bundle and applies
// the same /api-prefix stripping in server.ts.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // 源码直引（批 1）：web 不依赖 workspace 包运行时，别名指到 core 源文件。
      '@weave/core/harness': path.resolve(__dirname, '../weave-core/src/harness.ts'),
      '@': path.resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 9527,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:6420',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ''),
      },
    },
  },
  define: {
    'import.meta.env.V_DAEMON_TOKEN': JSON.stringify(
      process.env.V_DAEMON_TOKEN ?? 'weave-dev-token',
    ),
  },
});
