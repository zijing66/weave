import http from 'node:http';
import { openDatabase } from '../db/db.js';
import { ProjectRepository } from '../repositories/projects.js';
import { HookEventRepository } from '../repositories/hook-events.js';
import { LibraryRepository } from '../repositories/libraries.js';
import { HookRuleRepository } from '../repositories/hook-rules.js';
import { HookDispatchRepository } from '../repositories/hook-dispatches.js';
import { PluginStateRepository } from '../repositories/plugin-states.js';
import { SessionRepository } from '../repositories/sessions.js';
import { createRuntimeRegistry } from '@weavecode/harness';
import { TERMINAL_LOCATOR_ENV_KEYS, isHarness } from '@weavecode/core';
import { messagingSurfaceFor } from '../surfaces.js';
import { syntheticSessionIds } from '../hooks/synthetic-sessions.js';
import { createEdgeExtract } from '../hooks/edge-extract.js';
import { startSessionSweeper } from '../hooks/session-sweeper.js';
import { startStatuslineCacheSweeper } from '../statusline/cache-sweeper.js';
import { readStatuslineFacts } from '../statusline/manager.js';
import { wireHookFilePipeline } from './hook-pipeline.js';
import { ensureBuiltinMarket, builtinMarketDir } from '../market/builtin.js';
import { HookRuleRegistry } from '../hooks/registry.js';
import { HookDispatcher } from '../hooks/dispatcher.js';
import { HookEventBus } from '../hooks/bus.js';
import { ResumeRunner } from '../hooks/resume-runner.js';
import { HeadlessRunner } from '../hooks/headless-runner.js';
import { MessageDeliverer } from '../hooks/message-deliverer.js';
import { QuestionTracker } from '../hooks/question-tracker.js';
import { SideQuestionRepository } from '../repositories/side-questions.js';
import { claimSideAnswer, type SideQuestionDeps } from '../hooks/side-questions.js';
import { DashboardRateCache } from '../hooks/dashboard-rate.js';
import { startDashboardPusher } from './dashboard-pusher.js';
import { startPromptFlusher } from '../hooks/prompt-flusher.js';
import { SessionWatchRepository } from '../repositories/session-watches.js';
import { PushSubscriptionRepository } from '../repositories/push-subscriptions.js';
import { UploadRepository } from '../repositories/uploads.js';
import { defaultUploadSessions } from './upload-sessions.js';
import { PushNotifier } from '../hooks/push-notify.js';
import { OrchestrationRepository, OrchestrationRunRepository } from '../repositories/orchestrations.js';
import { WatchEngine } from '../hooks/watch-engine.js';
import { OrchestrationEngine, createForkConditionJudge } from '../hooks/orchestration-engine.js';
import { createDecisionConditionJudge } from '../hooks/decision-judge.js';
import { readDecisionKey } from './decision-config.js';
import { openSessionTerminal } from './session-open.js';
import { loadAllPlugins, type PluginHost, type PluginManager, type WeavePluginLoader } from '../hooks/plugin-loader.js';
import { ToolkitService } from '../hooks/toolkit.js';
import { WatchService } from '../watch/watch-service.js';
import { SyncScheduler } from '../watch/sync-scheduler.js';
import { FingerprintCache } from '../install/fingerprint.js';
import { detectProjectUpdateCounts } from '../install/updates.js';
import { weaveRequestHandler } from './server.js';
import { startTlsServer, type TlsListener } from './tls.js';
import { DataBus } from './data-bus.js';
import { TerminalTopologyRefresher } from './terminal-topology-refresher.js';
import { SnapshotRefresher } from './snapshot-refresher.js';
import { SessionProbe, dbModelFactResolver, dbTranscriptPathResolver } from './session-probe.js';
import { InflightCountsRefresher } from './inflight-counts-refresher.js';
import { ProjectUpdatesRefresher } from './project-updates-refresher.js';
import { pidAliveOf } from './claude-liveness.js';
import { combinedLivenessOf } from './liveness.js';
import { promptTerminalChannel, readTerminalCounts } from './opener.js';
import { DEFAULT_BIND_HOST } from './port.js';
import { readDaemonState, writeDaemonState } from './state.js';
import { ensureDataLayout } from '../db/layout.js';
import { pruneFileIndexes } from './project-files.js';
import { readDaemonSettingsSync, setDaemonSettingsDb, DEFAULT_SERVER_SETTINGS } from './settings.js';
import { AuthService } from './dashboard-auth.js';
import { syncLaunchOnLogin } from './auto-start.js';
import { resolveStaticDir } from './static.js';

// 同 dev-entry：入口剥离 Claude Code child-session 标记与继承来的终端 pane
// 定位键，防污染派生物（后者留着会让新会话把自己报成活在别人的 pane 里）。
delete process.env.CLAUDE_CODE_CHILD_SESSION;
for (const key of TERMINAL_LOCATOR_ENV_KEYS) delete process.env[key];

/**
 * Start the daemon in the current process. Reads port from the daemon state
 * file (written by `weave daemon start`), binds the HTTP server on the
 * configured host (settings `server.bindHost`，默认 0.0.0.0——由 dashboard
 * 密码认证兜底，见 auth.ts), starts watching all registered projects, wires up
 * hook ingestion, and statically hosts the built SPA if present.
 */
export function startDaemon(): void {
  // 三档目录搬迁（data/ local/ cache/）必须先于读状态与开库：库文件自己也在搬。
  ensureDataLayout();
  const state = readDaemonState();
  if (!state) {
    console.error('Daemon state not found. Run `weave daemon start` first.');
    process.exit(1);
  }
  const db = openDatabase();
  setDaemonSettingsDb(db); // 配置统一落库：settings 表直连本库（测试可注入覆盖）
  const bindHost = readDaemonSettingsSync().server?.bindHost ?? DEFAULT_BIND_HOST;
  const tlsPort = readDaemonSettingsSync().server?.tlsPort ?? DEFAULT_SERVER_SETTINGS.tlsPort;
  // dashboard 认证（监听放开的配套）：口令材料落 <dataDir>/auth.json。首启生成的
  // 初始密码已写入 initial-password 标记文件——本进程 detached/stdio:ignore 启动，
  // 打印必丢，领取通道是 CLI（`weave dashboard`/`weave chpass` 读标记并显示一次）。
  const auth = new AuthService();
  if (auth.initialPassword) {
    console.log(`[weave] initial dashboard password: ${auth.initialPassword}`);
  }
  const projects = new ProjectRepository(db);
  // 索引快照是 cache 档：已删项目的快照没人再读，启动清一次（大仓库一份按 MB 计）。
  pruneFileIndexes(projects.list().map((p) => p.id));
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
  let pluginLoaderRef: WeavePluginLoader | undefined;
  const pluginManager: PluginManager = {
    list: () => pluginLoaderRef?.list() ?? [],
    setPluginEnabled: (id, enabled) => pluginLoaderRef?.setPluginEnabled(id, enabled) ?? false,
    reloadAll: async () => {
      await pluginLoaderRef?.reloadAll();
    },
    // 手动重新扫描（dashboard 按钮）：重登记根 → 重扫 → watcher 重挂（见 rescanRoots）。
    rescan: async () => {
      await pluginLoaderRef?.rescanRoots(projects.list(), libraries);
    },
  };
  // 批 10 工具包服务（扫描/开关）；states 与 loader 同库同表。
  const toolkit = new ToolkitService({
    projects,
    states: new PluginStateRepository(db),
    plugins: pluginManager,
    libraries,
  });
  // classify handler 的无头判定器：edgeExtract 在引擎段才装配，用引用占位。
  const classifyRef: {
    run: ((input: { sessionId: string; prompt: string }) => Promise<string | null>) | null;
  } = { run: null };
  const hookDispatcher = new HookDispatcher({
    registry: hookRegistry,
    dispatches: hookDispatches,
    bus: hookBus,
    projects,
    sessions: hookSessions,
    plugins: pluginHostHolder,
    pluginStates: new PluginStateRepository(db),
    classify: (input) => (classifyRef.run ? classifyRef.run(input) : Promise.resolve(null)),
    sessionTitleOf: async (sessionId) => {
      const src = hookEvents.listBySession(sessionId, 1).at(-1)?.source;
      return isHarness(src) ? (harnesses.get(src)?.titles?.sessionTitleOf(sessionId) ?? null) : null;
    },
  });
  // 内置仓落地必须先于装载：内置规则包装载根与工具包扫描根都指向 <dataDir>/market/weave。
  void ensureBuiltinMarket({ libraries })
    .then((result) => {
      if (result.error) {
        console.error(`[weave] builtin market unavailable: ${result.error}`);
      } else if (result.changed) {
        console.log(
          `[weave] builtin market ${result.form === 'link' ? 'linked' : 'copied'} -> ${builtinMarketDir(libraries.dataRoot)}`,
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
      loader.watchRoots();
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
    // 模态框在场时层② 不盲注（tracker 在下面构造，闭包惰性取）。
    blockedByQuestion: (sessionId) => questionTracker.get(sessionId) != null,
    // 判活图（claude 注册表 + codex 锁探针缓存）：判死落定/诊断全消费它。
    livenessOf: combinedLivenessOf,
  });
  startPromptFlusher(messageDeliverer);
  // session-orchestration 批 2：空闲订阅引擎（ingest 即时 fire + sweeper 补射）
  const sessionWatches = new SessionWatchRepository(db);
  const watchEngine = new WatchEngine({
    watches: sessionWatches,
    deliverer: messageDeliverer,
    sessions: hookSessions,
    bus: hookBus,
    livenessOf: combinedLivenessOf,
  });
  // Web Push 发送器（提醒第三条腿）：dashboard 订阅 fire 时向全部浏览器订阅
  // 推送——页面关着本地通知路径全死，只有厂商推送服务能唤起 SW。
  const pushSubscriptions = new PushSubscriptionRepository(db);
  const uploads = new UploadRepository(db);
  const pushNotifier = new PushNotifier({
    subscriptions: pushSubscriptions,
    sessions: hookSessions,
    bus: hookBus,
  });
  // 跨会话编排：定义 + 运行日志（统一视图），引擎的权威态在内存、日志落行。
  const orchestrations = new OrchestrationRepository(db);
  const orchestrationRuns = new OrchestrationRunRepository(db);
  // 会话转录探测（中断态）：hook 事件旁路带上转录路径 → 只留内存，按需读尾部。
  const sessionProbe = new SessionProbe(
    dbTranscriptPathResolver(hookEvents),
    // 换模型闩只在内存，重启即清零——回读库里这条会话最近一条落定事件补回来。
    dbModelFactResolver(hookEvents, (sessionId) => hookSessions.getBySessionId(sessionId)?.harness ?? null),
  );
  // 阻塞问答跟踪（AskUserQuestion / 计划与权限确认）：内存状态机挂 ingest
  // 事件流（inbox-worker 消费线程驱动），重启即 seedFromDb 重放补状态。
  const questionTracker = new QuestionTracker({
    sessions: hookSessions,
    hookEvents,
    // 新挂起待答 → 广播提醒帧（web 弹 toast/系统通知；作答入口仍是手动点图标）。
    onPending: (entry) => {
      hookBus.emit({
        kind: 'question.pending',
        sessionId: entry.sessionId,
        harness: entry.harness,
        count: entry.questions.length,
        at: entry.at,
      });
    },
    // 手动了结掉那个对话框（ESC / 选掉）⇒ 问题面失据，读时顺手摘掉。
    interruptedAt: (sessionId) => {
      const session = hookSessions.getBySessionId(sessionId);
      return session ? sessionProbe.interruptedAt(sessionId, session.lastSeenAt) : null;
    },
  });
  questionTracker.seedFromDb();
  // 旁路会话历史（claude = /btw）：宿主两侧都不落盘，只有 weave 自己发过的问句
  // 才知道——回答由采集事件认领回来（判据归 harness 能力面）。
  const sideQuestions = new SideQuestionRepository(db);
  // 仪表盘速率快照：ingest 时累加、读侧 O(点数)；daemon 重启后首次读回填一次库。
  const dashboardRate = new DashboardRateCache();
  // 首页仪表盘：每 10s 推一帧 dashboard.rate（快照读内存桶，总量走索引轻查询）
  const dashboardPusher = startDashboardPusher({
    rate: dashboardRate,
    events: hookEvents,
    sessions: hookSessions,
    projects,
    bus: hookBus,
  });
  const sideQuestionDeps: SideQuestionDeps = {
    repo: sideQuestions,
    bus: hookBus,
    // 稳定窗落定才收起宿主的 btw 面板（一记 ESC）：面板是 local JSX UI，开着会
    // 一直吃键盘——后续投递会落进面板里白丢。ESC 正是它的关闭键。挪到落定点，
    // 稳定窗内的误认领被替换时就不再多打这一记。
    settle: (row) => void messageDeliverer.interrupt(row.sessionId),
  };
  const watch = new WatchService(projects);
  watch.start();
  const fingerprintCache = new FingerprintCache();
  // 数据变更帧总线：SSE 的载荷推送源（各隐藏刷新器共用一条）。
  const dataBus = new DataBus();
  // 项目行「有更新待同步」角标：项目插件源（`.weave/plugins` 的模板）变更 →
  // 重算全项目漂移、值变才推绝对值快照（含 0）。
  const updatesRefresher = new ProjectUpdatesRefresher(
    () => detectProjectUpdateCounts(projects.list(), libraries.list(), fingerprintCache),
    dataBus,
    hookBus,
    () => dataBus.hasSubscribers(),
  );
  const syncScheduler = new SyncScheduler(projects, libraries, {
    cache: fingerprintCache,
    plugins: pluginManager,
    onSynced: () => void updatesRefresher.refreshNow(true),
  });
  syncScheduler.start();
  // 终端世界的隐藏刷新（项目卡角标 + 会话列表分块）：前端不再轮询，改由后端
  // 「有人看时每 30s 探一次、只在值变化时推」。探测本身要 spawn `wezterm cli`，
  // 所以绑 SSE 客户端数——没人开看板就一次都不探；会话所在屏幕复用同一份旁路
  // pane env（后端探活缓存也同源），不为分块多打一枪。
  const terminalRefresher = new TerminalTopologyRefresher(
    async () => ({
      counts: await readTerminalCounts(projects.list()),
      terminals: await messageDeliverer.sessionTerminals(),
    }),
    dataBus,
    { shouldRun: () => dataBus.hasSubscribers(), graceMs: 10_000 },
  );
  terminalRefresher.start();
  // 会话存活（终端按钮图标）同理：claude 进程被杀无 hook 事件，GET 的 pidAlive
  // 会卡旧值——判活零 spawn（注册表 + kill 0；codex 走锁探针缓存），15s 一拍、
  // 只推判得动的快照。
  const livenessRefresher = new SnapshotRefresher(
    () => {
      const liveness = combinedLivenessOf();
      const alive: Record<string, boolean> = {};
      for (const s of hookSessions.listWithCounts()) {
        const v = pidAliveOf(s, liveness);
        if (v !== null) alive[s.sessionId] = v;
      }
      return { alive };
    },
    dataBus,
    { key: 'sessionLiveness', shouldRun: () => dataBus.hasSubscribers() },
  );
  livenessRefresher.start();
  // 会话中断态同理，且更极端：按 ESC 打断后多数连 Stop 都不发（实测 45 次里 41 次），
  // 会话会永远停在「生成中」。只探「看着还在跑」的会话（turnOpen），周期比判活短
  // ——零子进程，就一次 statSync（文件没长过连读都省）。
  const interruptRefresher = new SnapshotRefresher(
    () => {
      const interrupted: Record<string, number> = {};
      for (const s of hookSessions.listWithCounts()) {
        if (s.turnOpen !== true) continue;
        const at = sessionProbe.interruptedAt(s.sessionId, s.lastSeenAt);
        if (at !== null) interrupted[s.sessionId] = at;
      }
      return { interrupted };
    },
    dataBus,
    { key: 'sessionInterrupt', intervalMs: 5_000, shouldRun: () => dataBus.hasSubscribers() },
  );
  interruptRefresher.start();
  // 对话页底条的 git 事实（分支 / 上游差异 / diff 行数）：由宿主的状态栏脚本算好
  // 落在缓存里，weave 自己不探 git。缓存每渲染一次就重写，但没人会通知 dashboard——
  // 底条只在挂载时读一次，两扇对话窗开窗时刻不同就停在不同的快照上（同一个仓库，
  // 一个显示 main (20↑)、另一个还是 main）。5s 一拍复读活跃项目的缓存，事实变了
  // 就发失效帧，底条既有的 invalidator 各自重拉。
  const statuslineRefresher = new SnapshotRefresher(
    () => {
      const facts: Record<number, unknown> = {};
      for (const p of projects.list()) facts[p.id] = readStatuslineFacts(p.path);
      return facts;
    },
    dataBus,
    {
      key: 'statusline',
      intervalMs: 5_000,
      shouldRun: () => dataBus.hasSubscribers(),
      invalidateOnly: true,
    },
  );
  statuslineRefresher.start();
  // 在途消息角标同理，但没有定时器：变化源全是 message.* 帧（事件驱动），
  // 帧到即重算、值变才推绝对值快照；新 SSE 客户端接入补一份首帧。
  const inflightRefresher = new InflightCountsRefresher(
    () => messageDeliverer.listInflightCounts(),
    dataBus,
    hookBus,
  );
  // 编排边级提取（fork 无头回合）：合成名单经 hookPipeline 推给消费线程过滤；
  // pipeline 在引擎之后装配，用引用占位（提取跑起来时必然已赋值）。
  let hookPipelineRef: ReturnType<typeof wireHookFilePipeline> | null = null;
  const edgeExtract = createEdgeExtract({
    sessions: hookSessions,
    projects,
    harnessOf: (sessionId) => {
      const latest = hookEvents.listBySession(sessionId, 1);
      const src = latest[latest.length - 1]?.source;
      return isHarness(src) ? src : null;
    },
    surfaceFor: messagingSurfaceFor,
    headless: headlessRunner,
    onSyntheticChange: () => hookPipelineRef?.pushSyntheticSessions(syntheticSessionIds()),
  });
  classifyRef.run = (input) => edgeExtract.run(input);
  // 条件边判断链：配了决策模型（settings decision 段 + key）先问它（Jev 兼容
  // noul，强 yes/no 出结论、判不准与失败回落），没配/回落都到 fork 子 Agent。
  // 配置每次判断现读——设置页改完即时生效，不用重启 daemon。
  const conditionJudge = createDecisionConditionJudge({
    config: async () => {
      const decision = readDaemonSettingsSync().decision;
      if (!decision?.baseUrl || !decision.model) return null;
      const apiKey = readDecisionKey();
      return apiKey ? { baseUrl: decision.baseUrl, model: decision.model, apiKey } : null;
    },
    fallback: createForkConditionJudge({
      supports: (sessionId) => edgeExtract.supports(sessionId),
      extract: (input) => edgeExtract.run(input),
    }),
  });
  // 编排引擎：目标会话判死时拉起终端（与会话列表「打开会话」同一份实现）。
  // 新起的 resume 进程要先在 claude 注册表落名，投递器才不把它判成离线——
  // 等它出现（最多 8s）；等不到也放行，交给队列在 SessionStart 后冲洗。
  const orchestrationEngine = new OrchestrationEngine({
    orchestrations,
    runs: orchestrationRuns,
    deliverer: messageDeliverer,
    sessions: hookSessions,
    bus: hookBus,
    supportsExtract: (sessionId) => edgeExtract.supports(sessionId),
    extract: (input) => edgeExtract.run(input),
    conditionJudge,
    // 人在场闸：目标闲着且用户刚在看 → 编排投递 defer（搭用户下一轮的车），
    // 防层② 击键突袭手输中的输入框（评审点名的中高概率/高后果风险）。
    deferWhenUserPresent: true,
    ensureOpen: async (sessionId) => {
      // 回执基线：拉起前该会话的最新事件 id。`--resume` 起来的宿主会补一笔
      // SessionStart——那才是「真进了会话」；注册表出现 pid 只说明进程起来了。
      const baseline = hookEvents.listBySession(sessionId, 1).at(-1)?.id ?? 0;
      const opened = await openSessionTerminal(
        { hookSessions, hookEvents, projects, harnesses, sessionProbe, terminalRefresher },
        sessionId,
      );
      if (!opened.ok) return opened;
      let alive = false;
      for (let i = 0; i < 60; i++) {
        // 15s 预算：冷启动 + 宿主落 SessionStart 的实测富余
        const recent = hookEvents.listBySession(sessionId, 20);
        if (recent.some((e) => e.id > baseline && e.eventType === 'SessionStart')) {
          return { ok: true, ack: 'session-start' };
        }
        if (combinedLivenessOf().get(sessionId) === true) alive = true;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      return alive
        ? { ok: true, ack: 'registry' }
        : { ok: false, error: 'session did not report ready within 15s' };
    },
  });
  orchestrationEngine.rearm();
  // 定时触发：30s 一枪（同分钟只 fire 一次、跑着的跳过）。
  const cronTimer = setInterval(() => orchestrationEngine.cronTick(), 30_000);
  cronTimer.unref();
  // 空会话自动清理：只残留一条 SessionStart 的会话（开了就 /resume 走掉的那种）
  // 延迟清掉——真实场景里它们只是噪音，且父会话已经 /resume 到别处。
  startSessionSweeper({
    sessions: hookSessions,
    events: hookEvents,
    dispatches: hookDispatches,
    deliverer: messageDeliverer,
    watches: sessionWatches,
    orchestrations,
    watchEngine,
    orchestrationEngine,
    questions: questionTracker,
    sideQuestions,
    probe: sessionProbe,
    uploads,
    uploadSessions: defaultUploadSessions,
    livenessOf: combinedLivenessOf,
  });
  // statusline 渲染缓存（<dataDir>/statusline/）：由短命 helper 进程写，没有常驻
  // 进程知道它们何时作废 → 与空会话同处定期回收（含旧版散在系统临时目录的存量）。
  startStatuslineCacheSweeper();
  // hook 文件管道（mirror 镜像 + inbox 消费线程）：与 dev-entry 共用同一装配
  const hookPipeline = wireHookFilePipeline({
    projects,
    rules: hookRegistry,
    sessions: hookSessions,
    bus: hookBus,
    dispatcher: hookDispatcher,
    watchEngine,
    orchestrationEngine,
    messagePipe: messageDeliverer,
    questionTracker,
    sideQuestions: {
      onEvent: (input) => {
        claimSideAnswer(sideQuestionDeps, input);
      },
    },
    sessionProbe,
    uploads,
    dashboardRate,
    terminalTopologyKick: () => void terminalRefresher.refreshNow(),
  });
  hookPipelineRef = hookPipeline;
  const staticDir = resolveStaticDir();

  // handler 单独建一次：HTTP 与局域网 HTTPS 两个监听共享（fingerprint 缓存同源）。
  const requestHandler = weaveRequestHandler({
    projects,
    port: state.port,
    tlsPort,
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
    interruptRefresher,
    livenessRefresher,
    sessionProbe,
    inflightRefresher,
    updatesRefresher,
    hookDispatcher,
    hookRunner,
    messageDeliverer,
    uploads,
    questionTracker,
    sideQuestions: sideQuestionDeps,
    sessionWatches,
    watchEngine,
    orchestrations,
    orchestrationRuns,
    orchestrationEngine,
    pushSubscriptions,
    pushNotifier,
    onAttach: dashboardPusher.attach,
    dashboardRefresh: dashboardPusher.attach,
    hookPlugins: pluginManager,
    hookMirror: hookPipeline.mirror,
    pluginStates: new PluginStateRepository(db),
    toolkit,
    auth,
  });
  const server = http.createServer(requestHandler);

  // 局域网 HTTPS 监听（自签证书，与 HTTP 同 handler/认证面；端口被占等失败仅警告降级）。
  let tls: TlsListener | null = null;
  void startTlsServer({ port: tlsPort, bindHost, handler: requestHandler }).then((r) => {
    tls = r;
  });

  const shutdown = (): void => {
    pluginLoaderRef?.stopWatching(); // 取当前一代 watcher（「重新扫描」会换代，不能存启动时那个 stop）
    terminalRefresher.stop();
    livenessRefresher.stop();
    interruptRefresher.stop();
    syncScheduler.stop();
    watch.stop();
    // 在飞子进程（中继 / headless 回合）随 daemon 一起收：不留孤儿占资源
    headlessRunner.killAll();
    clearInterval(cronTimer);
    dashboardPusher.stop();
    void hookPipeline.stop();
    server.close();
    tls?.server.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  server.listen(state.port, bindHost, () => {
    // Record the real pid + actual bind host now that we are listening.
    writeDaemonState({ ...state, pid: process.pid, host: bindHost, tlsPort });
    // 开机自启对账：设置是唯一事实源（开着但系统项被清 → 重建；反之清掉）。
    syncLaunchOnLogin();
  });
}
