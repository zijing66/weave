/**
 * Agent Runtime 基础协议（B0）：AgentInstance 状态机、Runtime Host IPC 消息与
 * Terminal Stream Protocol 的类型。设计依据 = docs/plan/agent-runtime-terminal-gateway.md
 * 与 docs/plan/agent-runtime-terminal-design.md §4/§5/§6。
 *
 * 标识纪律：instanceId（weave 生成）/ harnessSessionId / osPid / ptyId /
 * terminalSessionId / clientId 互不混用——pid 会复用、harness 会话 id 归宿主，
 * 只有 instanceId 是本域主键。
 */

/** 实例状态词表（封闭枚举；转场校验见 instance-registry.ts）。 */
export const AGENT_INSTANCE_STATUSES = [
  'created',
  'starting',
  'running',
  'waiting_input',
  'waiting_approval',
  'paused',
  'exited',
  'failed',
  'recovering',
] as const;
export type AgentInstanceStatus = (typeof AGENT_INSTANCE_STATUSES)[number];

/** headless = Runtime Host 持 PTY 不开窗口；interactive = 外部终端（现状路径）。 */
export type ExecutionMode = 'headless' | 'interactive';

/** `agent_instances` 表行形（持久面只存生命周期事实；ptyId 等实时句柄归 Host 内存）。 */
export interface AgentInstanceRecord {
  id: string;
  projectId: number;
  harness: string;
  status: AgentInstanceStatus;
  executionMode: ExecutionMode;
  workingDirectory: string;
  command: string;
  osPid?: number;
  harnessSessionId?: string;
  runtimeHostId?: string;
  errorMessage?: string;
  createdAt: string;
  startedAt?: string;
  exitedAt?: string;
  exitCode?: number;
}

/** daemon → Runtime Host 的 IPC 请求。 */
export interface RuntimeHostRequest {
  id: string;
  type: string;
  instanceId?: string;
  payload?: unknown;
}

/** Runtime Host → daemon 的 IPC 响应。 */
export interface RuntimeHostResponse {
  id: string;
  success: boolean;
  payload?: unknown;
  error?: string;
}

export type RuntimeHostEventType =
  | 'instance.started'
  | 'instance.exited'
  | 'instance.error'
  | 'terminal.output'
  | 'terminal.resize'
  | 'resource.updated';

/** Runtime Host → daemon 的单向事件（terminal.output 的 sequence 按 instance 单调递增）。 */
export interface RuntimeHostEvent {
  eventId: string;
  instanceId: string;
  sequence: number;
  type: RuntimeHostEventType;
  timestamp: number;
  payload: unknown;
}

/**
 * 终端输出帧：终端是字节流不是文本——ANSI / OSC / 全屏 TUI 必须原样保留，
 * 故 data 恒 base64。sequence 按 instance 单调递增，重连按它重放缺口。
 */
export interface TerminalOutputEvent {
  instanceId: string;
  terminalSessionId: string;
  sequence: number;
  timestamp: number;
  encoding: 'base64';
  data: string;
}

export interface TerminalInputEvent {
  instanceId: string;
  clientId: string;
  inputLeaseId: string;
  data: string;
}

export interface TerminalResizeEvent {
  instanceId: string;
  cols: number;
  rows: number;
  clientId: string;
}

/** 客户端连接请求（重连带 lastSequence，服务端按它重放；缺口给 gap 标记不装完整）。 */
export interface TerminalAttachRequest {
  instanceId: string;
  lastSequence?: number;
  cols: number;
  rows: number;
  mode: 'readonly' | 'interactive';
}

/** 多客户端输入仲裁：一会话多读、至多一写（持有 Lease、心跳续期、超时可接管）。 */
export interface InputLease {
  instanceId: string;
  clientId: string;
  leaseId: string;
  expiresAt: number;
}
