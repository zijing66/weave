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

/**
 * 决策模型的 noul 阈值（判断三级链第一档，从 decision-judge 收敛到内核：
 * 两处共用同一组数，改阈值只动这里）。≥YES 认 yes（放行）、≤NO 认 no（真拦截
 * 省 fork）、中间带 = 判不准 → 降级下一档。
 */
export const DECISION_YES_THRESHOLD = 0.7;
export const DECISION_NO_THRESHOLD = 0.3;

export function judgeByNoul(noul: number): 'yes' | 'no' | 'uncertain' {
  if (noul >= DECISION_YES_THRESHOLD) return 'yes';
  if (noul <= DECISION_NO_THRESHOLD) return 'no';
  return 'uncertain';
}

/** when 预筛 / 判断三级链末档的文本匹配：关键词（逗号/换行/分号分隔）任一为文本子串即命中（不区分大小写）。 */
export function matchWhen(when: string, text: string | null): boolean {
  const hay = (text ?? '').toLowerCase();
  return when
    .split(/[,，\n;；]/)
    .map((k) => k.trim().toLowerCase())
    .filter((k) => k.length > 0)
    .some((k) => hay.includes(k));
}

/**
 * 决策模型的**裸通道**（判断三级链第一档）：只问 P(yes)，未配置 / 网络 / 超时 /
 * 坏响应一律 null（不回落、不烧 fork）——回不回落、回落到哪是内核的裁决，
 * 通道只负责把数取回来。与 decision-judge 的 ConditionJudge 包装链（自带回落）
 * 分开：包装链服务单问语义（MCP / RPG 选角），内核批判提合一走这档。
 */
export interface DecisionModelTier {
  ask(input: {
    /** 问题键 → instructions（放行条件的表述）。 */
    questions: Record<string, { type: 'noul'; instructions: string }>;
    /** 判断证据（与边正文同账 32k 的那份）。 */
    upstream: string;
  }): Promise<Record<string, number> | null>;
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
  /** 档三：决策并总结（单边组合 fork）。 */
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
  /**
   * 档三批量：编排引擎的判提合一口——同节点一轮的全部边**一次**出齐判断与提炼。
   * 判断三级链：决策模型（配了裸通道且有证据；强 yes/no 直接出结论、中间带与
   * 失败降级）→ 组合 fork（判断 + 提炼一份 JSON 出，模型已放行的只挂提炼、
   * 模型缺席的判提合一）→ 文本匹配兜底（前三档都不出答案时 matchWhen 认
   * 条件关键词）。`forkGate` = 调用方的 token 预算闸（编排 = ORCH_MAX_FORKS）：
   * 拒绝 = 判断落「预算耗尽」拦下、提炼回落 null，**不走文本兜底**（预算闸是
   * 引擎的硬规则，不是判断不出）。
   */
  evaluateBatch(input: {
    sessionId: string;
    items: EvalBatchItem[];
    upstream: string | null;
    forkGate?: () => boolean;
  }): Promise<Map<string, EvalBatchOutcome>>;
}

/** 批量档的条目：条件（判断）与提炼指令，其一在场即参与。 */
export interface EvalBatchItem {
  key: string;
  condition?: string;
  summarize?: string;
}

/** 批量档的单条落点：判断与提炼同帧出（各自可缺席）。 */
export interface EvalBatchOutcome {
  ok: boolean;
  summary: string | null;
  source: 'decision-model' | 'fork' | 'text';
  reason?: string;
  detail?: string;
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
 * 批量档（evaluateBatch）的档一走裸决策模型（decisionModel），不走自带回落的
 * 判断链——降级裁决收归内核。
 */
export function createDecisionKernel(deps: {
  /** 档一判断链（装配侧 = 决策模型优先 + fork 回落）；缺省 = fork 判断。 */
  conditionJudge?: ConditionJudge;
  /** 批量档档一：决策模型裸通道（不回落、不烧 fork）。 */
  decisionModel?: DecisionModelTier;
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
    async evaluateBatch({ sessionId, items, upstream, forkGate }) {
      const out = new Map<string, EvalBatchOutcome>();
      const judged = new Map<string, string>();
      const briefs = new Map<string, string>();
      for (const item of items) {
        if (item.condition?.trim()) judged.set(item.key, item.condition.trim());
        if (item.summarize?.trim()) briefs.set(item.key, item.summarize.trim());
      }
      // 档一：决策模型快裁——强 yes/no 直接出结论（真拦截连 fork 都不烧），
      // 中间带 / 键缺答 / 通道失败留给组合 fork。模型已拦下的提炼不烧。
      if (upstream && deps.decisionModel && judged.size > 0) {
        const questions: Record<string, { type: 'noul'; instructions: string }> = {};
        for (const [key, cond] of judged) questions[key] = { type: 'noul', instructions: cond };
        let answers: Record<string, number> | null = null;
        try {
          answers = await deps.decisionModel.ask({ questions, upstream });
        } catch {
          answers = null;
        }
        if (answers) {
          for (const [key] of [...judged]) {
            const noul = answers[key];
            if (typeof noul !== 'number' || !Number.isFinite(noul)) continue;
            const verdict = judgeByNoul(noul);
            if (verdict === 'uncertain') continue;
            judged.delete(key);
            if (verdict === 'yes') {
              out.set(key, {
                ok: true,
                summary: null,
                source: 'decision-model',
                detail: `P(yes)=${noul}`,
              });
            } else {
              out.set(key, {
                ok: false,
                summary: null,
                source: 'decision-model',
                reason: 'condition answered no — delivery skipped',
                detail: `P(yes)=${noul}`,
              });
              briefs.delete(key);
            }
          }
        }
      }
      // 档二：组合 fork（双形——判断与提炼各按需进 prompt，一次回合出齐）。
      const settleGated = (): void => {
        for (const key of [...judged.keys()]) {
          out.set(key, {
            ok: false,
            summary: null,
            source: 'fork',
            reason: 'fork budget exhausted — condition not evaluated',
          });
        }
        // 提炼回落 null（outcome 缺席即 null），不走文本兜底——预算闸是引擎硬规则。
        judged.clear();
        briefs.clear();
      };
      const gateTake = (): boolean => !forkGate || forkGate();
      const applyParsed = (
        parsed: { answers: Map<string, boolean>; briefs: Map<string, string> },
      ): void => {
        for (const [key] of [...judged]) {
          const answer = parsed.answers.get(key);
          if (answer === undefined) continue;
          judged.delete(key);
          out.set(key, {
            ok: answer,
            summary: null,
            source: 'fork',
            ...(answer ? {} : { reason: 'condition answered no — delivery skipped' }),
          });
        }
        for (const [key] of [...briefs]) {
          if (out.get(key)?.ok === false) {
            briefs.delete(key);
            continue;
          }
          const text = parsed.briefs.get(key);
          if (text === undefined) continue;
          briefs.delete(key);
          const prev = out.get(key);
          out.set(key, {
            ok: prev?.ok ?? true,
            summary: text,
            source: 'fork',
            ...(prev?.reason ? { reason: prev.reason } : {}),
            ...(prev?.detail ? { detail: prev.detail } : {}),
          });
        }
      };
      if ((judged.size > 0 || briefs.size > 0) && deps.fork.supports(sessionId)) {
        if (!gateTake()) {
          settleGated();
          return out;
        }
        const batchParsed = await runCombined(
          sessionId,
          [...judged].map(([key, cond]) => ({ key, text: cond })),
          [...briefs].map(([key, summ]) => ({ key, text: summ })),
          deps.fork,
        );
        if (batchParsed) {
          applyParsed(batchParsed);
        } else {
          // JSON 坏 → 回落逐边：每边一份单键组合 prompt（各自过预算闸）。条件与
          // 提炼同边的合并成一次单边组合（判提合一不在逐边回落下退化为两 fork）。
          for (const key of new Set([...judged.keys(), ...briefs.keys()])) {
            if (!gateTake()) {
              settleGated();
              return out;
            }
            const singleParsed = await runCombined(
              sessionId,
              judged.has(key) ? [{ key, text: judged.get(key)! }] : [],
              briefs.has(key) ? [{ key, text: briefs.get(key)! }] : [],
              deps.fork,
            );
            if (singleParsed) applyParsed(singleParsed);
          }
        }
      }
      // 档三：文本匹配兜底——前三档都不出答案的条件，关键词命中证据 = 放行。
      if (upstream && judged.size > 0) {
        for (const [key, cond] of judged) {
          const hit = matchWhen(cond, upstream);
          out.set(key, {
            ok: hit,
            summary: null,
            source: 'text',
            ...(hit
              ? { detail: 'text fallback: condition keyword matched upstream' }
              : { reason: 'condition inconclusive (model/fork unavailable or unclear) and no keyword match — delivery blocked' }),
          });
        }
      } else {
        // 无证据可匹配（上游无文本）：判不出的维持「宁可不发错包」。
        for (const [key] of judged) {
          out.set(key, {
            ok: false,
            summary: null,
            source: 'text',
            reason: 'condition inconclusive and no upstream evidence — delivery blocked',
          });
        }
      }
      return out;
    },
  };
}

/**
 * 组合 fork 的执行形状：判断键 + 提炼键各按需进 prompt，一次无头回合出
 * `{answers:{k:bool}, briefs:{k:string}}`（节空则整个省略）。bool 认布尔或
 * yes/no 首词；坏 JSON = null（调用方回落逐边）。
 */
async function runCombined(
  sessionId: string,
  judgments: { key: string; text: string }[],
  briefs: { key: string; text: string }[],
  fork: { extract(input: { sessionId: string; prompt: string }): Promise<string | null> },
): Promise<{ answers: Map<string, boolean>; briefs: Map<string, string> } | null> {
  const sections: string[] = [
    'Based on the conversation context above, complete the tasks below.',
  ];
  if (judgments.length > 0) {
    sections.push(
      `Judgments — decide yes/no for each key:\n${judgments
        .map((j) => `- ${j.key}: ${j.text}`)
        .join('\n')}`,
    );
  }
  if (briefs.length > 0) {
    sections.push(
      `Briefs — produce the requested output for each key:\n${briefs
        .map((b) => `- ${b.key}: ${b.text}`)
        .join('\n')}`,
    );
  }
  const shape = [
    judgments.length > 0
      ? `"answers":{${judgments.map((j) => `"${j.key}":true or false`).join(',')}}`
      : null,
    briefs.length > 0 ? `"briefs":{${briefs.map((b) => `"${b.key}":"..."`).join(',')}}` : null,
  ].filter(Boolean);
  sections.push(
    `Respond with ONLY a JSON object: {${shape.join(',')}}. Omit a section if there is nothing for it. No other text.`,
  );
  const answer = await fork.extract({ sessionId, prompt: sections.join('\n\n') });
  if (!answer) return null;
  const json = answer.match(/\{[\s\S]*\}/);
  if (!json) return null;
  try {
    const value = JSON.parse(json[0]) as {
      answers?: Record<string, unknown>;
      briefs?: Record<string, unknown>;
    };
    const answers = new Map<string, boolean>();
    for (const [key, raw] of Object.entries(value.answers ?? {})) {
      const verdict = typeof raw === 'boolean' ? raw : parseConditionAnswer(String(raw ?? ''));
      if (verdict !== null) answers.set(key, verdict);
    }
    const outs = new Map<string, string>();
    for (const [key, raw] of Object.entries(value.briefs ?? {})) {
      if (typeof raw === 'string' && raw.trim()) outs.set(key, raw.trim());
    }
    return { answers, briefs: outs };
  } catch {
    return null;
  }
}
