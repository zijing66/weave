/**
 * Agent Runtime 基础协议（B0）：AgentInstance 状态机、Runtime Host IPC 消息与
 * Terminal Stream Protocol 的类型。设计依据 = docs/plan/agent-runtime-terminal-gateway.md
 * 与 docs/plan/agent-runtime-terminal-design.md §4/§5/§6。
 *
 * 标识纪律：instanceId（weave 生成）/ harnessSessionId / osPid / ptyId /
 * terminalSessionId / clientId 互不混用——pid 会复用、harness 会话 id 归宿主，
 * 只有 instanceId 是本域主键。
 */

import { createHash } from 'node:crypto';
import path from 'node:path';
import { getRuntimeSocketDir } from '../db/paths.js';

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
 * 终端输出帧：终端是字节流不是文本——ANSI / OSC / 全屏 TUI 必须原样保留。
 * data = node-pty 已按 UTF-8 解码的原文字符串（保留 ANSI；B0 设想的 base64
 * 未采用，实测接线即原文）。sequence 按 instance 单调递增，重连按它重放缺口。
 */
export interface TerminalOutputEvent {
  instanceId: string;
  terminalSessionId: string;
  sequence: number;
  timestamp: number;
  /** 原文（见上）；保留字段名以兼容 B0 类型形状。 */
  encoding: 'utf8';
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

// ---------------------------------------------------------------------------
// IPC 消息词表（B1，docs/plan/agent-runtime-host-design.md §2）
// ---------------------------------------------------------------------------

/** Host 协议版本（不匹配 = 受控重启，见设计稿 §2.3）。 */
export const RUNTIME_PROTOCOL_VERSION = 1;

/** 请求类型词表（`type` 字段的封闭枚举）。 */
export const RUNTIME_REQUEST_TYPES = [
  'hello',
  'ping',
  'instance.spawn',
  'instance.stdin',
  'instance.resize',
  'instance.kill',
  'instance.replay',
  'instances.list',
  'shutdown.graceful',
] as const;
export type RuntimeRequestType = (typeof RUNTIME_REQUEST_TYPES)[number];

/** instance.spawn 的载荷（argv 已由 daemon 按能力面拼好，Host 不写 harness 硬编码）。 */
export interface InstanceSpawnPayload {
  instanceId: string;
  command: string;
  args: string[];
  cwd: string;
  cols: number;
  rows: number;
  env: Record<string, string>;
}

/** instance.stdin 的载荷（字节原文；层② sendText / 中断键序 / 作答键序同通道）。 */
export interface InstanceStdinPayload {
  data: string;
}

export interface InstanceResizePayload {
  cols: number;
  rows: number;
}

export interface HelloPayload {
  protocolVersion: number;
  weaveVersion: string;
  localToken: string;
}

/** 握手应答：hostId + 协议版本 + 全量实例清单（对账的起点，见设计稿 §2.3/§4）。 */
export interface HostAckPayload {
  hostId: string;
  protocolVersion: number;
  weaveVersion: string;
  instances: HostInstanceSummary[];
}

/** Host 自报的单个实例摘要。 */
export interface HostInstanceSummary {
  id: string;
  status: 'running' | 'exited';
  osPid?: number;
  harnessSessionId?: string;
  lastSequence: number;
}

/** resource.updated 载荷：Host 自报资源（进程内 process API，零开销）。 */
export interface ResourceReportPayload {
  hostId: string;
  /** Host 进程 CPU 占单核百分比（cpuUsage 差分自算，>100 = 多核）。 */
  hostCpuPercent: number;
  hostMemRssBytes: number;
  /** 活实例吞吐快照（outputBytes = 自 spawn 起累计 PTY 输出字节）。 */
  instances: Array<{ instanceId: string; osPid?: number; outputBytes: number }>;
  at: number;
}

/** pipe 名 = 裸名 + dataDir 哈希短码（多数据目录并存不冲突）。 */
export function runtimePipeName(dataDir: string): string {
  const hash = createHash('sha256').update(dataDir).digest('hex').slice(0, 8);
  return `weave-runtime-host-${hash}`;
}

export function runtimePipePath(dataDir: string): string {
  return ipcPathFor(dataDir, process.platform);
}

/**
 * daemon ↔ Host IPC 监听路径：Windows = Named Pipe（完整路径，listen 才不吃
 * EACCES）；POSIX = `<data>/cache/` 下的 Unix domain socket 文件（可弃目录，
 * stale socket 由 Host 启动时清理）。
 */
export function ipcPathFor(dataDir: string, platform: NodeJS.Platform): string {
  if (platform === 'win32') return `\\\\.\\pipe\\${runtimePipeName(dataDir)}`;
  return path.join(getRuntimeSocketDir(dataDir), `${runtimePipeName(dataDir)}.sock`);
}
