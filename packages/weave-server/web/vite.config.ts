import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';

// Dev: Vite serves the SPA on :9527 over HTTPS and proxies /api → the weave
// daemon on :6420, stripping the /api prefix (the daemon serves its routes
// unprefixed). HTTP 已下线（2026-11-23 裁决）：局域网/手机访问与 crypto 等
// secure-context API 都要求 https。证书直接复用 daemon 签的自签件
//（<data>/local/certs，dev:server 启动时由 ensureDaemonCert 落盘）——这里
// 只读不建：证书还没签过（daemon 从未在这台机器上跑过）就起步失败，并说清
// 先去起一次 dev:server。落点解析与 daemon 的 paths.ts 同规则
//（WEAVE_DATA_DIR 覆盖 → 平台 configDir/weave）。
// Production: the daemon itself statically hosts the built bundle over the same
// HTTPS listener and applies the same /api-prefix stripping in server.ts.
function devHttpsCert(): { key: Buffer; cert: Buffer } {
  const configDir =
    process.env.WEAVE_DATA_DIR ||
    (process.platform === 'win32'
      ? process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
      : process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Application Support')
        : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'));
  const dir = path.join(configDir, 'weave', 'local', 'certs');
  const key = path.join(dir, 'host.key');
  const cert = path.join(dir, 'host.crt');
  if (!existsSync(key) || !existsSync(cert)) {
    throw new Error(
      `[vite] no daemon certs at ${dir} — 先起一次 dev:server（会签发自签证书）或设置 WEAVE_DATA_DIR`,
    );
  }
  return { key: readFileSync(key), cert: readFileSync(cert) };
}

export default defineConfig(({ command }) => ({
  plugins: [react()],
  build: {
    rollupOptions: {
      // pet.html 是桌面宠物窗的独立入口（WebView2 壳加载，不进 React 树）
      input: {
        main: path.resolve(__dirname, 'index.html'),
        pet: path.resolve(__dirname, 'pet.html'),
      },
    },
  },
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
    // 只有 serve 才要证书；build 在无证书的机器（CI/打包）上照跑。
    https: command === 'serve' ? devHttpsCert() : undefined,
    // 启动即后台预转换入口模块图——dev 首开的冷转换（~250 模块）才是首屏
    // 分钟级卡顿的元凶；warmup 把它挪到「服务起来、用户还没开页面」的空档。
    warmup: {
      clientFiles: ['./index.html'],
    },
    proxy: {
      '/terminals/ws': {
        target: 'https://127.0.0.1:6420',
        ws: true,
        secure: false,
      },
      '/api': {
        target: 'https://127.0.0.1:6420',
        changeOrigin: true,
        secure: false,
        rewrite: (p) => p.replace(/^\/api/, ''),
      },
    },
  },
}));
