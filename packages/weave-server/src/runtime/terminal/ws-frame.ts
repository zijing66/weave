import { createHash } from 'node:crypto';
import type { Duplex } from 'node:stream';

/**
 * RFC6455 最小实现（B3）：只做服务端要用的子集——文本帧收发、ping/pong、close、
 * 掩码解码。不做：扩展/压缩、分片续帧（终端消息单帧足够，64KB 上限内拒绝超长）、
 * 二进制帧（协议全 JSON 文本）。零依赖（自包含发布纪律，与 SSE 同路线）。
 */

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** 握手：校验 Upgrade 请求并回 101；非 websocket 请求返回 false（调用方走 HTTP）。 */
export function acceptWebSocket(
  req: { headers: Record<string, string | string[] | undefined>; method?: string },
  socket: Duplex,
): boolean {
  const key = req.headers['sec-websocket-key'];
  const upgradeHeader = req.headers.upgrade;
  const upgrade = (Array.isArray(upgradeHeader) ? upgradeHeader[0] : upgradeHeader) ?? '';
  if (!key || Array.isArray(key)) return false;
  if (upgrade.toLowerCase() !== 'websocket') return false;
  const accept = createHash('sha1').update(`${key}${GUID}`).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n` +
      '\r\n',
  );
  return true;
}

/** 单帧写（服务端→客户端不掩码；opcode 1=文本 8=close 9=ping 10=pong）。 */
export function writeFrame(socket: Duplex, opcode: number, payload: string | Buffer): void {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = data.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.allocUnsafe(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.allocUnsafe(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode; // FIN + opcode
  socket.write(Buffer.concat([header, data]));
}

export function writeText(socket: Duplex, text: string): void {
  writeFrame(socket, 0x1, text);
}

export function writeClose(socket: Duplex, code = 1000): void {
  const payload = Buffer.allocUnsafe(2);
  payload.writeUInt16BE(code);
  writeFrame(socket, 0x8, payload);
}

/** 收帧解析：回调 (opcode, payloadString)；分帧/二进制/控制位异常按协议要求 close。 */
export function startReading(
  socket: Duplex,
  onMessage: (text: string) => void,
  onClose: (code: number) => void,
): void {
  let buf = Buffer.alloc(0);
  socket.on('data', (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const parsed = parseFrame(buf);
      if (!parsed) break;
      const { frame, consumed } = parsed;
      buf = buf.subarray(consumed);
      if (buf.length > 4 * 1024 * 1024) {
        writeClose(socket, 1009);
        socket.destroy();
        return;
      }
      switch (frame.opcode) {
        case 0x1: // 文本
          if (frame.payload.length > 1024 * 1024) {
            writeClose(socket, 1009);
            socket.destroy();
            return;
          }
          onMessage(frame.payload.toString('utf8'));
          break;
        case 0x8: // close
          writeClose(socket, 1000);
          socket.destroy();
          onClose(frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 1005);
          return;
        case 0x9: // ping → pong
          writeFrame(socket, 0xa, frame.payload);
          break;
        default: // pong 忽略；二进制/续帧不支持
          writeClose(socket, 1003);
          socket.destroy();
          onClose(1003);
          return;
      }
    }
  });
  socket.on('close', () => onClose(1006));
  socket.on('error', () => onClose(1006));
}

interface ParsedFrame {
  frame: { opcode: number; payload: Buffer };
  consumed: number;
}

function parseFrame(buf: Buffer): ParsedFrame | null {
  if (buf.length < 2) return null;
  const opcode = buf[0]! & 0x0f;
  const masked = (buf[1]! & 0x80) !== 0;
  let len = buf[1]! & 0x7f;
  let off = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    off = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    const big = buf.readBigUInt64BE(2);
    if (big > 16n * 1024n * 1024n) return { frame: { opcode: 0x8, payload: Buffer.alloc(0) }, consumed: buf.length };
    len = Number(big);
    off = 10;
  }
  const maskLen = masked ? 4 : 0;
  if (buf.length < off + maskLen + len) return null;
  let payload = buf.subarray(off + maskLen, off + maskLen + len);
  if (masked) {
    const mask = buf.subarray(off, off + 4);
    const out = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) out[i] = payload[i]! ^ mask[i % 4]!;
    payload = out;
  }
  return { frame: { opcode, payload }, consumed: off + maskLen + len };
}
