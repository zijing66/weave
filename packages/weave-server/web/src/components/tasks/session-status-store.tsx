import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { api, type HookDispatch, type PendingQuestionEntry, type SessionRow } from '@/lib/api';
import { subscribeSse } from '@/lib/sse';
import {
  countSessionsByHarness,
  deriveSessionStatus,
  STALE_SUBAGENT_MS,
  type HarnessSessionCounts,
  type SessionStatus,
} from './session-status';

/** App 转发的 hook 帧（mirror bus.ts 的 HookBusMessage，字段按 kind 可选）。 */
export interface HookFrame {
  kind?: string;
  sessionId?: string | null;
  eventType?: string;
  /** 事件源子 agent id（raw.agent_id；SubagentStop 时 = 刚结束的子 agent）。 */
  agentId?: string;
  /** 后台子 agent 出生信号（PostToolUse Agent isAsync 的 tool_response.agentId）。 */
  spawnAgentId?: string;
  /** Stop/SubagentStop 携带的后台任务快照——存活集权威对账源。 */
  backgroundTasks?: Array<{ id: string; status: string }>;
  ruleId?: string;
  eventId?: number;
  dispatchId?: number;
  status?: string;
  /** watch.fired 帧（空闲订阅 one-shot 落定）：目标/订阅方 id——dashboard 订阅
   *  （watcherSessionId null）由此弹 toast，任务面板据此重拉订阅列表。 */
  watchId?: number;
  targetSessionId?: string;
  watcherSessionId?: string | null;
}

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
  /** sessionId → 待答阻塞问题（AskUserQuestion / 计划与权限确认）。 */
  questions: Map<string, PendingQuestionEntry>;
  /** 手动重拉（刷新按钮；SSE 之外兜底）。resolve = 会话列表拉取失败的原因，成功为 null。 */
  refresh: () => Promise<string | null>;
}

const Ctx = createContext<SessionStatusValue | null>(null);

/**
 * 全局会话状态总线（唯一真源）：一处拉 sessions + dispatches、一处订阅
 * weave:hook 帧（overlay / 子 agent 存活账）、一处推导 deriveSessionStatus。
 * 项目行徽标、任务视图会话列表、全局总览都从这里取——此前三处各自 fetch +
 * 各自推导（且各自漏掉别人的输入），状态会漂移。
 */
export function SessionStatusProvider({ children }: { children: ReactNode }) {
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [dispatches, setDispatches] = useState<HookDispatch[]>([]);
  const [error, setError] = useState<string | null>(null);
  /** SSE 即时状态覆盖（帧已到、refetch 未回；refetch 完成后以 API 为准清除）。 */
  const [overlay, setOverlay] = useState<Map<string, SessionStatus>>(new Map());
  /** 后台子 agent 存活账（sessionId → agentId → 最近事件时刻）：spawn 出生、
   *  自身事件续期，Stop/SubagentStop 的 background_tasks 快照整集对账；
   *  读取侧 STALE_SUBAGENT_MS 兜底。回合开合不用帧态——以服务端 turnOpen 为权威。 */
  const [subagents, setSubagents] = useState<Map<string, Map<string, number>>>(new Map());
  /** 在途消息角标（后端 push 的绝对值快照；漏帧由下一次推自我校正）。 */
  const [inflight, setInflight] = useState<Map<string, number>>(new Map());
  /** 待答阻塞问题：随 hook 帧的 500ms 防抖重拉（tracker 是事件驱动的内存态，
   *  帧到即变——重拉既覆盖问题出现也覆盖作答/解除，自愈无独立 SSE 通道）。 */
  const [questions, setQuestions] = useState<Map<string, PendingQuestionEntry>>(new Map());

  const refresh = useCallback(async (): Promise<string | null> => {
    const [s, d, q] = await Promise.allSettled([
      api.listSessions(),
      api.listHookDispatches({ limit: 200 }),
      api.listQuestions(),
    ]);
    // 派发列表失败不报错——状态推导降级为 lastSeenAt/turnOpen，不打扰用户
    if (d.status === 'fulfilled') setDispatches(d.value);
    // 待答面同理静默降级（老 daemon 未升级 = 无此路由）
    if (q.status === 'fulfilled') {
      setQuestions(new Map(q.value.map((entry) => [entry.sessionId, entry])));
    }
    if (s.status === 'fulfilled') {
      setSessions(s.value);
      setError(null);
      return null;
    }
    const message = s.reason instanceof Error ? s.reason.message : String(s.reason);
    setError(message);
    return message;
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 在途消息角标：后端按 message.* 事件重算并推绝对值快照（无轮询、无重拉）。
  useEffect(
    () =>
      subscribeSse((frame) => {
        if (frame.type !== 'push' || frame.key !== 'inflightCounts') return;
        const counts = (frame.payload as { counts: Record<string, number> }).counts ?? {};
        setInflight(new Map(Object.entries(counts)));
      }),
    [],
  );

  // 终端按钮图标（pidAlive）：后端隐藏刷新器推判得动的绝对值快照——claude 进程
  // 被杀（关终端窗）没有 hook 事件，GET 的值会卡死常绿；只补丁命中行，null 态
  // （codex/新鲜会话）不进快照、不猜。sessions 变 → statuses 派生自愈。
  useEffect(
    () =>
      subscribeSse((frame) => {
        if (frame.type !== 'push' || frame.key !== 'sessionLiveness') return;
        const alive = (frame.payload as { alive?: Record<string, boolean> }).alive ?? {};
        setSessions((prev) => {
          if (!prev) return prev;
          let changed = false;
          const next = prev.map((s) => {
            const v = alive[s.sessionId];
            if (v === undefined || s.pidAlive === v) return s;
            changed = true;
            return { ...s, pidAlive: v };
          });
          return changed ? next : prev;
        });
      }),
    [],
  );

  useEffect(() => {
    let timer: number | null = null;
    const refetch = (): void => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        void refresh().then(() => {
          // API 数据已回，overlay 完成使命（started/finished 的行状态已落库）
          setOverlay(new Map());
        });
      }, 500);
    };

    const onHook = (e: Event): void => {
      const f = (e as CustomEvent<HookFrame>).detail ?? {};
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
      refetch();
    };

    window.addEventListener('weave:hook', onHook);
    return () => {
      window.removeEventListener('weave:hook', onHook);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [refresh]);

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
    () => ({ sessions, dispatches, statuses, projectStats, error, inflight, questions, refresh }),
    [sessions, dispatches, statuses, projectStats, error, inflight, questions, refresh],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** 全局会话状态总线读取口（必须在 SessionStatusProvider 内使用）。 */
export function useSessionStatus(): SessionStatusValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSessionStatus must be used within SessionStatusProvider');
  return v;
}
