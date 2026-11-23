import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import '@xterm/xterm/css/xterm.css';
import { ChevronDown, Keyboard } from 'lucide-react';
import { TerminalClient, type TerminalFrame } from '@/lib/terminal';
import { useIsCoarsePointer } from '@/lib/use-media-query';

/**
 * headless 实例的 Web Terminal（B4）：xterm.js 渲染 + TerminalClient 传输。
 * 只渲染选中实例（挂载即建、卸载即拆——多实例页面不常驻 xterm，§13.2）。
 */

interface TerminalViewProps {
  instanceId: string;
  interactive?: boolean;
  /** 连上后一次性注入的命令（带 \r 结尾；只发一拍，重连不再补发）。 */
  initialCommand?: string;
}

/** 输出合帧窗：ConPTY/WS 把一个 TUI 重绘帧拆成多个 chunk 分批到达（实测簇均
 *  ~6 chunk、簇间隔 33–500ms），逐 chunk 渲染会把「上移重画状态条→下移归位」
 *  的中间态画出来——光标随状态条刷新乱跳（实测 54% 渲染态光标不在帧末位置）。
 *  合帧窗须 ≥ 实测帧内 chunk 间隔（32ms 窗 < 33ms 簇间隔，帧中截断仍会闪），
 *  取 64ms；上限防连续快流饿死。交互回显多在 64ms 内成帧，体感无延迟。 */
const COALESCE_MS = 64;
const COALESCE_MAX_MS = 250;

/** 移动端快捷键面板（软键盘出不了的键）：字节序列 = 物理键盘经 xterm 按同一键会发出的那一份。 */
const KEY_PAD: Array<{ label: string; data: string }> = [
  { label: 'Esc', data: '\x1b' },
  { label: 'Tab', data: '\t' },
  { label: '↑', data: '\x1b[A' },
  { label: '↓', data: '\x1b[B' },
  { label: '←', data: '\x1b[D' },
  { label: '→', data: '\x1b[C' },
  { label: 'Home', data: '\x1b[H' },
  { label: 'End', data: '\x1b[F' },
  { label: 'PgUp', data: '\x1b[5~' },
  { label: 'PgDn', data: '\x1b[6~' },
  { label: 'Ctrl+C', data: '\x03' },
  { label: 'Ctrl+D', data: '\x04' },
  { label: 'Ctrl+U', data: '\x15' },
  { label: 'Ctrl+L', data: '\x0c' },
  { label: 'Ctrl+A', data: '\x01' },
  { label: 'Ctrl+E', data: '\x05' },
  { label: 'Ctrl+W', data: '\x17' },
  { label: 'Ctrl+Z', data: '\x1a' },
];

// xterm 6 缺少上游 #5759：组词期间 TUI 输出会移动光标，但 textarea/组词层
// 不跟着重定位 ⇒ IME 候选框停在旧位置、把整屏顶偏。修法 = 组词期间每次
// 渲染都重同步两个元素的坐标（7.0.0 上游修复的等价物）。
function patchImeAnchor(term: Terminal): void {
  const { _core: core } = term as unknown as {
    _core?: {
      _syncTextArea?: () => void;
      _compositionHelper?: { updateCompositionElements(): void };
    };
  };
  let composing = false;
  const textarea = term.textarea;
  if (!textarea || !core?._syncTextArea || !core?._compositionHelper) return;
  const sync = () => {
    core._syncTextArea!();
    core._compositionHelper!.updateCompositionElements();
  };
  textarea.addEventListener('compositionstart', sync, true);
  textarea.addEventListener('compositionstart', () => (composing = true));
  textarea.addEventListener('compositionend', () => (composing = false));
  term.onRender(() => {
    if (composing) sync();
  });
}

export function TerminalView({ instanceId, interactive = true, initialCommand }: TerminalViewProps) {
  const holder = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const clientRef = useRef<TerminalClient | null>(null);
  const initialSentRef = useRef(false);
  const [status, setStatus] = useState<'connecting' | 'live' | 'disconnected' | 'exited'>('connecting');
  const [lease, setLease] = useState<'pending' | 'granted' | 'denied'>('pending');
  // 视口是否离开底部（上翻看历史）：悬浮「滚到底」按钮的显隐。
  const [scrolledUp, setScrolledUp] = useState(false);
  // 移动端软键盘没有 Esc/方向键/Ctrl 组合：触屏指针下给一个快捷键面板。
  const coarse = useIsCoarsePointer();
  const [showKeys, setShowKeys] = useState(false);
  const sendKey = (data: string): void => clientRef.current?.stdin(data);

  useEffect(() => {
    setStatus('connecting');
    setLease('pending');
    initialSentRef.current = false;
    const term = new Terminal({
      fontFamily: "'Weave Mono', 'Cascadia Mono', Consolas, ui-monospace, monospace",
      fontSize: 12,
      cursorBlink: true,
      convertEol: false,
      scrollback: 5000,
    });
    termRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    // emoji 等宽字符计宽（unicode 11 宽度表）：TUI 状态栏的 emoji 实占 2 列，
    // 缺它按 1 列算 → 状态条错位、字形落成方块。
    const unicode11 = new Unicode11Addon();
    term.loadAddon(unicode11);
    term.unicode.activeVersion = '11';
    if (holder.current) {
      term.open(holder.current);
      patchImeAnchor(term);
      fit.fit();
    }
    // Weave Mono 是 font-display: swap 的异步 woff2：首拍 fit 用 fallback 字形量
    // cell，字体到位后 rows/cols 偏小 → 渲染区矮一截（屏下半黑）。字体就绪后重 fit
    // 并把新几何同步给网关（PTY 跟着对齐，TUI 重绘铺满真视口）。
    void document.fonts?.ready.then(() => {
      if (termRef.current !== term || term.element?.isConnected !== true) return;
      fit.fit();
      clientRef.current?.setDimensions(term.cols, term.rows);
      clientRef.current?.resize(term.cols, term.rows);
    });

    /** 重放有过缺口（旧 Host / ring 截断）⇒ 屏上是残片，拿到写权后清屏重绘。 */
    let replayGap = false;
    // 视口滚动偏移跟踪（xterm 6 IBuffer 不暴露 ydisp）：钉底判据的数据面。
    let trackedYdisp = 0;
    term.onScroll((ydisp) => {
      trackedYdisp = ydisp;
      setScrolledUp(ydisp + term.rows < term.buffer.active.length);
    });
    // 合帧写：全部写入走同一队列（gap 横幅/退出提示也一样），顺序不乱。
    let pendingOut = '';
    let outSince = 0;
    let outTimer: number | null = null;
    const flushOut = (): void => {
      if (outTimer !== null) {
        window.clearTimeout(outTimer);
        outTimer = null;
      }
      if (pendingOut === '') return;
      const data = pendingOut;
      pendingOut = '';
      outSince = 0;
      // write 是异步解析：滚动必须挂在完成回调，否则这一拍仍按旧 buffer 钉底，
      // 大块 TUI 重绘解析完后又把光标推到视口外。钉底判据 = 写前就在底部
      //（ydisp 触底）——上翻看历史时新输出不再把视口拽回底，滚回底部才恢复跟随。
      // xterm 6 的 IBuffer 不暴露滚动偏移（ydisp 是私有态）；经 onScroll 跟踪
      //（程序滚动与用户滚动都会触发，write 回调里用写前快照判「在底部」）。
      const atBottom = trackedYdisp + term.rows >= term.buffer.active.length;
      term.write(data, () => {
        if (atBottom) term.scrollToBottom();
        clearStaleCursor();
      });
    };
    // 陈旧光标行清理：合帧/scrollToBottom 组合可能把 DOM renderer 的 xterm-cursor
    // class 定格在旧光标行（该行滚出渲染批次后不重建）——写完按上拍光标行定向
    // refresh，残留 class 与瞬时双光标即清（双光标链路的渲染面收尾）。
    let lastCursorRow = -1;
    const clearStaleCursor = (): void => {
      try {
        const b = term.buffer.active;
        const row = b.cursorY + b.baseY;
        if (lastCursorRow >= 0 && lastCursorRow !== row) {
          const viewportRow = lastCursorRow - b.baseY;
          term.refresh(viewportRow < 0 ? 0 : Math.min(viewportRow, term.rows - 1), term.rows - 1);
        }
        lastCursorRow = row;
      } catch {
        /* buffer 尚未就绪：跳过 */
      }
    };
    const queueOut = (data: string): void => {
      pendingOut += data;
      if (outSince === 0) outSince = Date.now();
      if (Date.now() - outSince >= COALESCE_MAX_MS) {
        flushOut();
        return;
      }
      if (outTimer !== null) window.clearTimeout(outTimer);
      outTimer = window.setTimeout(flushOut, COALESCE_MS);
    };
    const client = new TerminalClient(instanceId, interactive ? 'interactive' : 'readonly', {
      onFrame: (frame: TerminalFrame) => {
        switch (frame.type) {
          case 'attached':
            setStatus('live');
            break;
          case 'terminal.output':
            queueOut(frame.data);
            break;
          case 'terminal.gap':
            replayGap = true;
            queueOut(
              frame.reason === 'replay-unsupported'
                ? '\r\n\x1b[90m── 历史回放不可用（Runtime Host 版本旧），触发重绘以恢复当前屏 ──\x1b[0m\r\n'
                : '\r\n\x1b[90m── 输出缺口（' + (frame.until ?? '?') + ' 前）──\x1b[0m\r\n',
            );
            break;
          case 'lease.granted':
            setLease('granted');
            client.startLeaseHeartbeat(frame.leaseId);
            if (initialCommand && !initialSentRef.current) {
              // 等一拍让 shell 提示符先出来（spawn 到 prompt 就绪有一拍间隙）
              setTimeout(() => client.stdin(initialCommand), 500);
              initialSentRef.current = true;
            }
            // TUI 是重绘型字节流：PTY resize 触发宿主整屏重画——重放有缺口时屏上
            // 只是残片（旧 Host 无 replay / ring 从半帧截断），先清屏（含回滚缓冲）
            // 再触发重绘，残字与错位重叠不会留在屏上。缺口本身仍由 gap 帧如实标注。
            if (replayGap) {
              replayGap = false;
              flushOut();
              term.write('\x1b[2J\x1b[3J\x1b[H');
            }
            fit.fit();
            client.resize(term.cols, term.rows);
            break;
          case 'lease.denied':
          case 'lease.released':
            setLease('denied');
            break;
          case 'instance.exited':
            // 终态：实例退出（宿主 TUI 正常退出 / Host 崩溃连带）——重连无意义
            //（TerminalClient 已停摆），给恢复引导。
            setStatus('exited');
            setLease('pending');
            flushOut();
            term.write('\r\n\x1b[90m── 实例已退出 ──\x1b[0m\r\n');
            break;
          case 'error':
            if (frame.fatal) {
              setStatus('exited');
              setLease('pending');
              flushOut();
              term.write('\r\n\x1b[90m── 实例已不存在（Runtime Host 崩溃或实例已退出）──\x1b[0m\r\n');
            }
            break;
          default:
            break;
        }
      },
      onDisconnect: () => setStatus('disconnected'),
      onReconnect: () => setStatus('live'),
    });
    clientRef.current = client;
    // attach 带真实视口几何：网关在 attach 时按它对齐 PTY（readonly 没有 Lease
    // 发不了 resize，只有这条路能把真尺寸带过去）。
    client.setDimensions(term.cols, term.rows);
    client.connect();

    if (interactive) {
      // TUI 的键序原样进 stdin；写权在 WebSocket open 后申请。
      term.onData((data) => client.stdin(data));
    }

    const onResize = () => {
      fit.fit();
      client.setDimensions(term.cols, term.rows);
      client.resize(term.cols, term.rows);
    };
    window.addEventListener('resize', onResize);
    // 容器级尺寸变化（分屏重排 / 弹窗首帧晚一拍）window resize 盖不到：
    // 没有它 PTY 几何停在挂载那拍的错值，屏下留空黑区。
    let lastCols = term.cols;
    let lastRows = term.rows;
    const ro = new ResizeObserver(() => {
      fit.fit();
      if (term.cols === lastCols && term.rows === lastRows) return;
      lastCols = term.cols;
      lastRows = term.rows;
      client.setDimensions(term.cols, term.rows);
      client.resize(term.cols, term.rows);
    });
    if (holder.current) ro.observe(holder.current);
    return () => {
      window.removeEventListener('resize', onResize);
      ro.disconnect();
      if (outTimer !== null) window.clearTimeout(outTimer);
      client.close();
      term.dispose();
    };
  }, [instanceId, interactive, initialCommand]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 px-3 py-1.5 text-xs text-[var(--w-muted-foreground, #666)]">
        <span
          className={
            'inline-block size-2 rounded-full ' +
            (status === 'live'
              ? 'animate-pulse bg-blue-500'
              : status === 'connecting'
                ? 'bg-amber-500'
                : 'bg-red-500')
          }
        />
        {status === 'live'
          ? '已连接'
          : status === 'connecting'
            ? '连接中…'
            : status === 'exited'
              ? '实例已退出——关掉此面板后用会话的终端按钮可恢复（resume）'
              : '已断开，重连中…'}
        {interactive && status === 'live' && (
          <span>
            {lease === 'granted' ? '· 输入已解锁' : lease === 'pending' ? '· 申请输入权…' : '· 只读（输入权被占用）'}
          </span>
        )}
      </div>
      <div className="relative min-h-0 flex-1">
        <div ref={holder} className="h-full overflow-hidden bg-black/90 p-1" />
        {coarse && interactive && status === 'live' && lease === 'granted' && (
          <>
            {showKeys && (
              <div className="absolute inset-x-2 bottom-12 flex flex-wrap gap-1 rounded-lg border border-edge/[0.16] bg-neutral-900/95 p-1.5 shadow-mac">
                {KEY_PAD.map((k) => (
                  <button
                    key={k.label}
                    type="button"
                    onClick={() => sendKey(k.data)}
                    className="min-w-10 rounded px-2 py-1.5 text-xs text-neutral-300 transition-colors hover:bg-edge/[0.12] active:bg-edge/[0.2]"
                  >
                    {k.label}
                  </button>
                ))}
              </div>
            )}
            <button
              type="button"
              aria-label="快捷键"
              aria-expanded={showKeys}
              onClick={() => setShowKeys((v) => !v)}
              className="absolute left-3 bottom-3 flex size-7 items-center justify-center rounded-full border border-edge/[0.16] bg-neutral-900/90 text-neutral-300 shadow-mac transition-colors hover:border-edge/[0.3] hover:text-neutral-100"
            >
              <Keyboard className="h-4 w-4" />
            </button>
          </>
        )}
        {scrolledUp && (
          <button
            type="button"
            onClick={() => {
              termRef.current?.scrollToBottom();
              setScrolledUp(false);
            }}
            aria-label="滚动到底部"
            className="absolute right-3 bottom-3 flex size-7 items-center justify-center rounded-full border border-edge/[0.16] bg-neutral-900/90 text-neutral-300 shadow-mac transition-colors hover:border-edge/[0.3] hover:text-neutral-100"
          >
            <ChevronDown className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  );
}
