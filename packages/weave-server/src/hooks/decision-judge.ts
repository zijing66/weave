import type { ConditionDecision, ConditionJudge } from './orchestration-engine.js';

/**
 * 编排条件边的决策模型判断（Jev 兼容 / System One 接口）：`POST {baseUrl}/v1/systemone`
 * 发一个 noul 问题（instructions = 边的放行条件、state = 上游这一轮输出），回答
 * `noul` = P(yes)。阈值按 TypeSafe 文档推荐起点：≥0.7 放行、≤0.3 拦下、中间带
 * （判不准）与一切失败（未配置/无上游文本/网络/超时/坏响应）都回落 fork 子 Agent
 * ——System 1 拿不准的交给 System 2，两层都拦下才拦下。
 */

/** ≥此值认 yes（放行）。 */
const YES_THRESHOLD = 0.7;
/** ≤此值认 no（拦下）。 */
const NO_THRESHOLD = 0.3;
/** 决策调用上限：一次前向传递理应秒回，超时即回落（fork 自己还有 120s 预算）。 */
const DECISION_TIMEOUT_MS = 10_000;

export interface DecisionJudgeConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
}

export function createDecisionConditionJudge(deps: {
  /** 每次判断现读（settings 表 + key 文件）——改配置即时生效，不用重启 daemon。 */
  config: () => Promise<DecisionJudgeConfig | null>;
  /** 回落判断（装配侧 = fork 子 Agent）。 */
  fallback: ConditionJudge;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): ConditionJudge {
  const tag = (
    decision: ConditionDecision,
    noul: number | null,
  ): ConditionDecision => ({
    ...decision,
    source: 'decision-model',
    ...(noul !== null ? { detail: `P(yes)=${noul}` } : {}),
  });
  const byThreshold = (noul: number): ConditionDecision => {
    if (noul >= YES_THRESHOLD) return tag({ ok: true }, noul);
    if (noul <= NO_THRESHOLD) {
      return tag(
        { ok: false, reason: `condition answered no` },
        noul,
      );
    }
    return { ok: false }; // 中间带——调用方回落 fork
  };
  return {
    async judge(input): Promise<ConditionDecision> {
      // 上游没有文本可判（决策模型只看得到 state；fork 才有会话上下文）→ 回落。
      const upstream = input.upstream;
      if (!upstream) {
        return { ...(await deps.fallback.judge(input)), source: 'fork' };
      }
      // 未配置 → 回落（配置每次判断现读，设置页改完即时生效）。
      const cfg = await deps.config();
      if (!cfg) return { ...(await deps.fallback.judge(input)), source: 'fork' };
      let noul: number | null = null;
      try {
        noul = await askNoul(cfg, input.condition, upstream, deps);
      } catch {
        noul = null;
      }
      if (noul === null) {
        return { ...(await deps.fallback.judge(input)), source: 'fork' };
      }
      const decision = byThreshold(noul);
      if (!decision.ok && decision.source !== 'decision-model') {
        // 中间带：回落 fork（结果标 fork 来源）。
        return { ...(await deps.fallback.judge(input)), source: 'fork' };
      }
      return decision;
    },
    // 批量：一次 noul 调用答全部（questions 按边 key 展开）——N 条边的请求 ÷1。
    // 结构性失败回落逐条 judge（决策模型判不出的键再回落 fork）。
    async judgeBatch(input) {
      if (!input.upstream) {
        return Promise.all(
          input.items.map(async (item) => ({
            ...(await deps.fallback.judge({
              sessionId: input.sessionId,
              condition: item.condition,
              upstream: null,
            })),
            source: 'fork' as const,
          })),
        );
      }
      const cfg = await deps.config();
      if (!cfg) {
        return Promise.all(
          input.items.map(async (item) => ({
            ...(await deps.fallback.judge({
              sessionId: input.sessionId,
              condition: item.condition,
              upstream: input.upstream,
            })),
            source: 'fork' as const,
          })),
        );
      }
      const questions: Record<string, { type: 'noul'; instructions: string }> = {};
      for (const item of input.items) {
        questions[item.key] = { type: 'noul', instructions: item.condition };
      }
      let answers: Record<string, number> | null = null;
      try {
        answers = await askNoulBatch(cfg, questions, input.upstream, deps);
      } catch {
        answers = null;
      }
      if (!answers) {
        // 整批结构失败 → 回落逐条 judge（内部再各自回落 fork）。
        return Promise.all(
          input.items.map(async (item) => ({
            ...(await this.judge({
              sessionId: input.sessionId,
              condition: item.condition,
              upstream: input.upstream,
            })),
          })),
        );
      }
      return Promise.all(
        input.items.map(async (item) => {
          const noul = answers![item.key];
          if (typeof noul !== 'number' || !Number.isFinite(noul)) {
            // 这一键判不出 → 该键回落 fork。
            return {
              ...(await deps.fallback.judge({
                sessionId: input.sessionId,
                condition: item.condition,
                upstream: input.upstream,
              })),
              source: 'fork' as const,
            };
          }
          return byThreshold(noul);
        }),
      );
    },
  };
}

/** 一次 noul 判断（单问）；任何失败以 null 出（调用方回落），不抛。 */
async function askNoul(
  cfg: DecisionJudgeConfig,
  instructions: string,
  upstream: string,
  deps: { fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<number | null> {
  const answers = await askNoulBatch(
    cfg,
    { proceed: { type: 'noul', instructions } },
    upstream,
    deps,
  );
  return answers?.proceed ?? null;
}

/** 一次 noul 判断（多问，questions 按键展开）；任何失败以 null 出，不抛。 */
async function askNoulBatch(
  cfg: DecisionJudgeConfig,
  questions: Record<string, { type: 'noul'; instructions: string }>,
  upstream: string,
  deps: { fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<Record<string, number> | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? DECISION_TIMEOUT_MS);
  try {
    const res = await (deps.fetchImpl ?? fetch)(
      `${cfg.baseUrl.replace(/\/+$/, '')}/v1/systemone`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: cfg.model,
          state: upstream,
          questions,
        }),
        signal: controller.signal,
      },
    );
    if (!res.ok) return null;
    const parsed = (await res.json()) as {
      answers?: Record<string, { noul?: unknown }>;
    };
    const raw = parsed.answers;
    if (!raw || typeof raw !== 'object') return null;
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(raw)) {
      const noul = (value as { noul?: unknown })?.noul;
      if (typeof noul === 'number' && Number.isFinite(noul)) out[key] = noul;
    }
    return Object.keys(out).length > 0 ? out : null;
  } finally {
    clearTimeout(timer);
  }
}
