import { useCallback, useEffect, useRef, useState } from 'react';
import { useToast } from '../components/Toast';
import {
  SUCCESS_HOLD_MS,
  reduceActionState,
  type ActionState,
} from './feedback-core';

/**
 * 按钮反馈三态：idle → loading → success（保持 2s）→ idle。
 * 失败直接回 idle——失败信息走 toast，不在按钮上停留（避免"❌ 挂在按钮上"）。
 * 状态机与停留时长在 `lib/feedback-core.ts`（纯逻辑，可单测）。
 */

export { SUCCESS_HOLD_MS, reduceActionState };
export type { ActionState };

export interface RunOptions {
  /** 失败文案（必填：每个动作自己说清怎么报错，hook 不做通用兜底）。 */
  fail: (error: unknown) => string;
}

export interface ActionFeedback {
  /** 某个 key 的当前状态（未开始 = idle）。 */
  stateOf: (key: string) => ActionState;
  /** 跑一个动作并驱动它的反馈状态；失败时按 `fail` 报错到 toast。 */
  run: (key: string, action: () => Promise<void>, options: RunOptions) => Promise<void>;
}

export function useActionFeedback(): ActionFeedback {
  const [states, setStates] = useState<Record<string, ActionState>>({});
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const { show } = useToast();

  const set = useCallback((key: string, event: 'start' | 'ok' | 'fail') => {
    setStates((prev) => ({
      ...prev,
      [key]: reduceActionState(prev[key] ?? 'idle', event),
    }));
  }, []);

  useEffect(
    () => () => {
      for (const timer of Object.values(timers.current)) clearTimeout(timer);
    },
    [],
  );

  const run = useCallback(
    async (key: string, action: () => Promise<void>, options: RunOptions): Promise<void> => {
      set(key, 'start');
      try {
        await action();
        set(key, 'ok');
        clearTimeout(timers.current[key]);
        timers.current[key] = setTimeout(() => {
          setStates((prev) => ({ ...prev, [key]: 'idle' }));
        }, SUCCESS_HOLD_MS);
      } catch (error) {
        set(key, 'fail');
        show('error', options.fail(error));
      }
    },
    [set, show],
  );

  const stateOf = useCallback((key: string) => states[key] ?? 'idle', [states]);

  return { stateOf, run };
}

/** 报错文案里嵌错误摘要用（未知错误统一成字符串）。 */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
