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

export function TerminalView({ instanceId, interactive = true }: TerminalViewProps) {
  const holder = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const clientRef = useRef<TerminalClient | null>(null);
  const [status, setStatus] = useState<'connecting' | 'live' | 'disconnected'>('connecting');
  const [lease, setLease] = useState<'pending' | 'granted' | 'denied'>('pending');

  useEffect(() => {
    setStatus('connecting');
    setLease('pending');
    const term = new Terminal({
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
      fit.fit();
    }

    const client = new TerminalClient(instanceId, interactive ? 'interactive' : 'readonly', {
      onFrame: (frame: TerminalFrame) => {
        switch (frame.type) {
          case 'attached':
            setStatus('live');
            break;
          case 'terminal.output':
            term.write(frame.data);
            break;
          case 'terminal.gap':
            term.write('\r\n\x1b[90m── 输出缺口（' + (frame.until ?? '?') + ' 前）──\x1b[0m\r\n');
            break;
          case 'lease.granted':
            setLease('granted');
            client.startLeaseHeartbeat(frame.leaseId);
            break;
          case 'lease.denied':
          case 'lease.released':
            setLease('denied');
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

    const onResize = () => {
      fit.fit();
      client.resize(term.cols, term.rows);
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
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
            (status === 'live' ? 'animate-pulse bg-blue-500' : status === 'connecting' ? 'bg-amber-500' : 'bg-red-500')
          }
        />
        {status === 'live' ? '已连接' : status === 'connecting' ? '连接中…' : '已断开，重连中…'}
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
