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
import { HookRuleRepository } from '../repositories/hook-rules.js';
import { HookDispatchRepository } from '../repositories/hook-dispatches.js';
import { PluginStateRepository } from '../repositories/plugin-states.js';
import { SessionRepository } from '../repositories/sessions.js';
import { ClaudeCodeAdapter } from '../hooks/adapter.js';
import { HookRuleRegistry } from '../hooks/registry.js';
import { HookDispatcher } from '../hooks/dispatcher.js';
import { HookEventBus } from '../hooks/bus.js';
import { ResumeRunner } from '../hooks/resume-runner.js';
import { loadAllPlugins } from '../hooks/plugin-loader.js';
import { WatchService } from '../watch/watch-service.js';
import { createWeaveServer } from './server.js';
import { DEFAULT_PORT, DAEMON_HOST, findFreePort, isPortFree } from './port.js';
import { writeDaemonState } from './state.js';
import { resolveStaticDir } from './static.js';

// daemon 若启于 Claude Code 会话内，环境携带的 CLAUDE_CODE_CHILD_SESSION 会
// 传染给一切派生物（「在终端中打开」的终端、resume 出的子会话——表现为
// 「Transcript saving is off」提示且 transcript 不落盘）。入口统一剥离，
// 下游 spawn 无需各自防御。
const hadChildMarker = 'CLAUDE_CODE_CHILD_SESSION' in process.env;
delete process.env.CLAUDE_CODE_CHILD_SESSION;

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
  const hookRegistry = new HookRuleRegistry(new HookRuleRepository(db));
  const hookDispatches = new HookDispatchRepository(db);
  const hookSessions = new SessionRepository(db);
  const hookBus = new HookEventBus();
  const { loader: hookPlugins } = await loadAllPlugins(
    {
      rules: new HookRuleRepository(db),
      registry: hookRegistry,
      states: new PluginStateRepository(db),
      bus: hookBus,
    },
    projects.list(),
  );
  {
    const rejected = hookPlugins.list().filter((p) => p.status === 'rejected');
    console.log(`[dev] plugins loaded: ${hookPlugins.list().length} (rejected: ${rejected.length})`);
    for (const r of rejected) console.log(`[dev]   rejected ${r.id}: ${r.error}`);
  }
  hookPlugins.watchRoots(); // 热重载（dev 下改插件文件即时生效）
  const hookDispatcher = new HookDispatcher({
    registry: hookRegistry,
    dispatches: hookDispatches,
    bus: hookBus,
    projects,
    sessions: hookSessions,
    plugins: hookPlugins,
  });
  const hookRunner = new ResumeRunner({
    dispatches: hookDispatches,
    sessions: hookSessions,
    projects,
    bus: hookBus,
  });
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
    hookRegistry,
    hookDispatches,
    hookSessions,
    hookBus,
    hookDispatcher,
    hookRunner,
    hookPlugins,
  });

  server.listen(port, DAEMON_HOST, () => {
    console.log(`[dev] weave daemon listening on http://${DAEMON_HOST}:${port}`);
  console.log(`[dev] child-session marker stripped: ${hadChildMarker}`);
    console.log(`[dev] token: ${DEV_TOKEN}`);
    if (staticDir) console.log(`[dev] static: ${staticDir}`);
    else console.log('[dev] static: (web/dist not built — run pnpm build:web)');
  });
}

main();
