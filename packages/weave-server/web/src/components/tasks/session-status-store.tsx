import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  api,
  type HookDispatch,
  type PendingQuestionEntry,
  type SessionRow,
  type SessionTerminal,
} from '@/lib/api';
import type { ModelAliasTarget } from '@weavecode/harness';
import { useAuthState } from '@/lib/auth';
import { useToast } from '@/components/Toast';
import { subscribeHook, subscribePush, paneSessionId, type HookFrame } from '@/lib/sse';
import {
  mergeSharedAccount,
  readSharedAccount,
  subscribeSharedAccount,
  writeSharedAccount,
} from './shared-account';
import {
  countSessionsByHarness,
  deriveSessionStatus,
  STALE_SUBAGENT_MS,
  type HarnessSessionCounts,
  type SessionStatus,
} from './session-status';

interface SessionStatusValue {
  /** 全量会话（daemon 侧最近 200，created_at 倒序）；null = 首次加载中。 */
  sessions: SessionRow[] | null;
  /** 全量派发窗口（最近 200）——任务视图分组/待派发区复用同一份。 */
  dispatches: HookDispatch[];
  /** sessionId → 状态。 */
  statuses: Map<string, SessionStatus>;
  /** projectId → 该项目按 harness 的「运行中/打开」计数（项目行徽标）。 */
  projectStats: Map<number, HarnessSessionCounts[]>;
  /** 最近一次拉取失败的原因（成功即清空）；派发拉取失败不算错（状态降级即可）。 */
  error: string | null;
  /** sessionId → 在途消息条数（服务端 push 'inflightCounts' 的绝对值快照）。 */
  inflight: Map<string, number>;
  /** sessionId → 常驻投递失败行条数（同一帧的 failed 快照；重发/移除即清）。 */
  failedDeliveries: Map<string, number>;
  /** sessionId → 待答阻塞问题（AskUserQuestion / 计划与权限确认）。 */
  questions: Map<string, PendingQuestionEntry>;
  /** harness → 模型别名表（别名 → 真名）：模型下拉两个都摆，真名也认回别名那档。 */
  modelCatalog: Record<string, ModelAliasTarget[]>;
  /** `<projectId>|<targetId>` → 终端窗口实况可见性（terminalTopology 帧随推；
   *  会话列表终端分块组头的「眼睛」同源读它，不再自己打 N 枪）。 */
  terminalVisibility: Map<string, 'visible' | 'hidden'>;
  /** 首屏三路（sessions/dispatches/questions）各自是否已响应过至少一拍（含失败）。 */
  settled: { sessions: boolean; dispatches: boolean; questions: boolean };
  /** 手动重拉（刷新按钮；SSE 之外兜底）。resolve = 会话列表拉取失败的原因，成功为 null。 */
  refresh: () => Promise<string | null>;
}

const Ctx = createContext<SessionStatusValue | null>(null);

/** 落共享快照：主窗整份写（sessions 全量只它有）；pane 窗只写自己刷新出的
 *  dispatches/questions（派发/作答的写入口以对话窗为准，其余窗广播对齐）。 */
function shareSnapshot(
  sessions: SessionRow[] | null,
  dispatches: HookDispatch[],
  questions: PendingQuestionEntry[],
  modelCatalog: Record<string, ModelAliasTarget[]>,
): void {
  if (paneSessionId()) {
    mergeSharedAccount({ dispatches, questions, modelCatalog });
    return;
  }
  writeSharedAccount({ at: Date.now(), sessions, dispatches, questions, modelCatalog });
}

/** 后端 push 的行级补丁最新一份（terminal / pidAlive / interruptedAt / effort）。 */
export interface RowPushPatch {
  terminal?: Record<string, SessionTerminal | null>;
  alive?: Record<string, boolean>;
  interrupted?: Record<string, number>;
  effort?: Record<string, string>;
}

/**
 * 把 push 补丁并上一批行（GET 回来的或已有的）。四字段各自口径，别互相抄：
 * terminal/pidAlive/effort **缺键 = 不动**（那会话这帧没报），interrupted
 * **缺键 = 已恢复**（不在快照里即被新事件盖过）。terminal 按 id 比（每次推都是新对象）。
 */
export function applyRowPush(rows: SessionRow[], patch: RowPushPatch): SessionRow[] {
  const { terminal, alive, interrupted, effort } = patch;
  if (!terminal && !alive && !interrupted && !effort) return rows;
  let changed = false;
  const next = rows.map((s) => {
    let row = s;
    const t = terminal?.[s.sessionId];
    if (t !== undefined && row.terminal?.id !== t?.id) row = { ...row, terminal: t };
    const a = alive?.[s.sessionId];
    if (a !== undefined && row.pidAlive !== a) row = { ...row, pidAlive: a };
    const e = effort?.[s.sessionId];
    if (e !== undefined && row.effort !== e) row = { ...row, effort: e };
    if (interrupted) {
      const i = interrupted[s.sessionId] ?? null;
      if ((row.interruptedAt ?? null) !== i) row = { ...row, interruptedAt: i };
    }
    if (row !== s) changed = true;
    return row;
  });
  return changed ? next : rows;
}

/**
 * 全局会话状态总线（唯一真源）：一处拉 sessions + dispatches、一处经 SSE 总线
 * 订阅 hook 帧（overlay / 子 agent 存活账）、一处推导 deriveSessionStatus。
 * 项目行徽标、任务视图会话列表、全局总览都从这里取——此前三处各自 fetch +
 * 各自推导（且各自漏掉别人的输入），状态会漂移。
 */
export function SessionStatusProvider({ children }: { children: ReactNode }) {
  const auth = useAuthState();
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [dispatches, setDispatches] = useState<HookDispatch[]>([]);
  const [error, setError] = useState<string | null>(null);
  /** 帧处理里要判「这个会话在不在列表上」（新会话第一笔事件得整套重拉一次）。 */
  const sessionsRef = useRef<SessionRow[] | null>(null);
  sessionsRef.current = sessions;
  const dispatchesRef = useRef<HookDispatch[]>([]);
  dispatchesRef.current = dispatches;
  /** 上一次**整套**重拉的落地时刻：帧驱动的补丁攒够这么久就对一次全量
   *  （会话被保留策略删掉、标题改了这类没有事件信号的变化只能这么兜）。 */
  const lastFullAt = useRef(0);
  /** SSE 即时状态覆盖（帧已到、refetch 未回；refetch 完成后以 API 为准清除）。 */
  const [overlay, setOverlay] = useState<Map<string, SessionStatus>>(new Map());
  /** 后台子 agent 存活账（sessionId → agentId → 最近事件时刻）：spawn 出生、
   *  自身事件续期，Stop/SubagentStop 的 background_tasks 快照整集对账；
   *  读取侧 STALE_SUBAGENT_MS 兜底。回合开合不用帧态——以服务端 turnOpen 为权威。 */
  const [subagents, setSubagents] = useState<Map<string, Map<string, number>>>(new Map());
  /** 在途消息角标（后端 push 的绝对值快照；漏帧由下一次推自我校正）。 */
  const [inflight, setInflight] = useState<Map<string, number>>(new Map());
  /** 在途投递失败角标（同帧 failed 快照；failed 是状态机更靠后的态，优先展示）。 */
  const [failedDeliveries, setFailedDeliveries] = useState<Map<string, number>>(new Map());
  /** 待答阻塞问题：服务端变化时经 `sessionQuestions` 帧直推绝对值快照
   *  （tracker 内存态变化即推；帧到即写，不再帧到后重拉 GET）。 */
  const [questions, setQuestions] = useState<Map<string, PendingQuestionEntry>>(new Map());
  const [modelCatalog, setModelCatalog] = useState<Record<string, ModelAliasTarget[]>>({});
  const questionsRef = useRef<Map<string, PendingQuestionEntry>>(new Map());
  questionsRef.current = questions;
  const modelCatalogRef = useRef<Record<string, ModelAliasTarget[]>>({});
  modelCatalogRef.current = modelCatalog;
  /** 后端 push 的行级补丁最新一份（terminal / pidAlive / interruptedAt / effort）。push 只在
   *  值变时发，**落地前丢掉的那帧不会再来**——首屏列表还没到时先存着，一到立刻并上。 */
  const rowPush = useRef<{
    terminal?: Record<string, SessionTerminal | null>;
    alive?: Record<string, boolean>;
    interrupted?: Record<string, number>;
    effort?: Record<string, string>;
  }>({});
  /** 窗口可见性：terminalTopology 帧整包替换（30s 对账的绝对值快照，无合并语义）。 */
  const [terminalVisibility, setTerminalVisibility] = useState(
    () => new Map<string, 'visible' | 'hidden'>(),
  );

  /** 行级补丁：只重算这几行的判据并就地换行（其余行保持原引用，不重渲染）。
   *  一条 hook 事件只改它自己那条会话的「最新事件 / 回合开合」，不必整套重拉。 */
  const patchRows = useCallback(async (ids: string[]): Promise<void> => {
    try {
      const r = await api.listSessions(undefined, ids);
      setModelCatalog(r.modelCatalog ?? {});
      setSessions((prev) => {
        const byId = new Map(r.sessions.map((s) => [s.sessionId, s]));
        // pane 窗没有全量账（窄窗只拉自己那条）：null 账直接以补丁行起账，
        // 不能像主窗那样整份丢弃——丢了 sessionRow 就恒缺，控制行永远不渲染。
        if (!prev) return r.sessions;
        let changed = false;
        const next = prev.map((s) => {
          const row = byId.get(s.sessionId);
          if (!row) return s;
          changed = true;
          return applyRowPush([row], rowPush.current)[0] ?? row;
        });
        // 补丁里有主窗账上没有的行（pane 窗切了别的会话视图）也并入
        for (const row of r.sessions) {
          if (!next.some((s) => s.sessionId === row.sessionId)) {
            changed = true;
            next.push(applyRowPush([row], rowPush.current)[0] ?? row);
          }
        }
        // 主窗生产者：行补丁落账即同步共享快照（消费窗靠它对齐）
        if (changed && !paneSessionId()) {
          shareSnapshot(next, dispatchesRef.current, [...questionsRef.current.values()], r.modelCatalog ?? {});
        }
        return changed ? next : prev;
      });
      setError(null);
    } catch {
      // 补丁失败不打扰：下一拍事件还会再来，状态推导降级为帧态与旧值
    }
  }, []);

  /** 首屏三路各自「已响应过至少一拍」（含失败——失败也是响应，启动页据此放行）。 */
  const [settled, setSettled] = useState({ sessions: false, dispatches: false, questions: false });

  const refresh = useCallback(async (): Promise<string | null> => {
    // pane 窗不拉全量 sessions（账本是共享的，主窗管）——只拉派发与待答面。
    const pane = paneSessionId() != null;
    const [s, d, q] = await Promise.allSettled([
      pane ? Promise.resolve(null) : api.listSessions(),
      api.listHookDispatches({ limit: 200 }),
      api.listQuestions(),
    ]);
    // 派发列表失败不报错——状态推导降级为 lastSeenAt/turnOpen，不打扰用户
    if (d.status === 'fulfilled') setDispatches(d.value);
    // 待答面同理静默降级（老 daemon 未升级 = 无此路由）
    if (q.status === 'fulfilled') {
      setQuestions(new Map(q.value.map((entry) => [entry.sessionId, entry])));
    }
    if (s.status === 'fulfilled' && s.value) {
      const full = s.value;
      setSessions(() => applyRowPush(full.sessions, rowPush.current));
      setModelCatalog(full.modelCatalog ?? {});
      lastFullAt.current = Date.now();
    }
    shareSnapshot(
      s.status === 'fulfilled' && s.value ? s.value.sessions : sessionsRef.current,
      d.status === 'fulfilled' ? d.value : dispatchesRef.current,
      q.status === 'fulfilled' ? q.value : [...questionsRef.current.values()],
      modelCatalogRef.current,
    );
    setSettled({
      sessions: true,
      dispatches: d.status === 'fulfilled',
      questions: q.status === 'fulfilled',
    });
    if (!pane && s.status !== 'fulfilled') {
      const message = s.reason instanceof Error ? s.reason.message : String(s.reason);
      return message;
    }
    return null;
  }, []);

  /** 拉取失败 = 瞬时故障，走全局 toast（自动消失），不再常驻页面。
   *  连续失败去重：同文案 10s 内只弹一次（SSE 帧驱动的重拉很密）。 */
  const lastToastAt = useRef(0);
  const lastToastMsg = useRef('');
  const toast = useToast();
  const refreshWithToast = useCallback(async (): Promise<string | null> => {
    const message = await refresh();
    if (message == null) return null;
    const now = Date.now();
    if (message !== lastToastMsg.current || now - lastToastAt.current > 10_000) {
      lastToastAt.current = now;
      lastToastMsg.current = message;
      toast.show('error', message);
    }
    return message;
  }, [refresh, toast]);

  // 认证前不拉：Provider 挂在认证门之上，登录页阶段发请求必 401，而错误会一直
  // 留到登录后（Provider 不重挂载）被全局总览渲染成红条。pane 窗不开全局流、不拉
  // 全量：账本从共享快照起（主窗生产者已写好），自己的会话行再由会话流的帧驱动
  // 行补丁保持实时（见下方 hook 订阅——pane 分支照常 patchRows）。
  useEffect(() => {
    if (auth !== 'authenticated') return;
    const paneSid = paneSessionId();
    if (paneSid) {
      const snap = readSharedAccount();
      if (snap?.sessions) {
        setSessions(applyRowPush(snap.sessions, rowPush.current));
        setDispatches(snap.dispatches);
        setQuestions(new Map(snap.questions.map((entry) => [entry.sessionId, entry])));
        setModelCatalog(snap.modelCatalog);
        setSettled({ sessions: true, dispatches: true, questions: true });
      }
      void patchRows([paneSid]);
      return;
    }
    void refreshWithToast();
  }, [auth, refreshWithToast, patchRows]);

  // 消费者对齐：主窗广播「账本变了」即重读快照（pane 窗不开全局流，账本变化全靠它）。
  useEffect(() => {
    if (!paneSessionId()) return;
    return subscribeSharedAccount(() => {
      const snap = readSharedAccount();
      if (!snap?.sessions) return;
      // 本窗 push 行补丁（帧驱动的 pidAlive/effort 等）并上快照后整份替换
      setSessions(applyRowPush(snap.sessions, rowPush.current));
      setDispatches(snap.dispatches);
      setQuestions(new Map(snap.questions.map((entry) => [entry.sessionId, entry])));
      setModelCatalog(snap.modelCatalog);
    });
  }, []);

  // 在途消息角标：后端按 message.* 事件重算并推绝对值快照（无轮询、无重拉）。
  useEffect(
    () =>
      subscribePush<{ counts: Record<string, number>; failed?: Record<string, number> }>('inflightCounts', (p) => {
        setInflight(new Map(Object.entries(p.counts ?? {})));
        setFailedDeliveries(new Map(Object.entries(p.failed ?? {})));
      }),
    [],
  );

  // 会话行的四路隐藏刷新（全无 hook 事件，只能靠后端反查推）：
  // - pidAlive = 终端按钮图标——claude 进程被杀（关终端窗）没有 hook 事件，GET
  //   的值会卡死常绿；只补丁命中行，null 态（codex/新鲜会话）不进快照、不猜。
  // - interruptedAt = 已中断——ESC 打断后多数连 Stop 都不发，真相在转录里，不在
  //   快照里即已恢复（被新事件盖过）。
  // - terminal = 所在可见屏幕（列表分块）——pane 关了/换了屏幕同样没有 hook 事件。
  // - effort = 推理档位（对话面板 slider 的「最后已知」）——`/effort` 是内建命令，
  //   hook 域零事件、也不跑回合，事实只在转录里，靠后端 15s 快照帧补进来。
  //   四路共用一条落地路径：**先存后并**（见 rowPush），首屏列表没到时不丢帧。
  useEffect(() => {
    const land = (): void => setSessions((prev) => (prev ? applyRowPush(prev, rowPush.current) : prev));
    const offs = [
      subscribePush<{ alive?: Record<string, boolean> }>('sessionLiveness', (p) => {
        if (p.alive) rowPush.current.alive = p.alive;
        land();
      }),
      subscribePush<{ interrupted?: Record<string, number> }>('sessionInterrupt', (p) => {
        if (p.interrupted) rowPush.current.interrupted = p.interrupted;
        land();
        // 已中断 = 用户在宿主里手动了结了那个对话框（ESC 多半连 Stop 都不发）——
        // 待答面由服务端在这一拍上判掉，本地不重拉就永远停在那条已经不存在的问题上。
        void refreshWithToast();
      }),
      subscribePush<{
        terminals?: Record<string, SessionTerminal | null>;
        visibilities?: Record<string, 'visible' | 'hidden'>;
      }>('terminalTopology', (p) => {
        if (p.terminals) rowPush.current.terminal = p.terminals;
        if (p.visibilities)
          setTerminalVisibility(new Map(Object.entries(p.visibilities)));
        land();
      }),
      subscribePush<{ efforts?: Record<string, string> }>('sessionEffort', (p) => {
        if (p.efforts) rowPush.current.effort = p.efforts;
        land();
      }),
      // 待答面绝对值快照（tracker 变化即推）：覆盖出现/作答/手动解除/中断摘面全路径。
      subscribePush<PendingQuestionEntry[]>('sessionQuestions', (entries) => {
        setQuestions(new Map(entries.map((entry) => [entry.sessionId, entry])));
      }),
    ];
    return () => {
      for (const off of offs) off();
    };
  }, [refreshWithToast]);

  useEffect(() => {
    let timer: number | null = null;
    /** 这一拍里被事件动过的会话：只补这几行，其余行原样。 */
    const dirty = new Set<string>();
    /** 这一拍里有「不只是某条会话的事件」的帧（派发/待答/投递）⇒ 整套重拉一次。 */
    let wantFull = false;
    /** 兜底的全量节奏：补丁攒够这么久对一次全量（删会话、改标题没有事件信号）。 */
    const FULL_REFRESH_MIN_MS = 15_000;
    const flush = (): void => {
      timer = null;
      const ids = [...dirty];
      dirty.clear();
      const full = wantFull;
      wantFull = false;
      // pane 窗口只关心自己那条会话：整拍都收敛成一次行补丁，全量清单不在窄窗职责里。
      if (paneSessionId()) {
        if (ids.length > 0) void patchRows(ids);
        return;
      }
      const known = new Set((sessionsRef.current ?? []).map((s) => s.sessionId));
      const missed =
        full ||
        sessionsRef.current === null ||
        // 没见过的会话 = 新会话的第一笔事件：整套重拉（新行得摆上去）
        ids.some((id) => !known.has(id)) ||
        Date.now() - lastFullAt.current >= FULL_REFRESH_MIN_MS;
      if (missed) {
        void refreshWithToast().then(() => {
          // API 数据已回，overlay 完成使命（started/finished 的行状态已落库）
          setOverlay(new Map());
        });
      } else if (ids.length > 0) {
        void patchRows(ids);
      }
    };
    const refetch = (): void => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(flush, 500);
    };

    const onHook = (f: HookFrame): void => {
      switch (f.kind) {
        case 'event.ingested': {
          if (!f.sessionId) break;
          const sid = f.sessionId;
          // 后台子 agent 存活账：background_tasks 快照（Stop/SubagentStop 全带）
          // 整集对账——集合 = 快照中 running 的 id 减去本帧刚停的 agent（快照滞后
          // 一拍会把自己列成 running）；无快照的 SubagentStop 按 agent_id 兜底删除
          // （中间回合 stop 的 id 不在账上，删除为空操作）。spawn 出生、自身工具
          // 事件续期（顺带补录面板中途打开漏掉的）。
          if (f.backgroundTasks) {
            const stopped = f.agentId;
            const now = Date.now();
            const nextSession = new Map<string, number>();
            for (const task of f.backgroundTasks) {
              if (task.status === 'running' && task.id !== stopped) nextSession.set(task.id, now);
            }
            setSubagents((prev) => {
              const next = new Map(prev);
              if (nextSession.size) next.set(sid, nextSession);
              else next.delete(sid);
              return next;
            });
          } else if (f.eventType === 'SubagentStop' && f.agentId) {
            const dead = f.agentId;
            setSubagents((prev) => {
              const forSession = prev.get(sid);
              if (!forSession?.has(dead)) return prev;
              const nextSession = new Map(forSession);
              nextSession.delete(dead);
              const next = new Map(prev);
              if (nextSession.size) next.set(sid, nextSession);
              else next.delete(sid);
              return next;
            });
          } else if (f.spawnAgentId || f.agentId) {
            const alive = (f.spawnAgentId ?? f.agentId) as string;
            setSubagents((prev) => {
              const next = new Map(prev);
              const forSession = new Map(next.get(sid) ?? []);
              forSession.set(alive, Date.now());
              next.set(sid, forSession);
              return next;
            });
          }
          break;
        }
        case 'dispatch.started': {
          if (f.sessionId) setOverlay((prev) => new Map(prev).set(f.sessionId as string, 'running'));
          break;
        }
        case 'dispatch.finished': {
          if (!f.sessionId) break;
          setOverlay((prev) => {
            const next = new Map(prev);
            if (f.status === 'failed' || f.status === 'timeout') {
              next.set(f.sessionId as string, 'failed');
            } else {
              next.delete(f.sessionId as string); // succeeded → 交还 API 数据
            }
            return next;
          });
          break;
        }
        default:
          break;
      }
      if (f.kind === 'event.ingested' && f.sessionId) dirty.add(f.sessionId);
      else wantFull = true;
      refetch();
    };

    const off = subscribeHook(onHook);
    return () => {
      off();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [patchRows, refresh]);

  const dispatchBySession = useMemo(() => {
    const m = new Map<string, HookDispatch[]>();
    for (const d of dispatches) {
      if (!d.sessionId) continue;
      const list = m.get(d.sessionId) ?? [];
      list.push(d);
      m.set(d.sessionId, list);
    }
    return m;
  }, [dispatches]);

  const statuses = useMemo(() => {
    const now = Date.now();
    const map = new Map<string, SessionStatus>();
    for (const s of sessions ?? []) {
      const mine = dispatchBySession.get(s.sessionId) ?? [];
      const latest = mine[0]; // 全局列表按 startedAt 倒序，首条最新
      // 后台子 agent 进行中（读取侧过期：10 分钟无该 agent 事件 = 失联兜底）
      const alive = subagents.get(s.sessionId);
      let hasRunningSubagent = false;
      if (alive) {
        for (const seenAt of alive.values()) {
          if (now - seenAt < STALE_SUBAGENT_MS) {
            hasRunningSubagent = true;
            break;
          }
        }
      }
      map.set(
        s.sessionId,
        deriveSessionStatus({
          lastSeenAt: s.lastSeenAt,
          // 服务端基线（listWithCounts）——不必为每个会话拉事件即可判「关闭」
          latestEventType: s.lastEventType ?? undefined,
          pidAlive: s.pidAlive ?? undefined,
          hasRunningDispatch: mine.some((d) => d.status === 'running'),
          hasRunningSubagent,
          latestDispatchFailed:
            latest !== undefined && (latest.status === 'failed' || latest.status === 'timeout'),
          overlay: overlay.get(s.sessionId),
          turnOpen: s.turnOpen,
          interruptedAt: s.interruptedAt ?? undefined,
          harness: s.harness,
          transcriptGone: s.transcriptPresent === false,
          now,
        }),
      );
    }
    return map;
  }, [sessions, dispatchBySession, subagents, overlay]);

  const projectStats = useMemo(() => {
    const byProject = new Map<number, SessionRow[]>();
    for (const s of sessions ?? []) {
      if (s.projectId == null) continue;
      const list = byProject.get(s.projectId) ?? [];
      list.push(s);
      byProject.set(s.projectId, list);
    }
    const out = new Map<number, HarnessSessionCounts[]>();
    for (const [pid, list] of byProject) out.set(pid, countSessionsByHarness(list, statuses));
    return out;
  }, [sessions, statuses]);

  const value = useMemo<SessionStatusValue>(
    () => ({
      sessions,
      dispatches,
      statuses,
      projectStats,
      error,
      inflight,
      failedDeliveries,
      questions,
      modelCatalog,
      settled,
      refresh: refreshWithToast,
      terminalVisibility,
    }),
    [sessions, dispatches, statuses, projectStats, error, inflight, failedDeliveries, questions, modelCatalog, settled, refreshWithToast, terminalVisibility],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** 全局会话状态总线读取口（必须在 SessionStatusProvider 内使用）。 */
export function useSessionStatus(): SessionStatusValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSessionStatus must be used within SessionStatusProvider');
  return v;
}
