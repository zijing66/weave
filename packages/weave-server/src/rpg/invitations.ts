import type { DatabaseSync } from 'node:sqlite';
import type { PeerRepository } from '../repositories/peers.js';
import type { RpgRoleRepository } from './roles.js';
import type { DecisionKernel } from '../hooks/decision-kernel.js';

/**
 * 跨机角色邀请（F2，RPG 稿 §六 493-514）：加入单位 = 角色 + 用户；**全程 HITL**
 * ——接受/拒绝必须手动点（自动模式默认关），AI 选角结果必须手动确认后才写
 * teams。邀请本身只是一条待确认记录（对端经 /federation/call 投递），不执行
 * 任何动作。有效期 48h 定死常量（裁决：不进 settings）。
 */

/** 邀请有效期（裁决：48h 定死，不进 settings）。 */
export const INVITATION_TTL_MS = 48 * 60 * 60_000;

/** call 服务表的邀请行名（federation.ts 引用同一常量口径）。 */
export const F2_INVITE_SERVICE = 'rpg.invite';

export const INVITATION_STATUSES = ['pending', 'accepted', 'declined', 'expired'] as const;
export type InvitationStatus = (typeof INVITATION_STATUSES)[number];

export interface RpgInvitationRow {
  id: number;
  peerId: string;
  /** 对端可读机器名（join peers 派生；peer 行已删 = 原样留 id）。 */
  peerName: string | null;
  team: string;
  scene: string | null;
  roles: Array<{ role: string; module?: string }> | null;
  message: string | null;
  status: InvitationStatus;
  decidedBy: string | null;
  /** §七可观测：谁邀请、AI 推荐了什么、用户实际选了什么。 */
  provenance: string | null;
  createdAt: string;
  decidedAt: string | null;
}

export class RpgInvitationRepository {
  constructor(private readonly db: DatabaseSync) {}

  create(input: {
    peerId: string;
    team: string;
    scene?: string | null;
    roles?: Array<{ role: string; module?: string }> | null;
    message?: string | null;
  }): RpgInvitationRow {
    const at = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO rpg_invitations (peer_id, team, scene, roles, message, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(
        input.peerId,
        input.team,
        input.scene ?? null,
        input.roles == null ? null : JSON.stringify(input.roles),
        input.message ?? null,
        at,
      );
    const row = this.db
      .prepare('SELECT id FROM rpg_invitations WHERE peer_id = ? AND created_at = ? ORDER BY id DESC LIMIT 1')
      .get(input.peerId, at) as { id: number } | undefined;
    return this.getById(row!.id)!;
  }

  getById(id: number): RpgInvitationRow | undefined {
    const row = this.db.prepare('SELECT * FROM rpg_invitations WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? toInvitation(row) : undefined;
  }

  list(): RpgInvitationRow[] {
    return (
      this.db.prepare('SELECT * FROM rpg_invitations ORDER BY id DESC LIMIT 200').all() as Array<
        Record<string, unknown>
      >
    ).map(toInvitation);
  }

  /** 待办位（web 待办卡的数据源）：未决定且未过期的排前。 */
  listPending(): RpgInvitationRow[] {
    return this.list().filter((r) => r.status === 'pending');
  }

  decide(id: number, status: Exclude<InvitationStatus, 'pending'>, decidedBy: string): boolean {
    const row = this.getById(id);
    if (!row || row.status !== 'pending') return false;
    this.db
      .prepare(`UPDATE rpg_invitations SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?`)
      .run(status, decidedBy, new Date().toISOString(), id);
    return true;
  }

  /** provenance 账（§七可观测）：选角链路落一行摘要（谁邀请、AI 推荐了什么）。 */
  setProvenance(id: number, text: string): void {
    this.db.prepare(`UPDATE rpg_invitations SET provenance = ? WHERE id = ?`).run(text, id);
  }

  /** 过期扫（读面惰性触发；48h 裁决定死）。返回本轮刚置 expired 的行数。 */
  expireOverdue(now: number = Date.now()): number {
    const pending = this.db
      .prepare(`SELECT id, created_at FROM rpg_invitations WHERE status = 'pending'`)
      .all() as Array<{ id: number; created_at: string }>;
    let n = 0;
    for (const row of pending) {
      const at = Date.parse(row.created_at);
      if (Number.isFinite(at) && now - at > INVITATION_TTL_MS) {
        this.db
          .prepare(`UPDATE rpg_invitations SET status = 'expired', decided_at = ? WHERE id = ?`)
          .run(new Date(now).toISOString(), row.id);
        n++;
      }
    }
    return n;
  }
}

function toInvitation(row: Record<string, unknown>): RpgInvitationRow {
  let roles: RpgInvitationRow['roles'] = null;
  if (typeof row.roles === 'string') {
    try {
      const parsed: unknown = JSON.parse(row.roles);
      if (Array.isArray(parsed)) {
        roles = parsed
          .filter(
            (r): r is { role: string; module?: string } =>
              r != null && typeof (r as { role?: unknown }).role === 'string',
          )
          .map((r) => (typeof r.module === 'string' ? { role: r.role, module: r.module } : { role: r.role }));
      }
    } catch {
      /* 坏 JSON = null */
    }
  }
  const status = String(row.status);
  return {
    id: Number(row.id),
    peerId: String(row.peer_id),
    peerName: null,
    team: String(row.team),
    scene: row.scene == null ? null : String(row.scene),
    roles,
    message: row.message == null ? null : String(row.message),
    status: (INVITATION_STATUSES as readonly string[]).includes(status)
      ? (status as InvitationStatus)
      : 'pending',
    decidedBy: row.decided_by == null ? null : String(row.decided_by),
    provenance: row.provenance == null ? null : String(row.provenance),
    createdAt: String(row.created_at),
    decidedAt: row.decided_at == null ? null : String(row.decided_at),
  };
}

/** 列表回填对端机器名（join 语义由调用方装配，repo 不持 peers 引用）。 */
export function withPeerNames(
  rows: RpgInvitationRow[],
  peers: Pick<PeerRepository, 'list'>,
): RpgInvitationRow[] {
  const byId = new Map(peers.list().map((p) => [p.id, p.name]));
  return rows.map((r) => ({ ...r, peerName: byId.get(r.peerId) ?? null }));
}

// ---- AI 选角（决策内核消费，零新机制）----

/** 选角请求形状：邀请的团队目标/场景 + 本机角色清单。 */
export interface CastingInput {
  team: string;
  goal?: string | null;
  scene?: string | null;
}

export interface CastPick {
  roleId: number;
  name: string;
  reason: string;
}

export type CastingResult =
  | { ok: true; source: 'decision-model' | 'fork'; picks: CastPick[] }
  | { ok: false; reason: string };

const CASTING_TIMEOUT_MS = 30_000;

/** provenance 词表（§七可观测）：谁邀请、AI 推荐了什么、用户实际选了什么。 */
export const GROWTH_VERB_CAST = 'cast';

/**
 * AI 选角（§六 493-514：决策内核 evaluate 形态，决策模型优先 / fork 回落）。
 * 输入 = 邀请的团队目标/场景 + 本机角色清单（七型/六维/人设摘要），输出 =
 * 推荐角色子集 + 每个一句理由。**产出只是推荐**——用户手动确认后才写 teams。
 * 决策模型未配置 / fork 不支持 / 回答解析不出 → ok:false（前端回落手选全量表单，
 * 不硬造结果）。
 */
export async function castRolesFromInvitation(deps: {
  kernel: Pick<DecisionKernel, 'evaluate'>;
  roles: Pick<RpgRoleRepository, 'list'>;
  aiConfig?: { baseUrl: string; model: string; apiKey: string } | null;
  fetchImpl?: typeof fetch;
  now?: number;
}, invitation: CastingInput): Promise<CastingResult> {
  const roster = deps.roles.list();
  if (roster.length === 0) return { ok: false, reason: 'no local roles to cast from' };
  const lines = roster.map(
    (r) =>
      `id=${r.id} name=${r.name} archetype=${r.archetype ?? 'custom'} persona=${(r.persona ?? '').slice(0, 120)}`,
  );
  const prompt = [
    `A remote weave peer invites you to join team "${invitation.team}"` +
      `${invitation.goal ? ` (goal: ${invitation.goal})` : ''}` +
      `${invitation.scene ? ` in scene "${invitation.scene}"` : ''}.`,
    'Local role roster:',
    ...lines,
    'Pick the subset of roles that best fits this collaboration and give a one-sentence reason for each pick.',
    'Respond with ONLY a JSON object: {"picks":[{"id":<role id>,"reason":"..."}]}. No other text.',
  ].join('\n');

  // 决策模型优先（配置每次现读——设置页改完即时生效）；未配置回落 fork。
  if (deps.aiConfig) {
    const viaModel = await castWithDecisionModel(deps.aiConfig, prompt, roster, deps.fetchImpl);
    if (viaModel) return viaModel;
  }
  const viaKernel = await castWithKernel(deps.kernel, prompt, roster);
  return viaKernel ?? { ok: false, reason: 'casting kernel could not produce a parsable answer' };
}

async function castWithDecisionModel(
  cfg: { baseUrl: string; model: string; apiKey: string },
  prompt: string,
  roster: Array<{ id: number; name: string }>,
  fetchImpl?: typeof fetch,
): Promise<CastingResult | null> {
  try {
    const res = await (fetchImpl ?? fetch)(`${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        stream: false,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(CASTING_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const payload = (await res.json().catch(() => null)) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    } | null;
    const content = payload?.choices?.[0]?.message?.content;
    return typeof content === 'string' ? parsePicks(content, 'decision-model', roster) : null;
  } catch {
    return null;
  }
}

async function castWithKernel(
  kernel: Pick<DecisionKernel, 'evaluate'>,
  prompt: string,
  roster: Array<{ id: number; name: string }>,
): Promise<CastingResult | null> {
  // evaluate 的 summarize 档 = 单 fork 只出总结；sessionId 传 '*'（选角不绑会话，
  // fork 面 supports('*') 由装配侧答——无头回合本就不依赖具体会话上下文）。
  const out = await kernel.evaluate({
    sessionId: '*',
    summarize: prompt,
    upstream: null,
  });
  if (out.ok && out.summary) return parsePicks(out.summary, out.source, roster);
  return null;
}

/** 选角来源词表（CastingResult.ok.source）。 */
type CastingSource = 'decision-model' | 'fork';

/** 选角回答解析：首个 JSON 对象里取 picks（id 对上本机清单才收）。 */
function parsePicks(
  raw: string,
  source: CastingSource,
  roster?: Array<{ id: number; name: string }>,
): CastingResult | null {
  const json = raw.match(/\{[\s\S]*\}/);
  if (!json) return null;
  try {
    const value = JSON.parse(json[0]) as { picks?: unknown };
    if (!Array.isArray(value.picks)) return null;
    const validIds =
      roster == null ? null : new Set(roster.map((r) => r.id));
    const picks: CastPick[] = [];
    for (const item of value.picks) {
      if (item == null || typeof item !== 'object') continue;
      const o = item as { id?: unknown; reason?: unknown };
      const id = typeof o.id === 'number' ? o.id : Number(o.id);
      if (!Number.isInteger(id)) continue;
      if (validIds && !validIds.has(id)) continue;
      picks.push({
        roleId: id,
        name: roster?.find((r) => r.id === id)?.name ?? String(id),
        reason: typeof o.reason === 'string' ? o.reason.slice(0, 300) : '',
      });
    }
    if (picks.length === 0) return null;
    return { ok: true, source, picks };
  } catch {
    return null;
  }
}
