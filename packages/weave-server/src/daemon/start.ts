import { openDatabase } from '../db/db.js';
import { ProjectRepository } from '../repositories/projects.js';
import { HookEventRepository } from '../repositories/hook-events.js';
import { LibraryRepository } from '../repositories/libraries.js';
import { HookRuleRepository } from '../repositories/hook-rules.js';
import { HookDispatchRepository } from '../repositories/hook-dispatches.js';
import { PluginStateRepository } from '../repositories/plugin-states.js';
import { SessionRepository } from '../repositories/sessions.js';
import { ClaudeCodeAdapter } from '../hooks/adapter.js';
import { HookRuleRegistry } from '../hooks/registry.js';
import { HookDispatcher } from '../hooks/dispatcher.js';
import { HookEventBus } from '../hooks/bus.js';
import { ResumeRunner } from '../hooks/resume-runner.js';
import { loadAllPlugins, type PluginHost } from '../hooks/plugin-loader.js';
import { WatchService } from '../watch/watch-service.js';
import { SyncScheduler } from '../watch/sync-scheduler.js';
import { FingerprintCache } from '../install/fingerprint.js';
import { createWeaveServer } from './server.js';
import { DAEMON_HOST } from './port.js';
import { readDaemonState, writeDaemonState } from './state.js';
import { resolveStaticDir } from './static.js';

// 同 dev-entry：入口剥离 Claude Code child-session 标记，防污染派生物。
delete process.env.CLAUDE_CODE_CHILD_SESSION;

/**
 * Start the daemon in the current process. Reads port/token from the daemon
 * state file (written by `weave daemon start`), binds the HTTP server, starts
 * watching all registered projects, wires up hook ingestion, and statically
 * hosts the built SPA if present.
 *
 * The daemon token defaults to the one in the state file; set
 * WEAVE_DAEMON_TOKEN to pin it (e.g. to match the value baked into a
 * production SPA build).
 */
export function startDaemon(): void {
  const state = readDaemonState();
  if (!state) {
    console.error('Daemon state not found. Run `weave daemon start` first.');
    process.exit(1);
  }

  const daemonToken = process.env.WEAVE_DAEMON_TOKEN ?? state.token;
  const db = openDatabase();
  const projects = new ProjectRepository(db);
  const hookEvents = new HookEventRepository(db);
  const libraries = new LibraryRepository(db);
  const adapters = [new ClaudeCodeAdapter()];
  const hookRegistry = new HookRuleRegistry(new HookRuleRepository(db));
  const hookDispatches = new HookDispatchRepository(db);
  const hookSessions = new SessionRepository(db);
  const hookBus = new HookEventBus();
  // 插件 SPI 加载是异步的，dispatcher 先持有一个 holder；加载完成后接管查询。
  const pluginHostHolder: PluginHost = {
    getHandler: () => undefined,
    getConfig: () => ({}),
  };
  const hookDispatcher = new HookDispatcher({
    registry: hookRegistry,
    dispatches: hookDispatches,
    bus: hookBus,
    projects,
    sessions: hookSessions,
    plugins: pluginHostHolder,
  });
  void loadAllPlugins(
    {
      rules: new HookRuleRepository(db),
      registry: hookRegistry,
      states: new PluginStateRepository(db),
    },
    projects.list(),
  ).then(({ loader }) => {
    pluginHostHolder.getHandler = (id, type) => loader.getHandler(id, type);
    pluginHostHolder.getConfig = (id) => loader.getConfig(id);
  });
  const hookRunner = new ResumeRunner({
    dispatches: hookDispatches,
    sessions: hookSessions,
    projects,
    bus: hookBus,
  });
  const watch = new WatchService(projects);
  watch.start();
  const fingerprintCache = new FingerprintCache();
  const syncScheduler = new SyncScheduler(projects, libraries, { cache: fingerprintCache });
  syncScheduler.start();
  const staticDir = resolveStaticDir();

  const server = createWeaveServer({
    projects,
    daemonToken,
    port: state.port,
    watch,
    hookEvents,
    adapters,
    libraries,
    fingerprintCache,
    staticDir,
    hookRegistry,
    hookDispatches,
    hookSessions,
    hookBus,
    hookDispatcher,
    hookRunner,
  });

  const shutdown = (): void => {
    syncScheduler.stop();
    watch.stop();
    server.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  server.listen(state.port, DAEMON_HOST, () => {
    // Record the real pid + resolved token now that we are listening.
    writeDaemonState({ ...state, token: daemonToken, pid: process.pid });
  });
}
