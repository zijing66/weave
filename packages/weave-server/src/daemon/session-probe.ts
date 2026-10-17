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

/** 转录尾部抽出的事实（一次尾读、多问共享；按文件大小缓存）。 */
interface TailFacts {
  size: number;
  markerAt: number | null;
  model: string | null;
  mode: string | null;
}

export class SessionProbe {
  /** sessionId → 转录路径（内存态；hook 事件每次上报都覆盖刷新）。 */
  private readonly paths = new Map<string, string>();
  /** 路径 → 上次读到的事实（按文件大小缓存：没长过就不重读）。 */
  private readonly marks = new Map<string, TailFacts>();

  noteTranscript(sessionId: string, path: string | null): void {
    if (path) this.paths.set(sessionId, path);
  }

  forget(sessionId: string): void {
    this.paths.delete(sessionId);
  }

  /**
   * 单会话的中断时刻（ms）：转录最后一条中断标记**晚于**最后一条 hook 事件才算
   * ——之后任何事件（用户又发了一条、工具收尾）都会把它盖过去，故是自愈的；
   * 未知路径/读不到/没标记一律 null（不猜）。
   */
  interruptedAt(sessionId: string, lastSeenAt: string): number | null {
    const path = this.paths.get(sessionId);
    if (!path) return null;
    const marker = this.factsOf(path).markerAt;
    if (marker === null) return null;
    const seen = Date.parse(lastSeenAt);
    return Number.isFinite(seen) && marker > seen ? marker : null;
  }

  /** 最近一轮真跑过的模型（转录 `message.model`）；未知/读不到一律 null（不猜）。 */
  currentModel(sessionId: string): string | null {
    const path = this.paths.get(sessionId);
    if (!path) return null;
    return this.factsOf(path).model;
  }

  /** 最后一次活动时的执行模式（转录 `permissionMode`）；Shift+Tab 不留痕，故是「最后已知」。 */
  currentMode(sessionId: string): string | null {
    const path = this.paths.get(sessionId);
    if (!path) return null;
    return this.factsOf(path).mode;
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
