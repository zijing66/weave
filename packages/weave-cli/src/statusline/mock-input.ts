/**
 * Sample Claude Code statusline stdin payload for the preview TUI.
 *
 * The real script reads this JSON from stdin when Claude Code invokes it; the
 * preview feeds a realistic sample so every segment (model, context, cost,
 * rate, git…) renders. `workspace.current_dir` points at the target project
 * so the project/git/changes segments show live data from that directory, and
 * `transcript_path` points at a generated fixture so the `Total` segment has a
 * real number to sum.
 *
 * Field names mirror the documented Claude Code contract — see
 * packages/weave-server/src/statusline/generator.ts `segmentTokens`.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface StatuslineMockInput {
  session_id: string;
  transcript_path: string;
  model: { display_name: string; id: string };
  workspace: { current_dir: string };
  effort?: { level: string };
  context_window?: {
    used_percentage: number;
    remaining_percentage: number;
    context_window_size: number;
    total_input_tokens: number;
    total_output_tokens: number;
  };
  cost?: { total_cost_usd: number };
  rate_limits?: { five_hour: { used_percentage: number; resets_at: number } };
  terminal: { columns: number };
}

/**
 * Write a throwaway transcript for the preview and return its path.
 *
 * Mirrors two real behaviours the generator depends on: records carry `usage`
 * at `message.usage`, and the same `message.id` repeats once per content block
 * — so the preview exercises the de-duplication rather than a happy path that
 * never occurs in practice.
 *
 * The numbers are chosen to sum to 960_900, i.e. `Total: 960.9k` in the
 * preview — the value shown in the reference layout.
 */
export function writeFixtureTranscript(): string {
  const dir = mkdtempSync(join(tmpdir(), 'weave-sl-mock-'));
  const file = join(dir, 'session.jsonl');
  const record = (id: string, usage: Record<string, number>): string =>
    `${JSON.stringify({ type: 'assistant', uuid: id, message: { id, usage } })}\n`;

  writeFileSync(
    file,
    record('msg_mock_1', {
      input_tokens: 300_000,
      output_tokens: 20_000,
      cache_read_input_tokens: 100_000,
    }) +
      // the same message, written again for its second content block
      record('msg_mock_1', {
        input_tokens: 300_000,
        output_tokens: 20_000,
        cache_read_input_tokens: 100_000,
      }) +
      record('msg_mock_2', {
        input_tokens: 400_000,
        output_tokens: 30_000,
        cache_read_input_tokens: 110_900,
      }),
  );
  return file;
}

export function buildMockInput(projectPath: string, columns = 100, transcriptPath = ''): StatuslineMockInput {
  return {
    session_id: 'mock-session',
    transcript_path: transcriptPath,
    model: { display_name: 'Fable 5', id: 'claude-fable-5' },
    workspace: { current_dir: projectPath },
    effort: { level: 'high' },
    // 42% of a 1M window — self-consistent so `used`/`total`/`percent` agree
    context_window: {
      used_percentage: 42,
      remaining_percentage: 58,
      context_window_size: 1_000_000,
      total_input_tokens: 420_000,
      total_output_tokens: 0,
    },
    cost: { total_cost_usd: 1.234 },
    rate_limits: { five_hour: { used_percentage: 33, resets_at: 0 } },
    terminal: { columns },
  };
}
