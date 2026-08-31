import { defineConfig } from 'vitest/config';

export default defineConfig({
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
