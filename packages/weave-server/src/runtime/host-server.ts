import { createServer, type Socket } from 'node:net';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { dataRoots, getAuthPath } from '../db/paths.js';
import {
  RUNTIME_PROTOCOL_VERSION,
  runtimePipeName,
  type HostAckPayload,
  type HostInstanceSummary,
  type InstanceSpawnPayload,
  type RuntimeHostRequest,
  type RuntimeHostResponse,
} from './protocol.js';
import { InstanceManager, type InstanceEvent } from './instance-manager.js';
import { ptySpawnOf, resolveWindowsCommand } from './windows-bin-resolver.js';
import { spawnPty } from './adapters/windows-pty.js';

/**
 * Runtime Host 的 pipe server（agent-runtime-host-design.md §1–§3）：Host 常驻
 * 监听 Named Pipe，daemon 是 client。NDJSON 帧；首行必须是 hello（localToken
 * 校验），之后请求/响应按 id 关联、事件单向下行。
 */

/** 单连接下行缓冲上限：超过即丢 terminal.output（控制类事件永不丢），落 gap 标记。 */
const WRITE_LIMIT_BYTES = 4 * 1024 * 1024;

/** pipe 无连接且 0 活实例持续此时长 → 自退（僵尸 Host 兜底）。 */
const IDLE_EXIT_MS = 10 * 60 * 1000;

export class RuntimeHostServer {
  private readonly manager: InstanceManager;
  private readonly pipeName: string;
  private readonly localToken: string;
  private readonly hostId: string;
  private connections = 0;
  private idleTimer: NodeJS.Timeout | null = null;
  private droppedOutputs = 0;
  private sockets = new Set<Socket>();
  private readonly dataRootPath: string;

  constructor(
    private readonly dataDir: string,
    private readonly log: (msg: string) => void = (m) => console.log(`[weave-runtime] ${m}`),
  ) {
    const authPath = getAuthPath(dataDir);
    const auth = existsSync(authPath)
      ? (JSON.parse(readFileSync(authPath, 'utf8')) as { localToken?: string })
      : null;
    if (!auth?.localToken) throw new Error(`auth.json missing localToken (${authPath}) — start the daemon once first`);
    this.localToken = auth.localToken;
    this.dataRootPath = dataRoots(dataDir).data;
    this.pipeName = runtimePipeName(this.dataRootPath);
    this.hostId = this.loadOrCreateHostId();
    this.manager = new InstanceManager(spawnPty, (event) => this.onInstanceEvent(event));
  }

  private loadOrCreateHostId(): string {
    const file = `${dataRoots(this.dataDir).data}/runtime-host.json`;
    try {
      if (existsSync(file)) {
        const rec = JSON.parse(readFileSync(file, 'utf8')) as { hostId?: string };
        if (rec.hostId) return rec.hostId;
      }
    } catch {
      /* 坏文件重生成 */
    }
    const hostId = randomBytes(4).toString('hex');
    try {
      writeFileSync(file, JSON.stringify({ hostId, startedAt: new Date().toISOString() }, null, 2));
    } catch {
      /* 落不了盘也能跑（hostId 每次变，仅影响「同一个 Host」判定） */
    }
    return hostId;
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const server = createServer((socket) => this.onConnection(socket));
      server.on('error', reject);
      // listen 吃完整路径（`\\.\pipe\...`）——裸名会被当 unix socket 处理而 EACCES
      server.listen(`\\\\.\\pipe\\${this.pipeName}`, () => {
        this.log(`listening on ${this.pipeName} (hostId ${this.hostId})`);
        resolve();
      });
      this.server = server;
    });
    this.scheduleIdleExit();
  }

  private server: import('node:net').Server | null = null;

  private onConnection(socket: Socket): void {
    this.connections += 1;
    this.sockets.add(socket);
    this.cancelIdleExit();
    let authenticated = false;
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        let msg: RuntimeHostRequest;
        try {
          msg = JSON.parse(line) as RuntimeHostRequest;
        } catch {
          this.respond({ id: '', success: false, error: 'malformed NDJSON line' });
          continue;
        }
        if (!authenticated) {
          if (msg.type !== 'hello') {
            socket.destroy();
            return;
          }
          if (!this.verifyToken(msg.payload)) {
            socket.destroy();
            return;
          }
          authenticated = true;
          this.respond({ id: msg.id, success: true, payload: this.ack() });
          continue;
        }
        void this.handleRequest(msg);
      }
    });
    const gone = () => {
      this.sockets.delete(socket);
      this.connections -= 1;
      if (this.connections <= 0) this.scheduleIdleExit();
    };
    socket.on('close', gone);
    socket.on('error', gone);
  }

  private verifyToken(payload: unknown): boolean {
    const hello = payload as { localToken?: string; protocolVersion?: number } | undefined;
    if (!hello || hello.protocolVersion !== RUNTIME_PROTOCOL_VERSION) return false;
    const provided = hello.localToken ?? '';
    const a = Buffer.from(provided);
    const b = Buffer.from(this.localToken);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private ack(): HostAckPayload {
    return {
      hostId: this.hostId,
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      weaveVersion: process.env.WEAVE_VERSION ?? 'dev',
      instances: this.manager.summaries(),
    };
  }

  private async handleRequest(msg: RuntimeHostRequest): Promise<void> {
    try {
      const payload = await this.route(msg);
      this.respond({ id: msg.id, success: true, payload });
    } catch (err) {
      this.respond({
        id: msg.id,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async route(msg: RuntimeHostRequest): Promise<unknown> {
    switch (msg.type) {
      case 'ping':
        return { pong: true };
      case 'instance.spawn': {
        const raw = msg.payload as InstanceSpawnPayload;
        // npm shim 不能被 CreateProcess 解析（PoC 定案）——Host 侧统一走解析链
        const { file, args } = ptySpawnOf(resolveWindowsCommand(raw.command, raw.args));
        return this.manager.spawn({ ...raw, command: file, args });
      }
      case 'instance.stdin':
        this.manager.stdin(msg.instanceId!, (msg.payload as { data: string }).data);
        return {};
      case 'instance.resize': {
        const { cols, rows } = msg.payload as { cols: number; rows: number };
        this.manager.resize(msg.instanceId!, cols, rows);
        return {};
      }
      case 'instance.kill':
        this.manager.kill(msg.instanceId!);
        return {};
      case 'instance.replay': {
        const { after } = msg.payload as { after: number };
        return { entries: this.manager.replayAfter(msg.instanceId!, after) };
      }
      case 'instances.list':
        return { instances: this.manager.summaries() };
      case 'shutdown.graceful':
        this.log('graceful shutdown requested');
        void this.shutdown(process.exit);
        return {};
      default:
        throw new Error(`unknown request type "${msg.type}"`);
    }
  }

  private respond(res: RuntimeHostResponse): void {
    this.writeLine(JSON.stringify(res), false);
  }

  /** 事件单向下行（复制到全部连接；背压见 writeLine）。 */
  private onInstanceEvent(event: InstanceEvent): void {
    const frame =
      event.type === 'terminal.output'
        ? { type: event.type, instanceId: event.instanceId, sequence: event.sequence, data: event.data }
        : { type: event.type, instanceId: event.instanceId, ...('exitCode' in event ? { exitCode: event.exitCode } : { osPid: (event as { osPid: number }).osPid }) };
    this.writeLine(JSON.stringify({ eventId: randomBytes(8).toString('hex'), timestamp: Date.now(), ...frame }), event.type === 'terminal.output');
  }

  /**
   * 下行写：缓冲超限丢 terminal.output（计数），恢复后补一枚 gap 标记——控制类
   * 事件（instance.*）与响应永不丢。pty 句柄拖进程（PoC），写必须非阻塞。
   */
  private writeLine(line: string, isOutput: boolean): void {
    const sock = [...this.sockets];
    if (sock.length === 0) return; // 无人听：Host ring 已存，重连补拉
    for (const s of sock) {
      if (s.destroyed || s.writableLength > WRITE_LIMIT_BYTES) {
        if (isOutput) this.droppedOutputs += 1;
        continue;
      }
      if (this.droppedOutputs > 0) {
        const gap = JSON.stringify({
          eventId: randomBytes(8).toString('hex'),
          type: 'terminal.gap',
          dropped: this.droppedOutputs,
          timestamp: Date.now(),
        });
        this.droppedOutputs = 0;
        s.write(gap + '\n');
      }
      s.write(line + '\n');
    }
  }

  private scheduleIdleExit(): void {
    this.cancelIdleExit();
    if (this.manager.activeCount() > 0) return;
    this.idleTimer = setTimeout(() => {
      if (this.connections <= 0 && this.manager.activeCount() === 0) {
        this.log('idle exit');
        void this.shutdown(process.exit);
      }
    }, IDLE_EXIT_MS);
    this.idleTimer.unref();
  }

  private cancelIdleExit(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  /** 唯一退出路径：先杀全部实例（pty 句柄拖住 node，PoC 实测）。 */
  async shutdown(exit: (code?: number) => void): Promise<void> {
    this.cancelIdleExit();
    await this.manager.killAll();
    for (const s of this.sockets) s.destroy();
    this.server?.close();
    exit(0);
  }
}

export type { HostInstanceSummary };
