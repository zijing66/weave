/**
 * @weave/server — hook ingestion types.
 *
 * The injected project hook script (hook-handler.cjs) is a thin forwarder: it
 * reads the agent's stdin JSON and POSTs a {@link HookReport} to the daemon.
 * The daemon-side HookAdapter normalizes the raw payload into a structured
 * {@link NormalizedHookPayload} before persisting to hook_events.
 */

/** Payload posted by an injected project hook script. */
export interface HookReport {
  source: 'claude' | 'codex';
  eventType: string;
  sessionId?: string | null;
  cwd?: string;
  /** Raw JSON captured from the agent's hook stdin. */
  payload: string;
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
