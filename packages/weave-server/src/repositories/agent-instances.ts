import type { DatabaseSync } from 'node:sqlite';
import type { AgentInstanceRecord, AgentInstanceStatus, ExecutionMode } from '../runtime/protocol.js';

/**
 * agent_instances 表仓储（daemon 是唯一 writer——agent-runtime-host-design.md
 * §6.2：Host 不开第二个 SQLite 连接，所有落库都从 daemon 走）。
 */

export interface NewAgentInstance {
  id: string;
  projectId: number;
  harness: string;
  executionMode: ExecutionMode;
  workingDirectory: string;
  command: string;
}

export class AgentInstanceRepository {
  constructor(private readonly db: DatabaseSync) {}

  create(row: NewAgentInstance): void {
    this.db
      .prepare(
        `INSERT INTO agent_instances (id, project_id, harness, status, execution_mode, working_directory, command, created_at)
         VALUES (?, ?, ?, 'created', ?, ?, ?, ?)`,
      )
      .run(row.id, row.projectId, row.harness, row.executionMode, row.workingDirectory, row.command, new Date().toISOString());
  }

  get(id: string): AgentInstanceRecord | null {
    const row = this.db.prepare('SELECT * FROM agent_instances WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? fromRow(row) : null;
  }

  listByProject(projectId: number): AgentInstanceRecord[] {
    return (
      this.db.prepare('SELECT * FROM agent_instances WHERE project_id = ? ORDER BY id DESC').all(projectId) as Array<Record<string, unknown>>
    ).map(fromRow);
  }

  /** headless 全量（对账入参：Host 报的清单与它们三向比对）。 */
  listHeadless(): AgentInstanceRecord[] {
    return (
      this.db.prepare(`SELECT * FROM agent_instances WHERE execution_mode = 'headless' ORDER BY id`).all() as Array<Record<string, unknown>>
    ).map(fromRow);
  }

  markStarting(id: string, runtimeHostId: string, osPid: number): void {
    this.db
      .prepare(`UPDATE agent_instances SET status = CASE WHEN status = 'created' THEN 'starting' ELSE status END, runtime_host_id = ?, os_pid = ?, started_at = ? WHERE id = ?`)
      .run(runtimeHostId, osPid, new Date().toISOString(), id);
  }

  markStatus(id: string, status: AgentInstanceStatus, errorMessage?: string): void {
    this.db
      .prepare(`UPDATE agent_instances SET status = ?, error_message = ? WHERE id = ?`)
      .run(status, errorMessage ?? null, id);
  }

  /** Host 确认 started：只推进仍处 starting 的行（已退出/失败的不复活）。 */
  markRunning(id: string): void {
    this.db
      .prepare(`UPDATE agent_instances SET status = 'running' WHERE id = ? AND status = 'starting'`)
      .run(id);
  }

  markExited(id: string, exitCode: number): void {
    this.db
      .prepare(`UPDATE agent_instances SET status = 'exited', exited_at = ?, exit_code = ? WHERE id = ?`)
      .run(new Date().toISOString(), exitCode, id);
  }

  markFailed(id: string, errorMessage: string): void {
    this.db
      .prepare(`UPDATE agent_instances SET status = 'failed', error_message = ?, exited_at = ? WHERE id = ?`)
      .run(errorMessage, new Date().toISOString(), id);
  }

  /** headless 实例 ↔ 会话绑定（hook 旁路上报的 instanceId 归因）：首绑即定，不覆盖。 */
  bindSession(id: string, harnessSessionId: string): void {
    this.db
      .prepare(`UPDATE agent_instances SET harness_session_id = ? WHERE id = ? AND harness_session_id IS NULL`)
      .run(harnessSessionId, id);
  }

  /** osPid 随 Host 对账刷新；harnessSessionId 不传时保原值（对账路径不冲掉 ingest 绑上的会话）。 */
  updatePid(id: string, osPid?: number, harnessSessionId?: string): void {
    this.db
      .prepare(`UPDATE agent_instances SET os_pid = ?, harness_session_id = COALESCE(?, harness_session_id) WHERE id = ?`)
      .run(osPid ?? null, harnessSessionId ?? null, id);
  }
}

function fromRow(row: Record<string, unknown>): AgentInstanceRecord {
  return {
    id: String(row.id),
    projectId: Number(row.project_id),
    harness: String(row.harness),
    status: row.status as AgentInstanceStatus,
    executionMode: row.execution_mode as ExecutionMode,
    workingDirectory: String(row.working_directory),
    command: String(row.command),
    osPid: row.os_pid == null ? undefined : Number(row.os_pid),
    harnessSessionId: row.harness_session_id == null ? undefined : String(row.harness_session_id),
    runtimeHostId: row.runtime_host_id == null ? undefined : String(row.runtime_host_id),
    errorMessage: row.error_message == null ? undefined : String(row.error_message),
    createdAt: String(row.created_at),
    startedAt: row.started_at == null ? undefined : String(row.started_at),
    exitedAt: row.exited_at == null ? undefined : String(row.exited_at),
    exitCode: row.exit_code == null ? undefined : Number(row.exit_code),
  };
}
