/**
 * Foreground dev entry for `pnpm dev:server`.
 *
 * Unlike the production entry (spawned by `weave daemon start`, which reads
 * the daemon state file), this binds the default port with a FIXED dev token
 * and logs to stdout so `tsx watch` can hot-reload during development. The
 * fixed token matches the Vite default (V_DAEMON_TOKEN='weave-dev-token') so
 * the SPA can call the daemon with zero configuration.
 */
import { openDatabase } from '../db/db.js';
import { ProjectRepository } from '../repositories/projects.js';
import { HookEventRepository } from '../repositories/hook-events.js';
import { LibraryRepository } from '../repositories/libraries.js';
import { ClaudeCodeAdapter } from '../hooks/adapter.js';
import { WatchService } from '../watch/watch-service.js';
import { createWeaveServer } from './server.js';
import { DEFAULT_PORT, DAEMON_HOST, findFreePort, isPortFree } from './port.js';
import { writeDaemonState } from './state.js';
import { resolveStaticDir } from './static.js';

const DEV_TOKEN = 'weave-dev-token';

async function main(): Promise<void> {
  const port = (await isPortFree(DEFAULT_PORT))
    ? DEFAULT_PORT
    : await findFreePort(DEFAULT_PORT + 1);
  writeDaemonState({
    pid: process.pid,
    port,
    token: DEV_TOKEN,
    startedAt: new Date().toISOString(),
  });

  const db = openDatabase();
  const projects = new ProjectRepository(db);
  const hookEvents = new HookEventRepository(db);
  const libraries = new LibraryRepository(db);
  const adapters = [new ClaudeCodeAdapter()];
  const watch = new WatchService(projects);
  watch.start();
  const staticDir = resolveStaticDir();

  const server = createWeaveServer({
    projects,
    daemonToken: DEV_TOKEN,
    port,
    watch,
    hookEvents,
    adapters,
    libraries,
    staticDir,
  });

  server.listen(port, DAEMON_HOST, () => {
    console.log(`[dev] weave daemon listening on http://${DAEMON_HOST}:${port}`);
    console.log(`[dev] token: ${DEV_TOKEN}`);
    if (staticDir) console.log(`[dev] static: ${staticDir}`);
    else console.log('[dev] static: (weave-web/dist not built — run pnpm build:web)');
  });
}

main();
