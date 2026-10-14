import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// Dev: Vite serves the SPA on :9527 and proxies /api → the weave daemon on
// :6420, stripping the /api prefix (the daemon serves its routes unprefixed).
// Production: the daemon itself statically hosts the built bundle and applies
// the same /api-prefix stripping in server.ts. The daemon has no auth token —
// it binds 127.0.0.1 only, so the machine boundary is the trust boundary.
export default defineConfig(() => ({
  plugins: [react()],
  resolve: {
    alias: {
      // 源码直引（批 1）：web 不依赖 workspace 包运行时，别名指到 core 源文件。
      '@weavecode/core/harness': path.resolve(__dirname, '../../weave-core/src/harness.ts'),
      '@weavecode/core/tool': path.resolve(__dirname, '../../weave-core/src/tool.ts'),
      '@': path.resolve(__dirname, 'src'),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 9527,
    // 启动即后台预转换入口模块图——dev 首开的冷转换（~250 模块）才是首屏
    // 分钟级卡顿的元凶；warmup 把它挪到「服务起来、用户还没开页面」的空档。
    warmup: {
      clientFiles: ['./index.html'],
    },
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:6420',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ''),
      },
    },
  },
}));
