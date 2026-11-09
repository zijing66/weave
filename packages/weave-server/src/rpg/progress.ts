/**
 * RPG-3 成长派生（RPG 稿 §5.3.2 + weaveRPG.md 第四章）：XP / 等级 / 境界 / 成就 /
 * 六维实战修正——**读侧纯函数 + 派生面**。素材全来自既有事实（orchestration_runs、
 * hook_events、rpg_growth），派生只读不写；解锁事实落 rpg_achievements /
 * rpg_xp（行动态快照，语义 = 记录、非业务裁决）。
 *
 * 数值全为初版占位（RPG 稿明言「跑起来后按真实分布调参」），常量集中在
 * RPG_PROGRESS_TUNING 一处——RPG-4 调参单点。协作 XP（RPG 稿 11.1#3 数据源
 * 未探明）**留位不做**：breakdown 预留 collaboration 键恒 0。
 */

import { HARNESS_LIFECYCLE } from '@weavecode/core';

// ---- 调参单点（RPG-4）----

export const RPG_PROGRESS_TUNING = {
  /** 任务完成：run done = 100 × playbook 难度标注（RPG 稿 §5.3.2；难度缺省 5）。 */
  xpPerQuest: 100,
  /** 难度缺省（playbook zod 同值——runs 不带难度时按它算）。 */
  defaultDifficulty: 5,
  /** 有效回合：每回合 2（weaveRPG.md §四）。 */
  xpPerTurn: 2,
  /** 首次修炼：每 skill 10（同上；重复修炼不加——首修事实在 rpg_growth）。 */
  xpPerCultivation: 10,
  /** 协作：留位（11.1#3 数据源未探明，探明后在此加权重）。 */
  xpPerCollaboration: 0,
  /** 等级阈值 = 100 × level²（累计 XP；L1→100、L2→400、L3→900）。 */
  levelBaseXp: 100,
  /** 六维实战修正单点：每单位素材加多少维（RPG 稿 §5.3.2；占位小数、快照取整）。 */
  hexWeights: {
    运气: 0.5, // 回合成功率（成功收尾占比）
    敏捷: 0.3, // 响应时长（开轮→收尾间隔的倒数分档）
    力量: 0.05, // 改动量（Edit/Write 调用行数近似）
    智慧: 0.4, // 决策参与（问答面作答次数）
    内力: 0.2, // 上下文利用（工具调用轮占比）
    速度: 0.4, // 吞吐（有效回合数）
  },
  /** 六维修正封顶（快照维度值上限——基线 18 点 + 修正，别让雷达爆表）。 */
  hexCap: 20,
} as const;

// ---- XP / 等级 / 境界 ----

export interface XpBreakdown {
  quest: number;
  turns: number;
  cultivation: number;
  /** 留位：协作 XP（11.1#3 数据源未探明；探明前恒 0）。 */
  collaboration: number;
}

export function emptyBreakdown(): XpBreakdown {
  return { quest: 0, turns: 0, cultivation: 0, collaboration: 0 };
}

export function xpTotalOf(b: XpBreakdown): number {
  return b.quest + b.turns + b.cultivation + b.collaboration;
}

/** 达到该累计 XP 所需的等级（阈值 = 100×level²，累计口径：level² × 100）。 */
export function levelOf(totalXp: number): number {
  if (totalXp <= 0) return 0;
  // 累计阈值：L1=100、L2=400（=100+300）？——稿文「达到该等级所需的累计 XP：1 级
  // 100、2 级 400、3 级 900」即阈值直接是 level²×100，不是逐级累加。取满足
  // totalXp ≥ 100×L² 的最大 L。
  let level = 0;
  while (RPG_PROGRESS_TUNING.levelBaseXp * (level + 1) ** 2 <= totalXp) level++;
  return level;
}

/** 升到下一级还差多少 XP（已满级无上限——level 无封顶）。 */
export function xpToNextLevel(totalXp: number): { level: number; nextAt: number; remaining: number } {
  const level = levelOf(totalXp);
  const nextAt = RPG_PROGRESS_TUNING.levelBaseXp * (level + 1) ** 2;
  return { level, nextAt, remaining: nextAt - totalXp };
}

/** 境界名表（weaveRPG.md 第四章；区间 = 等级，右闭）。 */
export const REALM_TABLE: ReadonlyArray<{ max: number; name: string }> = [
  { max: 2, name: '初入山门' },
  { max: 4, name: '淬体' },
  { max: 7, name: '凝气' },
  { max: 11, name: '筑基' },
  { max: 16, name: '金丹' },
  { max: 22, name: '元婴' },
  { max: 30, name: '化神' },
  { max: Number.POSITIVE_INFINITY, name: '登峰' },
];

export function realmOf(level: number): string {
  for (const row of REALM_TABLE) if (level <= row.max) return row.name;
  return REALM_TABLE[REALM_TABLE.length - 1]!.name;
}

// ---- XP 素材统计（hook_events / runs 派生）----

/** 编排 run 完成事实的最小形状（调用方给 runs 派生面）。 */
export interface QuestFact {
  projectId: number;
  status: string;
  /** playbook 难度标注（orchestrations 侧未持久化——由调用方按名字映射或缺省）。 */
  difficulty: number;
}

/** 任务完成 XP：只认 done 的 run；难度标注随调用方给。 */
export function questXpOf(runs: readonly QuestFact[], tuning: typeof RPG_PROGRESS_TUNING = RPG_PROGRESS_TUNING): number {
  let xp = 0;
  for (const r of runs) if (r.status === 'done') xp += tuning.xpPerQuest * Math.max(1, r.difficulty);
  return xp;
}

/** 归一化 hook 事件（与 HookEventRow 结构兼容的最小形状）。 */
export interface ProgressEventRow {
  eventType: string;
  sessionId: string | null;
  payload: string;
  projectId: number;
}

/**
 * 有效回合 = 每个「收尾」事件算一回合（open/close 生命周期能力表口径；StopFailure /
 * TurnAborted 也是一次真实交锋——失败也花力气）。排除纯等待：无收尾的 open 不计。
 */
export function effectiveTurnCount(events: readonly ProgressEventRow[]): number {
  const closeTypes = new Set<string>();
  for (const l of Object.values(HARNESS_LIFECYCLE)) for (const t of l.close) closeTypes.add(t);
  let n = 0;
  for (const e of events) if (e.sessionId && closeTypes.has(e.eventType)) n++;
  return n;
}

/** 首次修炼数：rpg_growth 里 verb=cultivate 的行数（修炼面已只记成功安装）。 */
export function firstCultivationCount(
  growth: ReadonlyArray<{ verb: string; target: string }>,
): number {
  const seen = new Set<string>();
  for (const g of growth) if (g.verb === 'cultivate') seen.add(g.target);
  return seen.size;
}

/** XP 派生汇总（素材已由调用方从库面收齐）。 */
export function xpBreakdownOf(input: {
  runs: readonly QuestFact[];
  events: readonly ProgressEventRow[];
  growth: ReadonlyArray<{ verb: string; target: string }>;
}): XpBreakdown {
  const t = RPG_PROGRESS_TUNING;
  return {
    quest: questXpOf(input.runs),
    turns: effectiveTurnCount(input.events) * t.xpPerTurn,
    cultivation: firstCultivationCount(input.growth) * t.xpPerCultivation,
    collaboration: 0,
  };
}

// ---- 成就（weaveRPG.md 第四章 13 条；键 = 封闭词表）----

export const ACHIEVEMENT_KEYS = [
  'firstKill',
  'fullManaCast',
  'sevenArmy',
  'firstCultivation',
  'weaponClaimed',
  'lightSaber',
  'fineForge',
  'commonSteel',
  'hundredTurns',
  'winStreak',
  'reviewMaster',
  'allArchived',
  'iterationCraft',
] as const;
export type AchievementKey = (typeof ACHIEVEMENT_KEYS)[number];

export interface AchievementDef {
  key: AchievementKey;
  /** 触发口径（weaveRPG.md 成就表「触发口径」列的机器可判形）。 */
  describe: string;
  /** 判定：素材 → 是否解锁。 */
  test: (m: AchievementMaterial) => boolean;
}

/** 成就判定的素材面（派生面从库面收齐后传入；数字缺省 0、布尔缺省 false）。 */
export interface AchievementMaterial {
  /** 任务完成数（run done）。 */
  questsDone: number;
  /** 连胜：当前尾部连续 done 的 run 数（中间无 failed）。 */
  winStreak: number;
  /** 有效回合数。 */
  turns: number;
  /** 首修 skill 数（去重 target）。 */
  cultivations: number;
  /** 满内力施法：某会话上下文占用接近满格时仍完成过一次有效回合。 */
  fullManaCast: boolean;
  /** 同时活跃（running/compacting）的化身数峰值（当拍快照——素材面给当前值）。 */
  activeAvatars: number;
  /** 首次识别出模型武器品阶（出现过任何可归档的模型档位）。 */
  weaponSeen: boolean;
  /** 用 opus/sonnet/haiku 档模型完成任务（Stop 收尾时最近一次模型照会归档）。 */
  opusDone: boolean;
  sonnetDone: boolean;
  haikuDone: boolean;
  /** 批阅战报次数（review 落点：计划批准 = ExitPlanMode 批准回合，占位口径）。 */
  reviews: number;
  /** 已全部归档/离场：存在收尾会话且没有非终态会话（素材面给布尔）。 */
  allArchived: boolean;
  /** 迭代任务完成数（orchestration 名带「迭代」或 playbook kind=迭代——名字近似）。 */
  iterationsDone: number;
}

/** 13 条成就判定表（键序 = 词表序；weaveRPG.md 第四章）。 */
export const ACHIEVEMENT_DEFS: ReadonlyArray<AchievementDef> = [
  { key: 'firstKill', describe: '首个任务成功完成', test: (m) => m.questsDone >= 1 },
  { key: 'fullManaCast', describe: '满格上下文仍完成一次有效回合', test: (m) => m.fullManaCast },
  { key: 'sevenArmy', describe: '同时存在 7 个活跃化身', test: (m) => m.activeAvatars >= 7 },
  { key: 'firstCultivation', describe: '首次成功安装 skill', test: (m) => m.cultivations >= 1 },
  { key: 'weaponClaimed', describe: '首次识别出模型武器品阶', test: (m) => m.weaponSeen },
  { key: 'lightSaber', describe: '使用 opus 模型完成一次任务', test: (m) => m.opusDone },
  { key: 'fineForge', describe: '使用 sonnet 模型完成一次任务', test: (m) => m.sonnetDone },
  { key: 'commonSteel', describe: '使用 haiku 模型完成一次任务', test: (m) => m.haikuDone },
  { key: 'hundredTurns', describe: '累计 100 个有效回合', test: (m) => m.turns >= 100 },
  { key: 'winStreak', describe: '连续完成 5 个任务且中间无失败', test: (m) => m.winStreak >= 5 },
  { key: 'reviewMaster', describe: '完成 10 次批阅战报', test: (m) => m.reviews >= 10 },
  { key: 'allArchived', describe: '所有已结束会话均已归档或离场', test: (m) => m.allArchived },
  { key: 'iterationCraft', describe: '完成 10 次迭代任务', test: (m) => m.iterationsDone >= 10 },
];

/** 对素材跑全表，返回本次解锁的键集（调用方与已解锁集求差落库）。 */
export function achievementsOf(m: AchievementMaterial): AchievementKey[] {
  return ACHIEVEMENT_DEFS.filter((d) => d.test(m)).map((d) => d.key);
}

/** 连胜：按 id 序看尾部连续 done（遇 failed 清零，cancelled/interrupted 不断链）。 */
export function winStreakOf(runs: readonly { status: string; id: number }[]): number {
  const ordered = [...runs].sort((a, b) => a.id - b.id);
  let streak = 0;
  for (const r of ordered) {
    if (r.status === 'done') streak++;
    else if (r.status === 'failed') streak = 0;
  }
  return streak;
}

// ---- 六维实战修正（RPG 稿 §5.3.2；素材全派生自 hook_events）----

export type HexBonus = Record<string, number>;

export interface HexMaterial {
  /** 有效回合数（→ 速度）。 */
  turns: number;
  /** 收尾成功数 / 收尾总数（→ 运气；无收尾 = 0）。 */
  closeOk: number;
  closeTotal: number;
  /** 平均开轮→收尾间隔秒（→ 敏捷；快 = 加成高）。 */
  avgTurnSeconds: number | null;
  /** Edit/Write 类工具调用的近似改动行数（→ 力量）。 */
  changeLines: number;
  /** 问答面作答次数（→ 智慧）。 */
  decisions: number;
  /** 工具调用轮数 / 回合数（→ 内力；上下文利用率近似）。 */
  toolTurns: number;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/**
 * 实战修正分（未叠加基线的纯修正量，保留两位小数）。素材缺省 = 全 0 修正
 * （无数据的角色雷达仍能只画基线）。
 */
export function hexBonusOf(m: HexMaterial, tuning: typeof RPG_PROGRESS_TUNING = RPG_PROGRESS_TUNING): HexBonus {
  const w = tuning.hexWeights;
  const successRate = m.closeTotal > 0 ? m.closeOk / m.closeTotal : 0;
  // 响应时长：30s 内算满速、10 分钟以上不加分（线性衰减，占位）。
  const agility = m.avgTurnSeconds == null ? 0 : clamp(1 - m.avgTurnSeconds / 600, 0, 1);
  // 上下文利用：工具调用轮占比（真实干活 = 有工具足迹）。
  const mana = m.turns > 0 ? clamp(m.toolTurns / m.turns, 0, 1) : 0;
  return {
    运气: round2(successRate * w.运气),
    敏捷: round2(agility * w.敏捷),
    力量: round2(clamp(m.changeLines * w.力量, 0, w.力量 * 100) / 1),
    智慧: round2(clamp(m.decisions * w.智慧, 0, w.智慧 * 10)),
    内力: round2(mana * w.内力),
    速度: round2(clamp(m.turns * w.速度, 0, w.速度 * 20)),
  };
}

/** 基线 + Σ 加成 + 修正 → 最终六维（封顶 hexCap，取整到 0.1）。 */
export function hexagonFinalOf(baseline: Record<string, number>, bonus: HexBonus): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [dim, base] of Object.entries(baseline)) {
    out[dim] = round1(Math.min(RPG_PROGRESS_TUNING.hexCap, base + (bonus[dim] ?? 0)));
  }
  return out;
}

const round2 = (v: number): number => Math.round(v * 100) / 100;
const round1 = (v: number): number => Math.round(v * 10) / 10;

// ---- 素材收拢（事件行 → AchievementMaterial / HexMaterial 的中间派生）----

/** 模型真名 → 武器品阶档（claude 别名词表口径；网关前缀已由归一化剥过的裸名判）。 */
export function modelTierOf(model: string | null | undefined): 'opus' | 'sonnet' | 'haiku' | null {
  if (!model) return null;
  const m = model.toLowerCase();
  if (m.includes('opus')) return 'opus';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('haiku')) return 'haiku';
  return null;
}

/** 武器品阶档 → 成就素材三布尔（opus/sonnet/haiku 各一）。 */
export function weaponFlagsOf(modelsDone: ReadonlyArray<string | null>): Pick<
  AchievementMaterial,
  'weaponSeen' | 'opusDone' | 'sonnetDone' | 'haikuDone'
> {
  const tiers = new Set(modelsDone.map(modelTierOf).filter((t): t is NonNullable<typeof t> => t != null));
  return {
    weaponSeen: tiers.size > 0,
    opusDone: tiers.has('opus'),
    sonnetDone: tiers.has('sonnet'),
    haikuDone: tiers.has('haiku'),
  };
}

/** 满内力判据（占位）：会话上下文 token ≥ 150k 视为「接近满格」（展示上限前）。 */
export const FULL_MANA_TOKENS = 150_000;

/** 从一组（最近照会模型, 上下文 token）事实里提「武器/满内力」素材。 */
export function sessionFactsMaterial(
  facts: ReadonlyArray<{ model: string | null; contextTokens: number | null; closed: boolean }>,
): { modelsDone: Array<string | null>; fullManaCast: boolean } {
  const modelsDone: Array<string | null> = [];
  let fullManaCast = false;
  for (const f of facts) {
    if (f.closed && f.model) modelsDone.push(f.model);
    if (f.closed && (f.contextTokens ?? 0) >= FULL_MANA_TOKENS) fullManaCast = true;
  }
  return { modelsDone, fullManaCast };
}
