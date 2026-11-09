import { readFile } from 'node:fs/promises';
import { load as parseYaml } from 'js-yaml';
import { z } from 'zod';
import type { OrchestrationEdge, OrchestrationNode } from '../repositories/orchestrations.js';
import { validateOrchestration } from '../hooks/orchestration-graph.js';

/**
 * 任务剧本 playbook（RPG 稿 §四 + 11.3#16 定稿）：YAML 文件 = 编排图模板 + 任务
 * 标注。**模板 → 编排的转换是协调者侧纯函数**（占位替换 + 建编排），编排域不
 * 知道模板的存在（playbook A 裁决：文件层实例化，零表结构、编排域零改动）。
 *
 * **多图（11.3#16）**：`graphs: [...]` 一剧本渲染成编排集（互馈环 = 双编排交叉
 * 自然回合，静态拒环的编排单图装不下）；单图向后兼容——`graph:` 单键仍在
 * （等价于一张图的 graphs），两键同给以 `graphs` 为准。
 *
 * 节点 id 用 `r:<role>` 占位引用角色；渲染时按 `bindings`（角色仓库名 → 具体
 * sessionId）替换。任务属性（difficulty/risk/reward）是模板元数据随文件走，
 * orchestrations 表不加字段（11.4 附带结论）。
 */

export const PLAYBOOK_KINDS = ['日常', '主线', '团队', 'boss', '迭代'] as const;

const GraphFileSchema = z.object({
  /** 省略 = 自动生成 `g<序号>`。 */
  name: z.string().min(1).max(200).optional(),
  /** 省略 = 取剧本顶层 startText；每图可覆盖。 */
  startText: z.string().max(20_000).optional(),
  nodes: z
    .array(
      z.object({
        /** `r:<role>` 占位（渲染时替换为 sessionId）；`t:<uuid>` 触发节点原样保留。 */
        id: z.string().min(1).max(128),
        kind: z.enum(['session', 'trigger']).default('session'),
        /** 占位节点的角色仓库名（与 id 的 `r:<role>` 一致；冗余声明校验用）。 */
        role: z.string().min(1).max(128).optional(),
        /** 化身分工（同一角色多实例各负责一个模块；声明态，渲染不消费）。 */
        module: z.string().max(200).optional(),
      }),
    )
    .min(1),
  edges: z
    .array(
      z.object({
        id: z.string().min(1).max(64).optional(),
        from: z.string().min(1),
        to: z.string().min(1),
        text: z.string().max(20_000).default(''),
        extract: z.string().max(4_000).optional(),
        condition: z.string().max(4_000).optional(),
        when: z.string().max(500).optional(),
      }),
    )
    .default([]),
});

const PlaybookFileSchema = z.object({
  name: z.string().min(1).max(200),
  kind: z.enum(PLAYBOOK_KINDS).default('日常'),
  difficulty: z.number().int().min(1).max(10).default(5),
  risk: z.number().int().min(0).max(10).default(0),
  reward: z.object({ xp: z.number().int().min(0) }).optional(),
  startText: z.string().max(20_000).optional(),
  /** 多图形态（11.3#16）：一剧本渲染成编排集（互馈环）。 */
  graphs: z.array(GraphFileSchema).min(1).optional(),
  /** 单图形态（向后兼容）：等价于一张图的 graphs。与 graphs 同给以 graphs 为准。 */
  graph: GraphFileSchema.optional(),
});
export type PlaybookFile = z.infer<typeof PlaybookFileSchema>;

export type PlaybookParseResult =
  | { ok: true; playbook: PlaybookFile }
  | { ok: false; error: string };

/** 解析 playbook YAML 文本（盘上文件 → 模板对象）。 */
export function parsePlaybookYaml(raw: string): PlaybookParseResult {
  let doc: unknown;
  try {
    doc = parseYaml(raw);
  } catch (err) {
    return { ok: false, error: `Invalid YAML: ${err instanceof Error ? err.message : err}` };
  }
  const parsed = PlaybookFileSchema.safeParse(doc);
  if (!parsed.success) {
    return { ok: false, error: `Invalid playbook: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}` };
  }
  if (graphsOf(parsed.data).length === 0) {
    return { ok: false, error: 'Invalid playbook: needs "graphs" (or legacy "graph")' };
  }
  return { ok: true, playbook: parsed.data };
}

/** 读盘上的剧本文件并解析。 */
export async function readPlaybookFile(path: string): Promise<PlaybookParseResult> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    return { ok: false, error: `Cannot read playbook: ${err instanceof Error ? err.message : err}` };
  }
  return parsePlaybookYaml(raw);
}

/** 剧本的图清单（单图向后兼容在此归一；graphs 与 graph 同给以 graphs 为准）。 */
export function graphsOf(playbook: PlaybookFile): NonNullable<PlaybookFile['graphs']> {
  if (playbook.graphs) return playbook.graphs;
  if (playbook.graph) return [playbook.graph];
  return [];
}

// ---- 渲染（模板 → 编排定义的纯函数；编排域无感）----

/** 角色占位 → 具体 sessionId 的绑定表（协调者按 teams 声明与现存化身装配）。 */
export type PlaybookBindings = Record<string, string>;

export interface RenderedOrchestration {
  name: string;
  startText: string;
  nodes: OrchestrationNode[];
  edges: OrchestrationEdge[];
}

export type PlaybookRenderResult =
  | { ok: true; orchestrations: RenderedOrchestration[] }
  | { ok: false; error: string };

/**
 * 渲染整个剧本：`r:<role>` 占位按 bindings 替换成 sessionId，`t:` 触发节点原样
 * 保留。产出过 `validateOrchestration` 同判据的静态校验（形状先在这里拦，建编排
 * 的写入口仍以它为准）。
 */
export function renderPlaybook(
  playbook: PlaybookFile,
  bindings: PlaybookBindings,
): PlaybookRenderResult {
  const graphs = graphsOf(playbook);
  if (graphs.length === 0) return { ok: false, error: 'Playbook has no graphs' };
  const out: RenderedOrchestration[] = [];
  for (let gi = 0; gi < graphs.length; gi++) {
    const g = graphs[gi]!;
    const nodes: OrchestrationNode[] = [];
    const roleOf = new Map<string, string>();
    for (const n of g.nodes) {
      if (n.kind === 'trigger') {
        nodes.push({ id: n.id, kind: 'trigger' });
        continue;
      }
      const role = n.id.startsWith('r:') ? n.id.slice(2) : n.role;
      if (!role) return { ok: false, error: `Graph ${gi + 1}: session node "${n.id}" must be an r:<role> placeholder or declare role` };
      const sessionId = bindings[role];
      if (!sessionId) {
        return { ok: false, error: `Graph ${gi + 1}: no binding for role "${role}"` };
      }
      roleOf.set(n.id, sessionId);
      nodes.push({ id: sessionId, kind: 'session' });
    }
    const edges: OrchestrationEdge[] = g.edges.map((e, ei) => {
      // 占位节点之间连边换成 sessionId 对；trigger 节点 id 不换。
      const from = roleOf.get(e.from) ?? e.from;
      const to = roleOf.get(e.to) ?? e.to;
      return {
        id: e.id ?? `e${ei + 1}`,
        from,
        to,
        text: e.text,
        ...(e.extract ? { extract: e.extract } : {}),
        ...(e.condition ? { condition: e.condition } : {}),
        ...(e.when ? { when: e.when } : {}),
      };
    });
    const check = validateOrchestration({ nodes, edges });
    if (!check.ok) {
      return { ok: false, error: `Graph ${gi + 1} (${g.name ?? 'unnamed'}): ${check.error}` };
    }
    out.push({
      name: g.name ?? (graphs.length === 1 ? playbook.name : `${playbook.name}·${gi + 1}`),
      startText: g.startText ?? playbook.startText ?? '',
      nodes,
      edges,
    });
  }
  return { ok: true, orchestrations: out };
}
