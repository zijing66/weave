import { openDatabase } from '../db/db.js';
import { ProjectRepository } from '../repositories/projects.js';
import { HookEventRepository } from '../repositories/hook-events.js';
import { LibraryRepository } from '../repositories/libraries.js';
import { HookRuleRepository } from '../repositories/hook-rules.js';
import { HookDispatchRepository } from '../repositories/hook-dispatches.js';
import { PluginStateRepository } from '../repositories/plugin-states.js';
import { SessionRepository } from '../repositories/sessions.js';
import { createRuntimeRegistry } from '@weavecode/harness';
import { SessionSweeper } from '../hooks/session-sweeper.js';
import { sweepProjectSpools } from '../hooks/spool.js';
import { hooksRoot } from '../hooks/mirror.js';
import { wireHookFilePipeline } from './hook-pipeline.js';
import { HookRuleRegistry } from '../hooks/registry.js';
import { HookDispatcher } from '../hooks/dispatcher.js';
import { HookEventBus } from '../hooks/bus.js';
import { ResumeRunner } from '../hooks/resume-runner.js';
import { loadAllPlugins, type PluginHost, type PluginManager, type WeavePluginLoader } from '../hooks/plugin-loader.js';
import { ToolkitService } from '../hooks/toolkit.js';
import { WatchService } from '../watch/watch-service.js';
import { SyncScheduler } from '../watch/sync-scheduler.js';
import { FingerprintCache } from '../install/fingerprint.js';
import { createWeaveServer } from './server.js';
import { DAEMON_HOST } from './port.js';
import { readDaemonState, writeDaemonState } from './state.js';
import { setDaemonSettingsDb } from './settings.js';
import { syncLaunchOnLogin } from './auto-start.js';
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
  setDaemonSettingsDb(db); // 配置统一落库：settings 表直连本库（测试可注入覆盖）
  const projects = new ProjectRepository(db);
  const hookEvents = new HookEventRepository(db);
  const libraries = new LibraryRepository(db);
  // 图② 装配：registry 注册运行时驱动 → adapters 由 events 能力槽派生
  //（== 旧 [new ClaudeCodeAdapter()]），resume 规格同源注入。
  const harnesses = createRuntimeRegistry();
  const adapters = harnesses.byCapability('events').flatMap((d) => d.events ?? []);
  const hookRegistry = new HookRuleRegistry(new HookRuleRepository(db));
  const hookDispatches = new HookDispatchRepository(db);
  const hookSessions = new SessionRepository(db);
  const hookBus = new HookEventBus();
  // 插件 SPI 加载是异步的，dispatcher 先持有一个 holder；加载完成后接管查询并开启热重载。
  const pluginHostHolder: PluginHost = {
    getHandler: () => undefined,
    getConfig: () => ({}),
  };
  let stopPluginWatch: (() => void) | undefined;
  let pluginLoaderRef: WeavePluginLoader | undefined;
  const pluginManager: PluginManager = {
    list: () => pluginLoaderRef?.list() ?? [],
    setPluginEnabled: (id, enabled) => pluginLoaderRef?.setPluginEnabled(id, enabled) ?? false,
    reloadAll: async () => {
      await pluginLoaderRef?.reloadAll();
    },
  };
  // 批 10 工具包服务（扫描/开关）；states 与 loader 同库同表。
  const toolkit = new ToolkitService({
    projects,
    states: new PluginStateRepository(db),
    plugins: pluginManager,
    libraries,
  });
  const hookDispatcher = new HookDispatcher({
    registry: hookRegistry,
    dispatches: hookDispatches,
    bus: hookBus,
    projects,
    sessions: hookSessions,
    plugins: pluginHostHolder,
    pluginStates: new PluginStateRepository(db),
  });
  void loadAllPlugins(
    {
      rules: new HookRuleRepository(db),
      registry: hookRegistry,
      states: new PluginStateRepository(db),
      bus: hookBus,
      libraries,
    },
    projects.list(),
  ).then(({ loader }) => {
    pluginLoaderRef = loader;
    pluginHostHolder.getHandler = (id, type) => loader.getHandler(id, type);
    pluginHostHolder.getConfig = (id) => loader.getConfig(id);
    stopPluginWatch = loader.watchRoots();
  });
  const hookRunner = new ResumeRunner({
    dispatches: hookDispatches,
    sessions: hookSessions,
    projects,
    bus: hookBus,
    // 批 4b：resume 规格来自 registry（缺省回落 CLAUDE_RESUME，行为不变）。
    resumeSpec: harnesses.get('claude')?.resume,
  });
  const watch = new WatchService(projects);
  watch.start();
  const fingerprintCache = new FingerprintCache();
  const syncScheduler = new SyncScheduler(projects, libraries, {
    cache: fingerprintCache,
    plugins: pluginManager,
  });
  syncScheduler.start();
  // 空会话自动清理：只残留一条 SessionStart 的会话（开了就 /resume 走掉的那种）
  // 延迟清掉——真实场景里它们只是噪音，且父会话已经 /resume 到别处。
  new SessionSweeper({ sessions: hookSessions, events: hookEvents, dispatches: hookDispatches }).start();
  // hook 文件管道（mirror 镜像 + inbox 消费线程）：与 dev-entry 共用同一装配
  const hookPipeline = wireHookFilePipeline({
    projects,
    rules: hookRegistry,
    sessions: hookSessions,
    bus: hookBus,
    dispatcher: hookDispatcher,
  });
  const staticDir = resolveStaticDir();

  const server = createWeaveServer({
    projects,
    daemonToken,
    port: state.port,
    watch,
    hookEvents,
    adapters,
    harnesses,
    libraries,
    fingerprintCache,
    staticDir,
    hookRegistry,
    hookDispatches,
    hookSessions,
    hookBus,
    hookDispatcher,
    hookRunner,
    hookPlugins: pluginManager,
    hookMirror: hookPipeline.mirror,
    hookInboxDir: hooksRoot(),
    pluginStates: new PluginStateRepository(db),
    toolkit,
  });

  const shutdown = (): void => {
    stopPluginWatch?.();
    syncScheduler.stop();
    watch.stop();
    void hookPipeline.stop();
    server.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  server.listen(state.port, DAEMON_HOST, () => {
    // Record the real pid + resolved token now that we are listening.
    writeDaemonState({ ...state, token: daemonToken, pid: process.pid });
    // 开机自启对账：设置是唯一事实源（开着但系统项被清 → 重建；反之清掉）。
    syncLaunchOnLogin();
    // spool 积压回灌【弃用口，旧版脚本存量兜底】：daemon 不在期间旧版 hook
    // 落项目本地 spool 的事件，起服务就补上；新版 hook 落全局 inbox，由
    // inbox 消费线程接管（先 tick 一次）
    //（客户端 flusher 只在下一 hook 成功后才跑，这里覆盖 server 恢复但
    // 用户空闲的场景）。失败不阻断启动。
    try {
      const flushed = sweepProjectSpools({
        projects,
        hookEvents,
        hookSessions,
        hookBus,
        eventSources: adapters,
      });
      if (flushed > 0) {
        console.log(`[weave] spool backlog ingested: ${flushed} event(s)`);
      }
    } catch (e) {
      console.error('[weave] spool sweep failed:', e);
    }
  });
}
