import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // server/web（原 weave-web 并入，批 W）源码内用 Vite 的 '@/...' 别名
      // （vite.config.ts）；根 vitest 跑全仓测试时不读该配置，这里镜像一份让 web
      // 下的测试也能解析。
      '@': fileURLToPath(new URL('./packages/weave-server/web/src', import.meta.url)),
      // 源码直引（批 1）：镜像 web 的 vite alias，让 web 测试能解析。
      '@weavecode/core/harness': fileURLToPath(
        new URL('./packages/weave-core/src/harness.ts', import.meta.url),
      ),
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
