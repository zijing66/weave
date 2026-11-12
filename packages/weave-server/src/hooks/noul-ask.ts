import type { DecisionJudgeConfig } from './decision-judge.js';

/**
 * 决策模型（Jev 兼容 / System One）的传输实现单点：`POST {baseUrl}/v1/systemone`
 * 发 noul 问题组（instructions per key）、state = 判断证据，回答 `answers.{key}
 * .noul` = P(yes)。任何失败（网络 / 超时 / 非 2xx / 坏响应 / 空答案）以 null 出，
 * 不抛——裁决与降级是调用方（判断链 / 决策内核）的事。
 */

/** 决策调用上限：一次前向传递理应秒回，超时即回落（fork 自己还有 120s 预算）。 */
export const DECISION_TIMEOUT_MS = 10_000;

export type NoulQuestions = Record<string, { type: 'noul'; instructions: string }>;

export async function askNoulBatch(
  cfg: DecisionJudgeConfig,
  questions: NoulQuestions,
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

/** 一次 noul 判断（单问）；任何失败以 null 出（调用方回落），不抛。 */
export async function askNoul(
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
