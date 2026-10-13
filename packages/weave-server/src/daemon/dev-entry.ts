/**
 * Foreground dev entry for `pnpm dev:server`.
 *
 * Unlike the production entry (spawned by `weave daemon start`, which reads
 * the daemon state file), this binds the default port and logs to stdout so
 * `tsx watch` can hot-reload during development. The daemon has no auth token
 * — it binds 127.0.0.1 only, so the machine boundary is the trust boundary.
 */
import { openDatabase } from '../db/db.js';
import { ProjectRepository } from '../repositories/projects.js';
import { HookEventRepository } from '../repositories/hook-events.js';
import { LibraryRepository } from '../repositories/libraries.js';
import { HookRuleRepository } from '../repositories/hook-rules.js';
import { HookDispatchRepository } from '../repositories/hook-dispatches.js';
import { PluginStateRepository } from '../repositories/plugin-states.js';
import { SessionRepository } from '../repositories/sessions.js';
import { createRuntimeRegistry } from '@weavecode/harness';
import { HookRuleRegistry } from '../hooks/registry.js';
import { HookDispatcher } from '../hooks/dispatcher.js';
import { HookEventBus } from '../hooks/bus.js';
import { ResumeRunner } from '../hooks/resume-runner.js';
import { HeadlessRunner } from '../hooks/headless-runner.js';
import { MessageDeliverer } from '../hooks/message-deliverer.js';
import { SessionMessageRepository } from '../repositories/session-messages.js';
import { loadAllPlugins } from '../hooks/plugin-loader.js';
import { ensureBuiltinMarket, builtinMarketDir } from '../market/builtin.js';
import { ToolkitService } from '../hooks/toolkit.js';
import { startSessionSweeper } from '../hooks/session-sweeper.js';
import { WatchService } from '../watch/watch-service.js';
import { createWeaveServer } from './server.js';
import { DataBus } from './data-bus.js';
import { TerminalCountsRefresher } from './terminal-counts-refresher.js';
import { readTerminalCounts } from './opener.js';
import { wireHookFilePipeline } from './hook-pipeline.js';
import { DEFAULT_PORT, DAEMON_HOST, findFreePort, isPortFree } from './port.js';
import { writeDaemonState } from './state.js';
import { setDaemonSettingsDb } from './settings.js';
import { resolveStaticDir } from './static.js';

// daemon 若启于 Claude Code 会话内，环境携带的 CLAUDE_CODE_CHILD_SESSION 会
// 传染给一切派生物（「在终端中打开」的终端、resume 出的子会话——表现为
// 「Transcript saving is off」提示且 transcript 不落盘）。入口统一剥离，
// 下游 spawn 无需各自防御。
const hadChildMarker = 'CLAUDE_CODE_CHILD_SESSION' in process.env;
delete process.env.CLAUDE_CODE_CHILD_SESSION;

async function main(): Promise<void> {
  const port = (await isPortFree(DEFAULT_PORT))
    ? DEFAULT_PORT
    : await findFreePort(DEFAULT_PORT + 1);
  writeDaemonState({
    pid: process.pid,
    port,
    startedAt: new Date().toISOString(),
  });

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
  // 内置仓落地必须先于装载：内置规则包装载根与工具包扫描根都指向它。
  {
    const r = await ensureBuiltinMarket({ libraries });
    if (r.error) console.error(`[dev] builtin market unavailable: ${r.error}`);
    else if (r.changed) {
      console.log(
        `[dev] builtin market ${r.form === 'link' ? 'linked' : 'copied'} -> ${builtinMarketDir(libraries.dataDir)}`,
      );
    }
  }
  const { loader: hookPlugins } = await loadAllPlugins(
    {
      rules: new HookRuleRepository(db),
      registry: hookRegistry,
      states: new PluginStateRepository(db),
      bus: hookBus,
      libraries,
    },
    projects.list(),
  );
  {
    const rejected = hookPlugins.list().filter((p) => p.status === 'rejected');
    console.log(`[dev] plugins loaded: ${hookPlugins.list().length} (rejected: ${rejected.length})`);
    for (const r of rejected) console.log(`[dev]   rejected ${r.id}: ${r.error}`);
  }
  hookPlugins.watchRoots(); // 热重载（dev 下改插件文件即时生效）
  // 批 10 工具包服务（loader 已就绪，直接挂载）
  const toolkit = new ToolkitService({
    projects,
    states: new PluginStateRepository(db),
    plugins: hookPlugins,
    libraries,
  });
  const hookDispatcher = new HookDispatcher({
    registry: hookRegistry,
    dispatches: hookDispatches,
    bus: hookBus,
    projects,
    sessions: hookSessions,
    plugins: hookPlugins,
    pluginStates: new PluginStateRepository(db),
  });
  // session-orchestration 批 1（与 start.ts 同装配）：两域共享无头执行核。
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
  const sessionMessages = new SessionMessageRepository(db);
  const messageDeliverer = new MessageDeliverer({
    messages: sessionMessages,
    sessions: hookSessions,
    projects,
    hookEvents,
    bus: hookBus,
    headless: headlessRunner,
  });
  const watch = new WatchService(projects);
  watch.start();
  // 数据变更帧总线 + 终端角标隐藏刷新：前端不再轮询角标，改由后端「有人看时每
  // 30s 探一次、只在值变化时推」。探测要 spawn `wezterm cli`，绑 SSE 客户端数。
  const dataBus = new DataBus();
  const terminalRefresher = new TerminalCountsRefresher(
    () => readTerminalCounts(projects.list()),
    dataBus,
    { shouldRun: () => dataBus.hasSubscribers() },
  );
  terminalRefresher.start();
  // 空会话自动清理（与生产入口同一装配点）：dev 入口此前漏挂 → 只残留一条
  // SessionStart 的会话在 dev 下永不消失，一直挂在会话列表里显示「就绪」。
  startSessionSweeper({
    sessions: hookSessions,
    events: hookEvents,
    dispatches: hookDispatches,
    messages: sessionMessages,
  });
  // hook 文件管道（mirror 镜像 + inbox 消费线程）：与 start.ts 共用同一装配
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
    port,
    watch,
    hookEvents,
    adapters,
    harnesses,
    libraries,
    staticDir,
    hookRegistry,
    hookDispatches,
    hookSessions,
    hookBus,
    dataBus,
    terminalRefresher,
    hookDispatcher,
    hookRunner,
    sessionMessages,
    messageDeliverer,
    hookPlugins,
    hookMirror: hookPipeline.mirror,
    pluginStates: new PluginStateRepository(db),
    toolkit,
  });

  const shutdown = (): void => {
    terminalRefresher.stop();
    void hookPipeline.stop();
    server.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  server.listen(port, DAEMON_HOST, () => {
    console.log(`[dev] weave daemon listening on http://${DAEMON_HOST}:${port}`);
    console.log(`[dev] child-session marker stripped: ${hadChildMarker}`);
    if (staticDir) console.log(`[dev] static: ${staticDir}`);
    else console.log('[dev] static: (web/dist not built — run pnpm build:web)');
  });
}

main();
