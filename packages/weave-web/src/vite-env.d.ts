/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly V_DAEMON_TOKEN: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
