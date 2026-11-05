/**
 * 决策内核（编排 L2 与扩展点 L1 共同消费的统一入口）：判断 / 提炼 / 决策并总结
 * 三档。内核是组装者，不复制任何一份实现——判断链（决策模型 + fork 回落）与
 * fork 提炼（EdgeExtract）都由装配侧注入；fork 并发与预算闸不在这里（编排的
 * ORCH_MAX_FORKS 留在引擎域，扩展域用独立 fork 池）。
 */

/** 条件边的判断结果：ok = 放行投递；拦下时 reason 记进 RunEvent。source/detail 落日志（谁判的、依据）。 */
export interface ConditionDecision {
  ok: boolean;
  reason?: string;
  /** 谁做的判断：决策模型（Jev）/ fork 子 Agent。缺省 = 未知（旧引擎/测试）。 */
  source?: 'decision-model' | 'fork';
  /** 判断依据（如 `P(yes)=0.85`）；放行与拦下都带，日志可见。 */
  detail?: string;
}

/**
 * 条件边判断引擎：输入上游会话与放行条件，答放行还是拦下。内核只认这个
 * 接口、不关心判断怎么做出来——缺省 = fork 子 Agent（createForkConditionJudge），
 * 装配侧注入决策模型链即整体替换。
 */
export interface ConditionJudge {
  judge(input: {
    sessionId: string;
    condition: string;
    /** 上游这一轮最终输出（`{upstream}` 同源）；无会话上下文的判断方案用它。 */
    upstream: string | null;
  }): Promise<ConditionDecision>;
  /**
   * 批量判定（可选实现）：同一节点同一轮的多条条件边一次判定——fork 型引擎
   * 用它把 N 次 fork 合成 1 次（token 成本 ÷N）。缺省回落逐条 judge；返回
   * 数组与输入同序。抛错 = 整批按逐条回落。
   */
  judgeBatch?(input: {
    sessionId: string;
    /** 每条的判定键（引擎用它对回答案），condition 原文随行。 */
    items: { key: string; condition: string }[];
    upstream: string | null;
  }): Promise<ConditionDecision[]>;
}

/** 条件边回答的认法：子 Agent 回答的首个词（中英都认），其余一律判不出。 */
const CONDITION_YES = new Set(['yes', 'y', 'true', '是', '对的', '对', '需要', '发']);
const CONDITION_NO = new Set(['no', 'n', 'false', '否', '不对', '不需要', '不发']);

export function parseConditionAnswer(answer: string | null | undefined): boolean | null {
  const first = (answer ?? '').trim().toLowerCase().split(/\s+/)[0] ?? '';
  const word = first.replace(/[.。!！?？]/g, '');
  if (CONDITION_YES.has(word)) return true;
  if (CONDITION_NO.has(word)) return false;
  return null;
}

/** 缺省判断引擎：对上游会话 fork 一次上下文子 Agent，只认 yes/no 回答。 */
export function createForkConditionJudge(deps: {
  supports(sessionId: string): boolean;
  extract(input: { sessionId: string; prompt: string }): Promise<string | null>;
}): ConditionJudge {
  const single = (verdict: boolean | null): ConditionDecision =>
    verdict === null
      ? {
          ok: false,
          source: 'fork',
          reason: 'condition could not be evaluated (no clear yes/no answer) — delivery blocked',
        }
      : verdict
        ? { ok: true, source: 'fork' }
        : { ok: false, source: 'fork', reason: 'condition answered no — delivery skipped' };
  return {
    async judge({ sessionId, condition }) {
      if (!deps.supports(sessionId)) {
        return {
          ok: false,
          source: 'fork',
          reason: 'condition not evaluable — harness has no context sub-agent face',
        };
      }
      const answer = await deps.extract({
        sessionId,
        prompt: `${condition}\n\nBased on the conversation context above, answer with exactly one word: yes or no.`,
      });
      return single(parseConditionAnswer(answer));
    },
    // 批量：一次 fork 问全部（JSON 逐键答 yes/no）——N 条条件边的 token 成本 ÷N。
    // fork 自带会话上下文，upstream 只是兜底信号，这里不单独拼进 prompt。
    async judgeBatch({ sessionId, items }) {
      if (!deps.supports(sessionId)) {
        return items.map(() => ({
          ok: false,
          source: 'fork' as const,
          reason: 'condition not evaluable — harness has no context sub-agent face',
        }));
      }
      const lines = items
        .map((item, i) => `${i + 1}. key=${item.key}: ${item.condition}`)
        .join('\n');
      const answer = await deps.extract({
        sessionId,
        prompt: `For EACH item below, decide yes/no based on the conversation context.\n${lines}\n\nRespond with ONLY a JSON object mapping each key to true or false, e.g. {"k1":true,"k2":false}. No other text.`,
      });
      const parsed = parseBatchAnswer(answer, items.map((i) => i.key));
      if (!parsed) return items.map(() => single(null));
      return items.map((item) => {
        const verdict = parsed.get(item.key);
        if (verdict === undefined) return single(null);
        return single(verdict);
      });
    },
  };
}

/** 批量回答解析：首个 JSON 对象里逐键取布尔；缺键/解析失败 = null（整批判不出）。 */
function parseBatchAnswer(
  answer: string | null | undefined,
  keys: readonly string[],
): Map<string, boolean> | null {
  if (!answer) return null;
  const json = answer.match(/\{[\s\S]*\}/);
  if (!json) return null;
  try {
    const value = JSON.parse(json[0]) as Record<string, unknown>;
    const out = new Map<string, boolean>();
    for (const key of keys) {
      const v = value[key];
      if (typeof v !== 'boolean') return null;
      out.set(key, v);
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * 决策内核三档：档一 judge/judgeBatch（既有 ConditionJudge 语义）、档二 extract
 * （既有 EdgeExtract 语义）、档三 evaluate（决策并总结，一次组合 fork）。
 * evaluate 目前暂无生产调用方（编排档一/档二语义不变；扩展点绑定的
 * 「决策并总结」在批 2b 落引擎时才消费此档）。
 */
export interface DecisionKernel {
  /** 档一：纯判断。 */
  judge(input: { sessionId: string; condition: string; upstream: string | null }): Promise<ConditionDecision>;
  /** 档一批量（既有 judgeBatch 语义：同节点多条一次判定，token ÷N）。 */
  judgeBatch?(input: {
    sessionId: string;
    items: { key: string; condition: string }[];
    upstream: string | null;
  }): Promise<ConditionDecision[]>;
  /** 档二：纯提炼（单 fork 无头回合出文本；不支持/失败 = null）。 */
  extract(input: { sessionId: string; prompt: string }): Promise<string | null>;
  /** 档三：决策并总结（新，批 2b 消费）。 */
  evaluate(input: {
    sessionId: string;
    condition?: string;
    summarize?: string;
    upstream: string | null;
  }): Promise<{
    ok: boolean; // 放行与否（无 condition 恒 true）
    summary: string | null; // summarize 的产出（无/失败 = null）
    source: 'decision-model' | 'fork';
    detail?: string; // 谁判的、依据（落执行日志）
  }>;
}

/** 档三组合 fork 的回答形状：一次无头回合同时出判断与总结（token ÷2）。 */
interface CombinedAnswer {
  answer: boolean;
  summary: string | null;
}

/** 组合 fork 回答解析：首个 JSON 对象里取 answer（yes/no 词表或布尔）与 summary。 */
function parseCombinedAnswer(text: string | null | undefined): CombinedAnswer | null {
  if (!text) return null;
  const json = text.match(/\{[\s\S]*\}/);
  if (!json) return null;
  try {
    const value = JSON.parse(json[0]) as { answer?: unknown; summary?: unknown };
    const answer: boolean | null =
      typeof value.answer === 'boolean' ? value.answer : parseConditionAnswer(String(value.answer ?? ''));
    if (answer === null) return null;
    return {
      answer,
      summary: typeof value.summary === 'string' && value.summary.trim() ? value.summary.trim() : null,
    };
  } catch {
    return null;
  }
}

/**
 * 内核组装（纯函数，无类）：判断档缺省 = fork 子 Agent；fork 面（supports +
 * extract）由装配侧注入（server = EdgeExtract 实例），档三也只烧这个面。
 */
export function createDecisionKernel(deps: {
  /** 档一判断链（装配侧 = 决策模型优先 + fork 回落）；缺省 = fork 判断。 */
  conditionJudge?: ConditionJudge;
  /** fork 面：supports=false（无 extractArgs，codex）= 档二/档三回落 null/拦下。 */
  fork: {
    supports(sessionId: string): boolean;
    extract(input: { sessionId: string; prompt: string }): Promise<string | null>;
  };
}): DecisionKernel {
  const forkJudge = createForkConditionJudge(deps.fork);
  const judge = deps.conditionJudge ?? forkJudge;
  // 组合 fork 的提示词：判断与提炼一趟完成；回答收敛成 JSON 逐字段取。
  const combinedPrompt = (condition: string, summarize: string): string =>
    `${condition}\n\n${summarize}\n\nBased on the conversation context above, first decide yes/no on the question, then produce the summary as instructed.\n\nRespond with ONLY a JSON object: {"answer":"yes" or "no","summary":"..."}. No other text.`;
  return {
    judge: (input) => judge.judge(input),
    ...(judge.judgeBatch ? { judgeBatch: judge.judgeBatch.bind(judge) } : {}),
    extract: (input) => deps.fork.extract(input),
    async evaluate({ sessionId, condition, summarize, upstream }) {
      const cond = condition?.trim() || null;
      const summ = summarize?.trim() || null;
      if (cond && summ) {
        // 组合 fork：一次无头回合出 {answer, summary}（token ÷2）；解析失败回落
        // 「先 judge 后 extract」两段式，只多花这一次。
        if (deps.fork.supports(sessionId)) {
          const raw = await deps.fork.extract({
            sessionId,
            prompt: combinedPrompt(cond, summ),
          });
          const parsed = parseCombinedAnswer(raw);
          if (parsed) {
            return {
              ok: parsed.answer,
              summary: parsed.summary,
              source: 'fork',
              detail: parsed.answer ? 'combined fork: yes' : 'combined fork: no — delivery skipped',
            };
          }
        }
        const decision = await forkJudge.judge({ sessionId, condition: cond, upstream });
        if (!decision.ok) {
          return {
            ok: false,
            summary: null,
            source: 'fork',
            ...(decision.reason ? { detail: decision.reason } : {}),
          };
        }
        const summary = await deps.fork.extract({ sessionId, prompt: summ });
        return { ok: true, summary, source: 'fork' };
      }
      if (summ) {
        // 仅 summarize：单 fork 只出 summary，ok 恒 true；fork 面不可用 = null。
        const summary = deps.fork.supports(sessionId)
          ? await deps.fork.extract({ sessionId, prompt: summ })
          : null;
        return { ok: true, summary, source: 'fork' };
      }
      if (cond) {
        // 仅 condition：fork 判断（决策模型优先分支缓做——编排档一语义不变）。
        const decision = await forkJudge.judge({ sessionId, condition: cond, upstream });
        return {
          ok: decision.ok,
          summary: null,
          source: 'fork',
          ...(decision.reason ? { detail: decision.reason } : {}),
          ...(decision.detail ? { detail: decision.detail } : {}),
        };
      }
      return { ok: true, summary: null, source: 'fork' };
    },
  };
}
