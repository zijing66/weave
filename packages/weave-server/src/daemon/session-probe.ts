import { closeSync, openSync, readSync, statSync } from 'node:fs';
import {
  bareModelName,
  codexInterruptMarkerAt,
  currentContextTokensAt,
  currentEffortAt,
  currentModelAt,
  currentModeAt,
  interruptMarkerAt,
  switchedModelOf,
  type ModelSwitchFact,
} from '@weavecode/harness';
import { HARNESS_SESSION_CONTROL, isHarness } from '@weavecode/core';

/**
 * 会话转录探测（「已中断」判据的服务端半边）。
 *
 * hook 域**没有**中断事件——用户按 ESC 打断后，实测 45 次里 41 次连 Stop 都不发，
 * 事件流直接静默，会话于是永远停在「生成中」。真相只在转录里（解析归 harness 的
 * `interruptMarkerAt`），故把 hook 事件旁路带来的转录路径**留在内存**（与 paneEnv /
 * inbox 凭据同口径：不落库、daemon 重启即清零，靠下一次 hook 事件补回），按需读尾部。
 * 模型与模式同理只在**最后活动时**照会（`currentModelAt` / `currentModeAt`），故都是
 * 「最后已知」：路径与换模型闩重启即清零，前者靠下一次事件里旁路带回来（见
 * {@link dbTranscriptPathResolver}），后者回读库里那条落定事件（见
 * {@link dbModelFactResolver}）——否则「换完就放着」的会话会一直显示切换前的模型。
 */

/** 尾读字节数：中断标记落在这一轮末尾（其后最多几条收尾/附属记录），64KB 足够。 */
const TAIL_BYTES = 64 * 1024;

/** 没有可答的事实（未登记路径）。 */
const NO_FACTS = { model: null, mode: null, effort: null, contextTokens: null } as const;

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

/**
 * 装配用兜底：换模型那把闩只在内存，daemon 一重启就没了，而转录**只**在 assistant
 * 消息上照会模型——换完没再跑一轮的会话（「切了就放着」最常见）会一直显示切换前
 * 那个模型。于是回读库里这条会话最近一条「模型落定」事件（换模型 / 重开会话）：
 * 是换模型就答得出新值，是重开则什么都不补（宿主把模型交还重定了，不猜）。
 * 每个会话在 daemon 生命周期里最多查一次（见 `SessionProbe.switchOf`）。
 */
export function dbModelFactResolver(
  events: {
    listBySession(
      sessionId: string,
      limit?: number,
      beforeId?: number,
      types?: readonly string[],
    ): Array<{ eventType: string; payload: string }>;
  },
  harnessOf: (sessionId: string) => string | null,
): (sessionId: string) => ModelSwitchFact | null {
  return (sessionId) => {
    const harness = harnessOf(sessionId);
    const types = harness && isHarness(harness) ? HARNESS_SESSION_CONTROL[harness].modelFactEvents : [];
    if (types.length === 0) return null;
    const rows = events.listBySession(sessionId, 1, undefined, types);
    const latest = rows[rows.length - 1];
    if (!latest) return null;
    try {
      const raw = (JSON.parse(latest.payload) as { raw?: unknown }).raw;
      return switchedModelOf(latest.eventType, raw);
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
  effort: string | null;
  contextTokens: number | null;
}

/**
 * 中断标记两套格式各归各的 adapter（claude = 转录 user 条目、codex = rollout
 * `turn_aborted` 行），且互不相交——对方的标记串不会出现在自己的转录里。故
 * 两个都跑、取更新者：probe 不必知道会话是哪个 harness（调用方也没传）。
 */
function interruptMarkerOf(tail: string): number | null {
  const claude = interruptMarkerAt(tail);
  const codex = codexInterruptMarkerAt(tail);
  if (claude === null) return codex;
  if (codex === null) return claude;
  return Math.max(claude, codex);
}

export class SessionProbe {
  constructor(
    /**
     * 路径的内存副本没了以后的兜底（daemon 重启后第一拍）：不补的话，重启后**没有
     * 新事件**的会话（已收尾 / 闲置中的那些）模型与模式会一直显示「未知」。
     */
    private readonly fallbackPath?: (sessionId: string) => string | null,
    /** 重启后补换模型闩（见 {@link dbModelFactResolver}）。 */
    private readonly fallbackSwitch?: (sessionId: string) => ModelSwitchFact | null,
  ) {}

  /** sessionId → 转录路径（内存态；hook 事件每次上报都覆盖刷新）。 */
  private readonly paths = new Map<string, string>();
  /** 路径 → 上次读到的事实（按文件大小缓存：没长过就不重读）。 */
  private readonly marks = new Map<string, TailFacts>();
  /** sessionId → 最后已知的模型/模式/上下文占用（读到就记；见 `latched`）。 */
  private readonly known = new Map<
    string,
    { model: string | null; mode: string | null; effort: string | null; contextTokens: number | null }
  >();
  /**
   * sessionId → 宿主落定的换模型（`PostModelSwitch`）+ 记下的那一刻转录里还是哪个
   * 模型。转录只在 assistant 消息上照会模型，切完不跑一轮就永远读不到新值——故
   * 换模型这件事得由事件先说，等转录自己跟上（照会的值不再是 `stale`）才交还给它。
   */
  private readonly switched = new Map<string, { stale: string | null; model: string }>();
  /** sessionId → 已经向库要过换模型闩了（库里那条事件不会变，问一次就够）。 */
  private readonly probed = new Set<string>();
  /** sessionId → 推理档位（每次带 `effort` 的事件覆盖）：状态栏 `thinking` 块的事实在 hook 里。 */
  private readonly efforts = new Map<string, string>();
  /** sessionId → 事件自带的执行模式（每条事件覆盖）：比转录早一步，见 `noteMode`。 */
  private readonly modes = new Map<string, string>();

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

  /**
   * 该会话的转录路径（没登记过 → null）：按需读**全量**转录的地方用（改动汇总要
   * 从头扫 tool_use，尾窗读不到），路径归一处，别处不自己拼 projects 目录。
   */
  transcriptPathOf(sessionId: string): string | null {
    return this.pathOf(sessionId);
  }

  forget(sessionId: string): void {
    this.paths.delete(sessionId);
    this.known.delete(sessionId);
    this.switched.delete(sessionId);
    this.probed.delete(sessionId);
    this.efforts.delete(sessionId);
    this.modes.delete(sessionId);
  }

  /** 推理档位（`effort.level`，事件自带）：逐条覆盖，与模型/模式同口径只放内存。 */
  noteEffort(sessionId: string, level: string): void {
    this.efforts.set(sessionId, level);
  }

  /** 最后已知的推理档位：事件优先、转录兜底；两者都没有即 null（不猜）。
   *  兜底是为了 daemon 重启那一拍——事件只有工具/回合类才带 effort，重启后
   *  若一直只有通知类事件，没这层就会长期显「未知」。 */
  currentEffort(sessionId: string): string | null {
    return this.efforts.get(sessionId) ?? this.latched(sessionId).effort;
  }

  /**
   * 上下文窗口占用（token 数）：转录最后一条 assistant 的 usage 四项之和，语义是
   * 「上一轮完成时」——与模型/模式同为「最后已知」。没有转录 / 还没跑过一轮 →
   * null（不猜）。
   */
  currentContextTokens(sessionId: string): number | null {
    return this.latched(sessionId).contextTokens;
  }

  /** 宿主落定的换模型（`PostModelSwitch` 的 `to_model`）：立刻生效，见 `switched`。 */
  noteModel(sessionId: string, model: string): void {
    const path = this.pathOf(sessionId);
    this.switched.set(sessionId, { stale: path ? this.factsOf(path).model : null, model });
  }

  /**
   * 宿主开 / 恢复会话（`SessionStart`）：模型由宿主重新决定，此前的「最后已知」与
   * 换模型闩一律作废、下一次问重新读——`--resume` 起来会落回默认模型，而转录里还
   * 只有上一轮的照会，旧答案既可能不是此刻的模型、也会让 `switched` 的 stale 对照
   * 永远对不上（新照会恰好等于 stale 时标签就再也改不回来）。带了值就以它为准
   * （claude 的 resume 也带：全局配置里的默认模型，见 harness 的 `startedModelOf`）。
   */
  sessionStarted(sessionId: string, model: string | null): void {
    this.known.delete(sessionId);
    this.switched.delete(sessionId);
    this.probed.delete(sessionId);
    if (model) this.noteModel(sessionId, model);
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
   * 单会话的中断时刻（ms）：转录最后一条中断标记**晚于**最后一条主回合事件才算
   * ——之后任何主回合事件（用户又发了一条、工具收尾）都会把它盖过去，故是自愈的；
   * 未知路径/读不到/没标记一律 null（不猜）。基准由调用方给（`lastMainEventAtOf`
   * ，排除 SubagentStop——后台子代理收尾与主回合无关，中断后异步到达不该盖掉它）。
   */
  interruptedAt(sessionId: string, lastMainEventAt: string): number | null {
    const path = this.pathOf(sessionId);
    if (!path) return null;
    const marker = this.factsOf(path).markerAt;
    if (marker === null) return null;
    const seen = Date.parse(lastMainEventAt);
    return Number.isFinite(seen) && marker > seen ? marker : null;
  }

  /** 最近一轮真跑过的模型（转录 `message.model`）；未知/读不到一律 null（不猜）。 */
  currentModel(sessionId: string): string | null {
    return this.latched(sessionId).model;
  }

  /**
   * 事件自带的执行模式（`raw.permission_mode`）：每条事件都带、答的是「此刻」，故压过
   * 转录——宿主切模式（Shift+Tab）既不落转录也没有专门事件，转录那条只能追到上一次
   * 写条目的那一刻。没有事件（daemon 重启后的第一拍）才回落转录。
   */
  noteMode(sessionId: string, mode: string): void {
    this.modes.set(sessionId, mode);
  }

  /** 最后一次活动时的执行模式：事件优先、转录兜底；两者都没有即 null（不猜）。 */
  currentMode(sessionId: string): string | null {
    return this.modes.get(sessionId) ?? this.latched(sessionId).mode;
  }

  /**
   * 模型/模式在 UI 上承诺的是**最后已知**，不是「此刻尾窗里有没有」：尾窗只有 64KB，
   * 一轮的尾巴若被一条大记录占满、或刚压缩完还没有 assistant 条目，这一拍就什么
   * 都读不到。更要命的是读空的那一拍会按文件大小被缓存住——会话一完成文件不再
   * 增长，那口 null 就钉死了，界面上直接掉回「未知」。故读到就记住，读空沿用：
   * 值只会被**更新的值**替换，不会被读空擦掉。中断标记不参与闩（它按「晚于最后
   * 一条事件」判，陈旧标记必须能被新事件盖过）。
   */
  private latched(sessionId: string): {
    model: string | null;
    mode: string | null;
    effort: string | null;
    contextTokens: number | null;
  } {
    const path = this.pathOf(sessionId);
    const facts = path ? this.factsOf(path) : NO_FACTS;
    const prev = this.known.get(sessionId);
    const next = {
      model: this.switchedModel(sessionId, facts.model) ?? prev?.model ?? null,
      mode: facts.mode ?? prev?.mode ?? null,
      effort: facts.effort ?? prev?.effort ?? null,
      // 上下文占用跟着转录走（每轮 assistant 记录刷新）：读到新值即替换，读空沿用。
      contextTokens: facts.contextTokens ?? prev?.contextTokens ?? null,
    };
    if (
      !prev ||
      prev.model !== next.model ||
      prev.mode !== next.mode ||
      prev.effort !== next.effort ||
      prev.contextTokens !== next.contextTokens
    ) {
      this.known.set(sessionId, next);
    }
    return next;
  }

  /**
   * 换模型事件压过转录：只要转录照会的还是切换前那个模型（切完还没真跑一轮），
   * 就答事件说的新值；转录自己跟上（照会别的值）即交还给它。
   */
  private switchedModel(sessionId: string, fromTranscript: string | null): string | null {
    const switched = this.switchOf(sessionId, fromTranscript);
    return switched && fromTranscript === switched.stale ? switched.model : fromTranscript;
  }

  /**
   * 换模型闩：内存里有就用内存的；没有（daemon 刚重启）就向库要一次——拿事件的
   * `from_model` 与转录此刻照会的值比（剥网关前缀，`custom_openai/ftm` 对 `ftm`），
   * 相同即宿主还没跑过新一轮，闩才成立；不同则事件早于转录，交还转录。
   */
  private switchOf(
    sessionId: string,
    fromTranscript: string | null,
  ): { stale: string | null; model: string } | undefined {
    const hit = this.switched.get(sessionId);
    if (hit || !fromTranscript || this.probed.has(sessionId)) return hit;
    this.probed.add(sessionId);
    const fact = this.fallbackSwitch?.(sessionId);
    if (!fact || fact.from === null || bareModelName(fact.from) !== bareModelName(fromTranscript)) {
      return undefined;
    }
    const switched = { stale: fromTranscript, model: fact.to };
    this.switched.set(sessionId, switched);
    return switched;
  }

  private factsOf(path: string): TailFacts {
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      return { size: -1, markerAt: null, model: null, mode: null, effort: null, contextTokens: null };
    }
    const hit = this.marks.get(path);
    if (hit && hit.size === size) return hit;
    const tail = readTail(path);
    const facts: TailFacts = {
      size,
      markerAt: tail === null ? null : interruptMarkerOf(tail),
      model: tail === null ? null : currentModelAt(tail),
      mode: tail === null ? null : currentModeAt(tail),
      effort: tail === null ? null : currentEffortAt(tail),
      contextTokens: tail === null ? null : currentContextTokensAt(tail),
    };
    this.marks.set(path, facts);
    return facts;
  }
}
