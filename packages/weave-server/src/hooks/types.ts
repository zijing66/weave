/**
 * @weavecode/server — hook ingestion types.
 *
 * The injected project hook script (hook-handler.cjs) is a thin forwarder: it
 * reads the agent's stdin JSON and POSTs a {@link HookReport} to the daemon.
 * The daemon-side HookAdapter normalizes the raw payload into a structured
 * {@link NormalizedHookPayload} before persisting to hook_events.
 */

import type { Harness } from '@weavecode/core';

/** Payload posted by an injected project hook script. */
export interface HookReport {
  source: Harness;
  eventType: string;
  sessionId?: string | null;
  cwd?: string;
  /** Raw JSON captured from the agent's hook stdin. */
  payload: string;
  /** 改名交付回执：本事件随 hook 响应实际下发的 sessionTitle（未下发 = null）。
   *  daemon 据此落定 pending_title——徽标在生效当拍清除，不待下一次上报。 */
  deliveredTitle?: string | null;
}

/**
 * Structured, source-agnostic representation of a hook event, serialized into
 * `hook_events.payload`. Extracted by a HookAdapter from the raw agent payload.
 */
export interface NormalizedHookPayload {
  eventType: string;
  toolName: string | null;
  toolInput: unknown;
  toolResponse: unknown;
  cwd: string | null;
  transcriptPath: string | null;
  /** The original raw payload, preserved for debugging/forward-compat. */
  raw: unknown;
}
