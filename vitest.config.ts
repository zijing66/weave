import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // weave-web 源码内用 Vite 的 '@/...' 别名（vite.config.ts）；根 vitest
      // 跑全仓测试时不读该配置，这里镜像一份让 web 下的测试也能解析。
      '@': fileURLToPath(new URL('./packages/weave-web/src', import.meta.url)),
    },
  },
  test: {
    globals: true,
    server: {
      deps: {
        // node:sqlite was added to Node after vite 5's builtin-module list was
        // frozen — externalize it so vitest treats it as a native module.
        external: ['node:sqlite'],
      },
    },
  },
});
