import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { TerminalClient, type TerminalFrame } from '@/lib/terminal';

/**
 * headless 实例的 Web Terminal（B4）：xterm.js 渲染 + TerminalClient 传输。
 * 只渲染选中实例（挂载即建、卸载即拆——多实例页面不常驻 xterm，§13.2）。
 */

interface TerminalViewProps {
  instanceId: string;
  interactive?: boolean;
}

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

export function TerminalView({ instanceId, interactive = true }: TerminalViewProps) {
  const holder = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const clientRef = useRef<TerminalClient | null>(null);
  const [status, setStatus] = useState<'connecting' | 'live' | 'disconnected' | 'exited'>('connecting');
  const [lease, setLease] = useState<'pending' | 'granted' | 'denied'>('pending');

  useEffect(() => {
    setStatus('connecting');
    setLease('pending');
    const term = new Terminal({
      fontFamily: "'Weave Nerd Mono', 'Cascadia Mono', Consolas, ui-monospace, monospace",
      fontSize: 12,
      cursorBlink: true,
      convertEol: false,
      scrollback: 5000,
    });
    termRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    if (holder.current) {
      term.open(holder.current);
      patchImeAnchor(term);
      fit.fit();
    }

    /** 重放有过缺口（旧 Host / ring 截断）⇒ 屏上是残片，拿到写权后清屏重绘。 */
    let replayGap = false;
    let lastWheelAt = 0;
    const client = new TerminalClient(instanceId, interactive ? 'interactive' : 'readonly', {
      onFrame: (frame: TerminalFrame) => {
        switch (frame.type) {
          case 'attached':
            setStatus('live');
            break;
          case 'terminal.output':
            // write 是异步解析：滚动必须挂在完成回调，否则这一拍仍按旧 buffer 钉底，
            // 大块 TUI 重绘解析完后又把光标推到视口外。
            term.write(frame.data, () => {
              if (Date.now() - lastWheelAt > 1500) term.scrollToBottom();
            });
            break;
          case 'terminal.gap':
            replayGap = true;
            term.write(
              frame.reason === 'replay-unsupported'
                ? '\r\n\x1b[90m── 历史回放不可用（Runtime Host 版本旧），触发重绘以恢复当前屏 ──\x1b[0m\r\n'
                : '\r\n\x1b[90m── 输出缺口（' + (frame.until ?? '?') + ' 前）──\x1b[0m\r\n',
            );
            break;
          case 'lease.granted':
            setLease('granted');
            client.startLeaseHeartbeat(frame.leaseId);
            // TUI 是重绘型字节流：PTY resize 触发宿主整屏重画——重放有缺口时屏上
            // 只是残片（旧 Host 无 replay / ring 从半帧截断），先清屏（含回滚缓冲）
            // 再触发重绘，残字与错位重叠不会留在屏上。缺口本身仍由 gap 帧如实标注。
            if (replayGap) {
              replayGap = false;
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
            term.write('\r\n\x1b[90m── 实例已退出 ──\x1b[0m\r\n');
            break;
          case 'error':
            if (frame.fatal) {
              setStatus('exited');
              setLease('pending');
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
    client.connect();

    if (interactive) {
      // TUI 的键序原样进 stdin；写权在 WebSocket open 后申请。
      term.onData((data) => client.stdin(data));
    }
    // 只把真实滚动手势记为「用户在滚动」——scrollToBottom 的程序滚动同样触发
    // onScroll，用它当判据会把钉底自己关掉（TUI 刷新一停，光标行就滚出视野，
    // 即「光标乱跑」），故改记 wheel/touchmove。
    const holderEl = holder.current;
    const markUserScroll = () => {
      lastWheelAt = Date.now();
    };
    holderEl?.addEventListener('wheel', markUserScroll, { passive: true });
    holderEl?.addEventListener('touchmove', markUserScroll, { passive: true });

    const onResize = () => {
      fit.fit();
      client.resize(term.cols, term.rows);
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      holderEl?.removeEventListener('wheel', markUserScroll);
      holderEl?.removeEventListener('touchmove', markUserScroll);
      client.close();
      term.dispose();
    };
  }, [instanceId, interactive]);

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
      <div ref={holder} className="min-h-0 flex-1 overflow-hidden bg-black/90 p-1" />
    </div>
  );
}
