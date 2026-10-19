import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { currentModelAt, currentModeAt, interruptMarkerAt } from '@weavecode/harness';

/**
 * 会话转录探测（「已中断」判据的服务端半边）。
 *
 * hook 域**没有**中断事件——用户按 ESC 打断后，实测 45 次里 41 次连 Stop 都不发，
 * 事件流直接静默，会话于是永远停在「生成中」。真相只在转录里（解析归 harness 的
 * `interruptMarkerAt`），故把 hook 事件旁路带来的转录路径**留在内存**（与 paneEnv /
 * inbox 凭据同口径：不落库、daemon 重启即清零，靠下一次 hook 事件补回），按需读尾部。
 * 换模型同样只有转录照会（`currentModelAt`）——hook 只在 SessionStart 带 model。
 */

/** 尾读字节数：中断标记落在这一轮末尾（其后最多几条收尾/附属记录），64KB 足够。 */
const TAIL_BYTES = 64 * 1024;

/** 没有可答的事实（未登记路径）。 */
const NO_FACTS = { model: null, mode: null } as const;

/** 读文件尾部（读不到 → null，不猜）。 */
export function readTail(path: string, bytes = TAIL_BYTES): string | null {
  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - bytes);
    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.alloc(size - start);
      readSync(fd, buf, 0, buf.length, start);
      return buf.toString('utf8');
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

/**
 * 装配用兜底：路径从库里该会话最近一条事件的旁路字段补回（与入站侧读同一个
 * `transcriptPath`）。每个会话在 daemon 生命周期里最多查一次——查到即写回内存。
 */
export function dbTranscriptPathResolver(events: {
  listBySession(sessionId: string, limit?: number): Array<{ payload: string }>;
}): (sessionId: string) => string | null {
  return (sessionId) => {
    try {
      const raw = JSON.parse(events.listBySession(sessionId, 1)[0]?.payload ?? '') as {
        transcriptPath?: unknown;
      };
      return typeof raw.transcriptPath === 'string' && raw.transcriptPath ? raw.transcriptPath : null;
    } catch {
      return null;
    }
  };
}

/** 转录尾部抽出的事实（一次尾读、多问共享；按文件大小缓存）。 */
interface TailFacts {
  size: number;
  markerAt: number | null;
  model: string | null;
  mode: string | null;
}

export class SessionProbe {
  constructor(
    /**
     * 路径的内存副本没了以后的兜底（daemon 重启后第一拍）：不补的话，重启后**没有
     * 新事件**的会话（已收尾 / 闲置中的那些）模型与模式会一直显示「未知」。
     */
    private readonly fallbackPath?: (sessionId: string) => string | null,
  ) {}

  /** sessionId → 转录路径（内存态；hook 事件每次上报都覆盖刷新）。 */
  private readonly paths = new Map<string, string>();
  /** 路径 → 上次读到的事实（按文件大小缓存：没长过就不重读）。 */
  private readonly marks = new Map<string, TailFacts>();
  /** sessionId → 最后已知的模型/模式（读到就记；见 `latched`）。 */
  private readonly known = new Map<string, { model: string | null; mode: string | null }>();
  /**
   * sessionId → 宿主落定的换模型（`PostModelSwitch`）+ 记下的那一刻转录里还是哪个
   * 模型。转录只在 assistant 消息上照会模型，切完不跑一轮就永远读不到新值——故
   * 换模型这件事得由事件先说，等转录自己跟上（照会的值不再是 `stale`）才交还给它。
   */
  private readonly switched = new Map<string, { stale: string | null; model: string }>();

  noteTranscript(sessionId: string, path: string | null): void {
    if (path) this.paths.set(sessionId, path);
  }

  private pathOf(sessionId: string): string | null {
    const known = this.paths.get(sessionId);
    if (known) return known;
    const fromDb = this.fallbackPath?.(sessionId) ?? null;
    if (fromDb) this.paths.set(sessionId, fromDb);
    return fromDb;
  }

  forget(sessionId: string): void {
    this.paths.delete(sessionId);
    this.known.delete(sessionId);
    this.switched.delete(sessionId);
  }

  /** 宿主落定的换模型（`PostModelSwitch` 的 `to_model`）：立刻生效，见 `switched`。 */
  noteModel(sessionId: string, model: string): void {
    const path = this.pathOf(sessionId);
    this.switched.set(sessionId, { stale: path ? this.factsOf(path).model : null, model });
  }

  /**
   * 转录还在不在：true/false；路径都不知道 → null（不猜）。
   *
   * 会话行是采集出来的、与转录那份文件同生不同死——转录被清理/删掉后列表照旧
   * 有行，`claude --resume <id>` 却在 pane 里当场报 "No conversation found"。
   * 故「打开」前与列表渲染前都得先问这一句。空文件也算没有（没有可接的对话）。
   */
  transcriptPresent(sessionId: string): boolean | null {
    const path = this.pathOf(sessionId);
    return path ? this.factsOf(path).size > 0 : null;
  }

  /**
   * 单会话的中断时刻（ms）：转录最后一条中断标记**晚于**最后一条 hook 事件才算
   * ——之后任何事件（用户又发了一条、工具收尾）都会把它盖过去，故是自愈的；
   * 未知路径/读不到/没标记一律 null（不猜）。
   */
  interruptedAt(sessionId: string, lastSeenAt: string): number | null {
    const path = this.pathOf(sessionId);
    if (!path) return null;
    const marker = this.factsOf(path).markerAt;
    if (marker === null) return null;
    const seen = Date.parse(lastSeenAt);
    return Number.isFinite(seen) && marker > seen ? marker : null;
  }

  /** 最近一轮真跑过的模型（转录 `message.model`）；未知/读不到一律 null（不猜）。 */
  currentModel(sessionId: string): string | null {
    return this.latched(sessionId).model;
  }

  /** 最后一次活动时的执行模式（转录 `permissionMode`）；Shift+Tab 不留痕，故是「最后已知」。 */
  currentMode(sessionId: string): string | null {
    return this.latched(sessionId).mode;
  }

  /**
   * 模型/模式在 UI 上承诺的是**最后已知**，不是「此刻尾窗里有没有」：尾窗只有 64KB，
   * 一轮的尾巴若被一条大记录占满、或刚压缩完还没有 assistant 条目，这一拍就什么
   * 都读不到。更要命的是读空的那一拍会按文件大小被缓存住——会话一完成文件不再
   * 增长，那口 null 就钉死了，界面上直接掉回「未知」。故读到就记住，读空沿用：
   * 值只会被**更新的值**替换，不会被读空擦掉。中断标记不参与闩（它按「晚于最后
   * 一条事件」判，陈旧标记必须能被新事件盖过）。
   */
  private latched(sessionId: string): { model: string | null; mode: string | null } {
    const path = this.pathOf(sessionId);
    const facts = path ? this.factsOf(path) : NO_FACTS;
    const prev = this.known.get(sessionId);
    const next = {
      model: this.switchedModel(sessionId, facts.model) ?? prev?.model ?? null,
      mode: facts.mode ?? prev?.mode ?? null,
    };
    if (!prev || prev.model !== next.model || prev.mode !== next.mode) this.known.set(sessionId, next);
    return next;
  }

  /**
   * 换模型事件压过转录：只要转录照会的还是切换前那个模型（切完还没真跑一轮），
   * 就答事件说的新值；转录自己跟上（照会别的值）即交还给它。
   */
  private switchedModel(sessionId: string, fromTranscript: string | null): string | null {
    const switched = this.switched.get(sessionId);
    return switched && fromTranscript === switched.stale ? switched.model : fromTranscript;
  }

  private factsOf(path: string): TailFacts {
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      return { size: -1, markerAt: null, model: null, mode: null };
    }
    const hit = this.marks.get(path);
    if (hit && hit.size === size) return hit;
    const tail = readTail(path);
    const facts: TailFacts = {
      size,
      markerAt: tail === null ? null : interruptMarkerAt(tail),
      model: tail === null ? null : currentModelAt(tail),
      mode: tail === null ? null : currentModeAt(tail),
    };
    this.marks.set(path, facts);
    return facts;
  }
}
