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
  return {
    async judge(input): Promise<ConditionDecision> {
      // 上游没有文本可判（决策模型只看得到 state；fork 才有会话上下文）→ 回落。
      const upstream = input.upstream;
      if (!upstream) return deps.fallback.judge(input);
      // 未配置 → 回落（配置每次判断现读，设置页改完即时生效）。
      const cfg = await deps.config();
      if (!cfg) return deps.fallback.judge(input);
      let noul: number | null = null;
      try {
        noul = await askNoul(cfg, input.condition, upstream, deps);
      } catch {
        noul = null;
      }
      if (noul === null) return deps.fallback.judge(input);
      if (noul >= YES_THRESHOLD) return { ok: true };
      if (noul <= NO_THRESHOLD) {
        return { ok: false, reason: `decision model: P(yes)=${noul} — condition answered no` };
      }
      return deps.fallback.judge(input);
    },
  };
}

/** 一次 noul 判断；任何失败以 null 出（调用方回落），不抛。 */
async function askNoul(
  cfg: DecisionJudgeConfig,
  condition: string,
  upstream: string,
  deps: { fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<number | null> {
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
          questions: { proceed: { type: 'noul', instructions: condition } },
        }),
        signal: controller.signal,
      },
    );
    if (!res.ok) return null;
    const parsed = (await res.json()) as { answers?: { proceed?: { noul?: unknown } } };
    const noul = parsed.answers?.proceed?.noul;
    return typeof noul === 'number' && Number.isFinite(noul) ? noul : null;
  } finally {
    clearTimeout(timer);
  }
}
