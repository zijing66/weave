import { useEffect, useRef, useState } from 'react';
import { subscribePush } from '@/lib/sse';
import { createAwaitGate } from '@/lib/await-gate';

/** 开终端后等角标上涨的上限：窗口起来 + cwd 上报 + 对账那一拍（服务端 600ms
 *  后自对账）通常 1~2s；口径只在可枚举的终端后端上成立，探不到就照旧提前收圈，
 *  别把按钮钉在转圈上。 */
const OPEN_TERMINAL_COUNT_MS = 8_000;

/**
 * 项目卡终端角标（已开终端数，单位 = 可见屏幕）：纯 push 帧驱动——SSE 接入即补
 * 上次快照首帧、后台对账后推差量。前端零请求零定时器：探测要 spawn `wezterm cli`，
 * 任何前端主动拉都会把 spawn 带回请求关键路径。
 *
 * 附带「开终端」loading 的放行闸：等的是角标上涨/下降（= 那个窗口真起来/真没了）
 * ——同开会话/新建会话两个按钮的口径，见 lib/await-gate.ts。
 */
export function useTerminalCounts() {
  const [terminalCounts, setTerminalCounts] = useState<Record<number, number>>({});
  const countsRef = useRef(terminalCounts);
  countsRef.current = terminalCounts;
  const terminalGate = useRef(createAwaitGate(OPEN_TERMINAL_COUNT_MS));
  useEffect(() => {
    terminalGate.current.poke();
  }, [terminalCounts]);
  useEffect(() => () => terminalGate.current.releaseAll(), []);

  // 终端数（可见屏幕）：隐藏刷新器推的绝对值快照（会话所在屏幕的另一半在会话状态总线）。
  useEffect(
    () =>
      subscribePush<{ counts: Record<number, number> }>('terminalTopology', (p) =>
        setTerminalCounts(p.counts),
      ),
    [],
  );

  return { terminalCounts, countsRef, terminalGate };
}
