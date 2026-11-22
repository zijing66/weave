import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import type { AuthService } from '../../daemon/dashboard-auth.js';
import { acceptWebSocket, startReading, writeClose, writeText } from './ws-frame.js';
import type { TerminalGateway } from './session-gateway.js';
import type { RuntimeSupervisor } from '../supervisor.js';
import { randomUUID } from 'node:crypto';

/**
 * `/terminals/ws` WebSocket 端点（B3）：浏览器 WS 自动带 cookie，认证判据与
 * HTTP/SSE 同一条（isAuthenticated）。协议 = NDJSON over WS：
 *
 * - 客户端首帧 `{"type":"attach","instanceId":…,"lastSequence":…,"mode":…}`
 * - 下行 `terminal.output` / `terminal.gap` / `attached` / `lease.*`
 * - 上行 `stdin`（须持 Lease）/ `resize`（须持 Lease）/ `heartbeat` / `release` / `detach`
 */

export function attachTerminalWebSocket(
  server: Server,
  deps: { auth?: AuthService; runtimeSupervisor?: RuntimeSupervisor },
  gateway: TerminalGateway,
): void {
  server.on('upgrade', terminalUpgradeHandler(deps, gateway));
}

/** upgrade 监听本体：HTTP 与 TLS 两个监听各挂同一份（TLS 是独立 server 实例，
 *  没挂的会把 WS upgrade 当普通请求回落 SPA——2026-11-20 B4 实测）。 */
export function terminalUpgradeHandler(
  deps: { auth?: AuthService; runtimeSupervisor?: RuntimeSupervisor },
  gateway: TerminalGateway,
): (req: IncomingMessage, socket: Duplex, head: Buffer) => void {
  return (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = (() => {
      try {
        return new URL(req.url ?? '/', 'http://localhost');
      } catch {
        return null;
      }
    })();
    if (!url || url.pathname !== '/terminals/ws') {
      // 不是本端点的 upgrade：拒绝（daemon 目前没有其它 WS 端点）
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    if (deps.auth && !deps.auth.isAuthenticated(req.headers)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    if (!acceptWebSocket(req, socket)) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }
    if (head.length > 0) socket.write(head); // 遗留缓冲（正常为空）
    const clientId = randomUUID();
    let attached = false;
    startReading(
      socket,
      (text) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(text) as Record<string, unknown>;
        } catch {
          writeClose(socket, 1003);
          socket.destroy();
          return;
        }
        const instanceId = String(msg.instanceId ?? '');
        switch (msg.type) {
          case 'attach': {
            if (attached || !instanceId) {
              writeText(socket, JSON.stringify({ type: 'error', error: attached ? 'already attached' : 'instanceId required' }));
              return;
            }
            attached = true;
            // 下行经 WS 帧（Gateway 不懂传输——send 注入）；背压 = 可写缓冲超限
            const send = (text: string) =>
              !socket.destroyed && socket.writableLength <= 8 * 1024 * 1024 && (writeText(socket, text), true);
            gateway.attach(send, {
              clientId,
              instanceId,
              lastSequence: typeof msg.lastSequence === 'number' ? msg.lastSequence : undefined,
              cols: typeof msg.cols === 'number' ? msg.cols : 80,
              rows: typeof msg.rows === 'number' ? msg.rows : 24,
              mode: msg.mode === 'interactive' ? 'interactive' : 'readonly',
            });
            return;
          }
          case 'stdin': {
            if (!instanceId) return;
            const data = String(msg.data ?? '');
            if (!gateway.canWrite(instanceId, clientId)) {
              writeText(socket, JSON.stringify({ type: 'error', error: 'no input lease — request control first' }));
              return;
            }
            void deps.runtimeSupervisor?.sendStdin(instanceId, data).catch(() => {});
            return;
          }
          case 'resize': {
            if (!instanceId) return;
            if (!gateway.canWrite(instanceId, clientId)) return;
            void deps.runtimeSupervisor
              ?.resize(instanceId, Number(msg.cols ?? 80), Number(msg.rows ?? 24))
              .catch(() => {});
            return;
          }
          case 'request_control': {
            if (!instanceId) return;
            const lease = gateway.requestControl(instanceId, clientId);
            writeText(socket, JSON.stringify({ type: lease ? 'lease.granted' : 'lease.denied', instanceId, ...(lease ? { leaseId: lease.leaseId, expiresAt: lease.expiresAt } : {}) }));
            return;
          }
          case 'heartbeat': {
            if (!instanceId) return;
            gateway.heartbeatLease(instanceId, clientId, String(msg.leaseId ?? ''));
            return;
          }
          case 'release': {
            if (!instanceId) return;
            gateway.releaseControl(instanceId, clientId);
            return;
          }
          case 'detach': {
            gateway.detach(clientId);
            return;
          }
          default:
            return; // 未知消息忽略（前向兼容）
        }
      },
      () => gateway.detach(clientId),
    );
  };
}
