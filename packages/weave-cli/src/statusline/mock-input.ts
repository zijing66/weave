/**
 * Sample Claude Code statusline stdin payload for the preview TUI.
 *
 * The real script reads this JSON from stdin when Claude Code invokes it; the
 * preview feeds a realistic sample so every segment (model, context, cost,
 * rate, git…) renders. `workspace.current_dir` points at the target project
 * so the project/git/changes segments show live data from that directory.
 */

export interface StatuslineMockInput {
  model: { display_name: string; id: string };
  workspace: { current_dir: string };
  effort?: { level: string };
  context_window?: { used_percentage: number };
  usage?: { input_tokens: number };
  cost?: { total_cost_usd: number };
  rate_limits?: { five_hour: { used_percentage: number } };
  terminal: { columns: number };
}

export function buildMockInput(projectPath: string, columns = 100): StatuslineMockInput {
  return {
    model: { display_name: 'Fable 5', id: 'claude-fable-5' },
    workspace: { current_dir: projectPath },
    effort: { level: 'high' },
    context_window: { used_percentage: 42 },
    usage: { input_tokens: 87321 },
    cost: { total_cost_usd: 1.234 },
    rate_limits: { five_hour: { used_percentage: 33 } },
    terminal: { columns },
  };
}
