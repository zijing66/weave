import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// Dev: Vite serves the SPA on :9527 and proxies /api → the weave daemon on
// :6420, stripping the /api prefix (the daemon serves its routes unprefixed).
// Production: the daemon itself statically hosts the built bundle and applies
// the same /api-prefix stripping in server.ts.
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  resolve: {
    alias: {
      // 源码直引（批 1）：web 不依赖 workspace 包运行时，别名指到 core 源文件。
      '@weavecode/core/harness': path.resolve(__dirname, '../../weave-core/src/harness.ts'),
      '@': path.resolve(__dirname, 'src'),
    },
  },
  server: {
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
  define: {
    // 生产构建不落任何默认 token（公开包里不能带已知凭据）；dev 才用 dev-entry
    // 的固定 token。生产 daemon 随机 token 只能走 `?token=` 传入。
    'import.meta.env.V_DAEMON_TOKEN': JSON.stringify(
      process.env.V_DAEMON_TOKEN ?? (mode === 'development' ? 'weave-dev-token' : ''),
    ),
  },
}));
