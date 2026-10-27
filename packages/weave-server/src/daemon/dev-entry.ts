/**
 * Foreground dev entry for `pnpm dev:server`.
 *
 * Unlike the production entry (spawned by `weave daemon start`, which reads
 * the daemon state file), this binds the default port and logs to stdout so
 * `tsx watch` can hot-reload during development. Binding host follows the same
 * `server.bindHost` setting (default 0.0.0.0) and the same dashboard auth as
 * production — 前台运行，首启的初始密码直接打在屏幕上。
 */
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
import { loadAllPlugins, type PluginManager } from '../hooks/plugin-loader.js';
import { ensureBuiltinMarket, builtinMarketDir } from '../market/builtin.js';
import { ToolkitService } from '../hooks/toolkit.js';
import { startSessionSweeper } from '../hooks/session-sweeper.js';
import { startStatuslineCacheSweeper } from '../statusline/cache-sweeper.js';
import { readStatuslineFacts } from '../statusline/manager.js';
import { WatchService } from '../watch/watch-service.js';
import { weaveRequestHandler } from './server.js';
import { startTlsServer, type TlsListener } from './tls.js';
import { DataBus } from './data-bus.js';
import { TerminalTopologyRefresher } from './terminal-topology-refresher.js';
import { SnapshotRefresher } from './snapshot-refresher.js';
import { SessionProbe, dbModelFactResolver, dbTranscriptPathResolver } from './session-probe.js';
import { InflightCountsRefresher } from './inflight-counts-refresher.js';
import { ProjectUpdatesRefresher } from './project-updates-refresher.js';
import { FingerprintCache } from '../install/fingerprint.js';
import { detectProjectUpdateCounts } from '../install/updates.js';
import { pidAliveOf } from './claude-liveness.js';
import { combinedLivenessOf } from './liveness.js';
import { promptTerminalChannel, readTerminalCounts } from './opener.js';
import { wireHookFilePipeline } from './hook-pipeline.js';
import { DEFAULT_PORT, DAEMON_HOST, DEFAULT_BIND_HOST, findFreePort, isPortFree } from './port.js';
import { writeDaemonState } from './state.js';
import { ensureDataLayout } from '../db/layout.js';
import { pruneFileIndexes } from './project-files.js';
import { readDaemonSettingsSync, setDaemonSettingsDb, DEFAULT_SERVER_SETTINGS } from './settings.js';
import { AuthService } from './dashboard-auth.js';
import { resolveStaticDir } from './static.js';

// daemon 若启于 Claude Code 会话内，环境携带的 CLAUDE_CODE_CHILD_SESSION 会
// 传染给一切派生物（「在终端中打开」的终端、resume 出的子会话——表现为
// 「Transcript saving is off」提示且 transcript 不落盘）。入口统一剥离，
// 下游 spawn 无需各自防御。
const hadChildMarker = 'CLAUDE_CODE_CHILD_SESSION' in process.env;
delete process.env.CLAUDE_CODE_CHILD_SESSION;

// 同理剥掉**继承来的终端 pane 定位键**：daemon 从某个会话的 pane 里起时，
// 这些键会随 env 传给 weave 开的新终端（wt 原样转交调用方 env），新会话遂把
// 自己报成活在**别人的 pane** 里——停止/作答的击键打进别人的会话。daemon 自己
// 从不在任何 pane 里（wezterm 后端新 pane 的 WEZTERM_* 由 wezterm 自己注入）。
for (const key of TERMINAL_LOCATOR_ENV_KEYS) delete process.env[key];

async function main(): Promise<void> {
  // 三档目录搬迁（data/ local/ cache/）必须先于写状态与开库：库文件自己也在搬。
  ensureDataLayout();
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
  const bindHost = readDaemonSettingsSync().server?.bindHost ?? DEFAULT_BIND_HOST;
  const tlsPort = readDaemonSettingsSync().server?.tlsPort ?? DEFAULT_SERVER_SETTINGS.tlsPort;
  const auth = new AuthService();
  if (auth.initialPassword) {
    console.log(`[dev] initial dashboard password: ${auth.initialPassword}`);
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
  // 内置仓落地必须先于装载：内置规则包装载根与工具包扫描根都指向它。
  {
    const r = await ensureBuiltinMarket({ libraries });
    if (r.error) console.error(`[dev] builtin market unavailable: ${r.error}`);
    else if (r.changed) {
      console.log(
        `[dev] builtin market ${r.form === 'link' ? 'linked' : 'copied'} -> ${builtinMarketDir(libraries.dataRoot)}`,
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
  // 「重新扫描」与 start.ts 同口径（dev 下也要能纳管运行期新建的根）
  const pluginManager: PluginManager = {
    list: () => hookPlugins.list(),
    setPluginEnabled: (id, enabled) => hookPlugins.setPluginEnabled(id, enabled),
    reloadAll: () => hookPlugins.reloadAll(),
    rescan: () => hookPlugins.rescanRoots(projects.list(), libraries),
  };
  // 批 10 工具包服务（loader 已就绪，直接挂载）
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
    plugins: hookPlugins,
    pluginStates: new PluginStateRepository(db),
    classify: (input) => (classifyRef.run ? classifyRef.run(input) : Promise.resolve(null)),
    sessionTitleOf: async (sessionId) => {
      const src = hookEvents.listBySession(sessionId, 1).at(-1)?.source;
      return isHarness(src) ? (harnesses.get(src)?.titles?.sessionTitleOf(sessionId) ?? null) : null;
    },
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
  // 消息域（消息域重塑，与 start.ts 同装配）：纯递送管道 + 隐藏冲洗器 +
  // prompt 层② 终端兜底（随 settings 取后端）。
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
    // 读屏通道的回答落库（codex = /side；repo 在下面构造，闭包惰性取）。
    sideAnswerStore: {
      answerById: (sessionId, question, answer) => {
        sideQuestions.answerById(sessionId, question, answer);
      },
    },
  });
  startPromptFlusher(messageDeliverer);
  // session-orchestration 批 2（与 start.ts 同装配）：空闲订阅引擎。
  const sessionWatches = new SessionWatchRepository(db);
  const watchEngine = new WatchEngine({
    watches: sessionWatches,
    deliverer: messageDeliverer,
    sessions: hookSessions,
    bus: hookBus,
    livenessOf: combinedLivenessOf,
  });
  // Web Push 发送器（与生产入口同一装配）：fire 时向浏览器推送订阅投递。
  const pushSubscriptions = new PushSubscriptionRepository(db);
  const uploads = new UploadRepository(db);
  const pushNotifier = new PushNotifier({
    subscriptions: pushSubscriptions,
    sessions: hookSessions,
    bus: hookBus,
  });
  // 跨会话编排（与 start.ts 同装配）：定义 + 运行日志 + 引擎。
  const orchestrations = new OrchestrationRepository(db);
  const orchestrationRuns = new OrchestrationRunRepository(db);
  // 会话转录探测（中断态）：与生产入口同一装配——见 start.ts 的说明。
  const sessionProbe = new SessionProbe(
    dbTranscriptPathResolver(hookEvents),
    // 换模型闩只在内存，重启即清零——回读库里这条会话最近一条落定事件补回来。
    dbModelFactResolver(hookEvents, (sessionId) => hookSessions.getBySessionId(sessionId)?.harness ?? null),
  );
  // 阻塞问答跟踪（与生产入口同一装配）：内存状态机 + 重启 seedFromDb 补状态。
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
  // 旁路会话历史（claude = /btw）：与生产入口同一装配——见 start.ts 的说明。
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
  // 数据变更帧总线 + 终端世界隐藏刷新（角标 + 会话分块）：前端不再轮询，改由
  // 后端「有人看时每 30s 探一次、只在值变化时推」。探测要 spawn `wezterm cli`，
  // 绑 SSE 客户端数。
  const dataBus = new DataBus();
  const terminalRefresher = new TerminalTopologyRefresher(
    async () => ({
      counts: await readTerminalCounts(projects.list()),
      terminals: await messageDeliverer.sessionTerminals(),
    }),
    dataBus,
    { shouldRun: () => dataBus.hasSubscribers(), graceMs: 10_000 },
  );
  terminalRefresher.start();
  // 会话存活（终端按钮图标）：与生产入口同一装配——被杀进程无 hook 事件，
  // GET 的 pidAlive 卡旧值；15s 一拍、值变才推判得动的绝对值快照。
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
  // 会话中断态（同上）：ESC 打断后多数连 Stop 都不发，只探看着还在跑的会话。
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
  // 在途消息角标（会话行）：无定时器——message.* 帧驱动重算、值变才推快照。
  const inflightRefresher = new InflightCountsRefresher(
    () => messageDeliverer.listInflightCounts(),
    dataBus,
    hookBus,
  );
  // 编排边级提取（fork 无头回合）：与 start.ts 同装配，pipeline 引用占位后赋值。
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
  // 条件边判断链（与 start.ts 同装配）：决策模型优先、fork 回落。
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
  // 编排引擎（与 start.ts 同装配）：判死拉起终端 + 30s cron 一拍。
  const orchestrationEngine = new OrchestrationEngine({
    orchestrations,
    runs: orchestrationRuns,
    deliverer: messageDeliverer,
    sessions: hookSessions,
    bus: hookBus,
    supportsExtract: (sessionId) => edgeExtract.supports(sessionId),
    extract: (input) => edgeExtract.run(input),
    conditionJudge,
    // 人在场闸（与 start.ts 同口径）：目标闲着且用户刚在看 → defer 搭车。
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
  const cronTimer = setInterval(() => orchestrationEngine.cronTick(), 30_000);
  cronTimer.unref();
  // 项目行「有更新待同步」角标：项目插件根变更（plugin.reloaded）重算、值变才推。
  // dev 入口没有 SyncScheduler（自动同步不在此跑），故只有事件与新客户端两个触发源。
  const updatesFingerprints = new FingerprintCache();
  const updatesRefresher = new ProjectUpdatesRefresher(
    () => detectProjectUpdateCounts(projects.list(), libraries.list(), updatesFingerprints),
    dataBus,
    hookBus,
    () => dataBus.hasSubscribers(),
  );
  // 空会话自动清理（与生产入口同一装配点）：dev 入口此前漏挂 → 只残留一条
  // SessionStart 的会话在 dev 下永不消失，一直挂在会话列表里显示「就绪」。
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
  // statusline 渲染缓存（与生产入口同一装配点）：helper 是短命进程，缓存没人管
  // 就会只增不减（旧版散在系统临时目录，实测两天 1151 个文件）。
  startStatuslineCacheSweeper();
  // hook 文件管道（mirror 镜像 + inbox 消费线程）：与 start.ts 共用同一装配
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
    port,
    tlsPort,
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
    interruptRefresher,
    livenessRefresher,
    sessionProbe,
    inflightRefresher,
    updatesRefresher,
    hookDispatcher,
    hookRunner,
    messageDeliverer,
    terminal: promptTerminalChannel(() => readDaemonSettingsSync().terminal),
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

  // 局域网 HTTPS 监听（自签证书，与 HTTP 同 handler/认证面；失败降级仅警告）。
  let tls: TlsListener | null = null;
  void startTlsServer({ port: tlsPort, bindHost, handler: requestHandler }).then((r) => {
    tls = r;
    if (r) console.log(`[dev] weave daemon tls listening on https://${bindHost}:${r.port}`);
  });

  const shutdown = (): void => {
    terminalRefresher.stop();
    livenessRefresher.stop();
    interruptRefresher.stop();
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

  server.listen(port, bindHost, () => {
    writeDaemonState({ pid: process.pid, port, startedAt: new Date().toISOString(), host: bindHost, tlsPort });
    console.log(`[dev] weave daemon listening on http://${bindHost}:${port}`);
    console.log(`[dev] cli/dashboard local url: http://${DAEMON_HOST}:${port}`);
    console.log(`[dev] child-session marker stripped: ${hadChildMarker}`);
    if (staticDir) console.log(`[dev] static: ${staticDir}`);
    else console.log('[dev] static: (web/dist not built — run pnpm build:web)');
  });
}

main();
