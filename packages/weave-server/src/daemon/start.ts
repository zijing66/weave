import { openDatabase } from '../db/db.js';
import { ProjectRepository } from '../repositories/projects.js';
import { HookEventRepository } from '../repositories/hook-events.js';
import { LibraryRepository } from '../repositories/libraries.js';
import { HookRuleRepository } from '../repositories/hook-rules.js';
import { HookDispatchRepository } from '../repositories/hook-dispatches.js';
import { PluginStateRepository } from '../repositories/plugin-states.js';
import { SessionRepository } from '../repositories/sessions.js';
import { createRuntimeRegistry } from '@weavecode/harness';
import { startSessionSweeper } from '../hooks/session-sweeper.js';
import { wireHookFilePipeline } from './hook-pipeline.js';
import { ensureBuiltinMarket, builtinMarketDir } from '../market/builtin.js';
import { HookRuleRegistry } from '../hooks/registry.js';
import { HookDispatcher } from '../hooks/dispatcher.js';
import { HookEventBus } from '../hooks/bus.js';
import { ResumeRunner } from '../hooks/resume-runner.js';
import { HeadlessRunner } from '../hooks/headless-runner.js';
import { MessageDeliverer } from '../hooks/message-deliverer.js';
import { startPromptFlusher } from '../hooks/prompt-flusher.js';
import { SessionWatchRepository } from '../repositories/session-watches.js';
import { SessionSequenceRepository } from '../repositories/session-sequences.js';
import { WatchEngine } from '../hooks/watch-engine.js';
import { SequenceEngine } from '../hooks/sequence-engine.js';
import { loadAllPlugins, type PluginHost, type PluginManager, type WeavePluginLoader } from '../hooks/plugin-loader.js';
import { ToolkitService } from '../hooks/toolkit.js';
import { WatchService } from '../watch/watch-service.js';
import { SyncScheduler } from '../watch/sync-scheduler.js';
import { FingerprintCache } from '../install/fingerprint.js';
import { createWeaveServer } from './server.js';
import { DataBus } from './data-bus.js';
import { TerminalCountsRefresher } from './terminal-counts-refresher.js';
import { promptTerminalChannel, readTerminalCounts } from './opener.js';
import { DEFAULT_BIND_HOST } from './port.js';
import { readDaemonState, writeDaemonState } from './state.js';
import { readDaemonSettingsSync, setDaemonSettingsDb } from './settings.js';
import { AuthService } from './dashboard-auth.js';
import { syncLaunchOnLogin } from './auto-start.js';
import { resolveStaticDir } from './static.js';

// 同 dev-entry：入口剥离 Claude Code child-session 标记，防污染派生物。
delete process.env.CLAUDE_CODE_CHILD_SESSION;

/**
 * Start the daemon in the current process. Reads port from the daemon state
 * file (written by `weave daemon start`), binds the HTTP server on the
 * configured host (settings `server.bindHost`，默认 0.0.0.0——由 dashboard
 * 密码认证兜底，见 auth.ts), starts watching all registered projects, wires up
 * hook ingestion, and statically hosts the built SPA if present.
 */
export function startDaemon(): void {
  const state = readDaemonState();
  if (!state) {
    console.error('Daemon state not found. Run `weave daemon start` first.');
    process.exit(1);
  }
  const db = openDatabase();
  setDaemonSettingsDb(db); // 配置统一落库：settings 表直连本库（测试可注入覆盖）
  const bindHost = readDaemonSettingsSync().server?.bindHost ?? DEFAULT_BIND_HOST;
  // dashboard 认证（监听放开的配套）：口令材料落 <dataDir>/auth.json。首启生成的
  // 初始密码已写入 initial-password 标记文件——本进程 detached/stdio:ignore 启动，
  // 打印必丢，领取通道是 CLI（`weave dashboard`/`weave chpass` 读标记并显示一次）。
  const auth = new AuthService();
  if (auth.initialPassword) {
    console.log(`[weave] initial dashboard password: ${auth.initialPassword}`);
  }
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
  // 内置仓落地必须先于装载：内置规则包装载根与工具包扫描根都指向 <dataDir>/market/weave。
  void ensureBuiltinMarket({ libraries })
    .then((result) => {
      if (result.error) {
        console.error(`[weave] builtin market unavailable: ${result.error}`);
      } else if (result.changed) {
        console.log(
          `[weave] builtin market ${result.form === 'link' ? 'linked' : 'copied'} -> ${builtinMarketDir(libraries.dataDir)}`,
        );
      }
      return loadAllPlugins(
        {
          rules: new HookRuleRepository(db),
          registry: hookRegistry,
          states: new PluginStateRepository(db),
          bus: hookBus,
          libraries,
        },
        projects.list(),
      );
    })
    .then(({ loader }) => {
      pluginLoaderRef = loader;
      pluginHostHolder.getHandler = (id, type) => loader.getHandler(id, type);
      pluginHostHolder.getConfig = (id) => loader.getConfig(id);
      stopPluginWatch = loader.watchRoots();
    });
  // session-orchestration 批 1：dispatch 域（ResumeRunner）与 message 域
  // （MessageDeliverer）共享同一无头执行核 = 同会话并发闸跨域生效。
  const headlessRunner = new HeadlessRunner();
  const hookRunner = new ResumeRunner({
    dispatches: hookDispatches,
    sessions: hookSessions,
    projects,
    bus: hookBus,
    // 批 4b：resume 规格来自 registry（缺省回落 CLAUDE_RESUME，行为不变）。
    resumeSpec: harnesses.get('claude')?.resume,
    headless: headlessRunner,
  });
  // 消息域（消息域重塑）：纯递送管道——无 DB 依赖，pending 落 promptbox 文件、
  // 在途/终态在内存注册表；隐藏冲洗器周期试递（与 ingest 即时冲洗双触发）。
  // prompt 层② 终端兜底随 settings 取后端（preset 运行期可改，可用性由后端诚实声明）。
  const messageDeliverer = new MessageDeliverer({
    sessions: hookSessions,
    projects,
    hookEvents,
    bus: hookBus,
    headless: headlessRunner,
    terminal: promptTerminalChannel(() => readDaemonSettingsSync().terminal),
  });
  startPromptFlusher(messageDeliverer);
  // session-orchestration 批 2：空闲订阅引擎（ingest 即时 fire + sweeper 补射）
  const sessionWatches = new SessionWatchRepository(db);
  const watchEngine = new WatchEngine({
    watches: sessionWatches,
    deliverer: messageDeliverer,
    sessions: hookSessions,
    bus: hookBus,
  });
  // session-orchestration 批 3：序列引擎（无状态 bus 监听 + DB 推进），启动
  // rearm 恢复重启前的 running 序列。
  const sessionSequences = new SessionSequenceRepository(db);
  const sequenceEngine = new SequenceEngine({
    sequences: sessionSequences,
    deliverer: messageDeliverer,
    sessions: hookSessions,
    bus: hookBus,
  });
  sequenceEngine.rearm();
  const watch = new WatchService(projects);
  watch.start();
  const fingerprintCache = new FingerprintCache();
  const syncScheduler = new SyncScheduler(projects, libraries, {
    cache: fingerprintCache,
    plugins: pluginManager,
  });
  syncScheduler.start();
  // 数据变更帧总线 + 终端角标的隐藏刷新：前端不再轮询角标，改由后端「有人看时
  // 每 30s 探一次、只在值变化时推」。探测本身要 spawn `wezterm cli`，所以绑
  // SSE 客户端数——没人开看板就一次都不探。
  const dataBus = new DataBus();
  const terminalRefresher = new TerminalCountsRefresher(
    () => readTerminalCounts(projects.list()),
    dataBus,
    { shouldRun: () => dataBus.hasSubscribers() },
  );
  terminalRefresher.start();
  // 空会话自动清理：只残留一条 SessionStart 的会话（开了就 /resume 走掉的那种）
  // 延迟清掉——真实场景里它们只是噪音，且父会话已经 /resume 到别处。
  startSessionSweeper({
    sessions: hookSessions,
    events: hookEvents,
    dispatches: hookDispatches,
    deliverer: messageDeliverer,
    watches: sessionWatches,
    sequences: sessionSequences,
    watchEngine,
    sequenceEngine,
  });
  // hook 文件管道（mirror 镜像 + inbox 消费线程）：与 dev-entry 共用同一装配
  const hookPipeline = wireHookFilePipeline({
    projects,
    rules: hookRegistry,
    sessions: hookSessions,
    bus: hookBus,
    dispatcher: hookDispatcher,
    watchEngine,
    sequenceEngine,
    messagePipe: messageDeliverer,
  });
  const staticDir = resolveStaticDir();

  const server = createWeaveServer({
    projects,
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
    dataBus,
    terminalRefresher,
    hookDispatcher,
    hookRunner,
    messageDeliverer,
    sessionWatches,
    watchEngine,
    sessionSequences,
    sequenceEngine,
    hookPlugins: pluginManager,
    hookMirror: hookPipeline.mirror,
    pluginStates: new PluginStateRepository(db),
    toolkit,
    auth,
  });

  const shutdown = (): void => {
    stopPluginWatch?.();
    terminalRefresher.stop();
    syncScheduler.stop();
    watch.stop();
    void hookPipeline.stop();
    server.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  server.listen(state.port, bindHost, () => {
    // Record the real pid + actual bind host now that we are listening.
    writeDaemonState({ ...state, pid: process.pid, host: bindHost });
    // 开机自启对账：设置是唯一事实源（开着但系统项被清 → 重建；反之清掉）。
    syncLaunchOnLogin();
  });
}
