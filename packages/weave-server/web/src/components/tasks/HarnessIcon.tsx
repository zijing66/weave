import { Asterisk, Hexagon, Loader2 } from 'lucide-react';

/**
 * 会话行前的 harness 执行动效图标：claude = 星芒匀速旋转（辉光），codex =
 * 六边形脉动缩放旋转——各 harness 一套跑马灯动效（index.css harness-run-*）。
 * harness 未知时回退通用 spinner；非执行态由调用方渲染状态点。
 */
export function HarnessIcon({
  harness,
  running,
}: {
  harness?: 'claude' | 'codex' | null;
  running: boolean;
}) {
  if (!running) return null;
  if (harness === 'codex') {
    return (
      <span className="harness-run-codex inline-flex shrink-0">
        <Hexagon className="h-3.5 w-3.5 text-cyan-400" />
      </span>
    );
  }
  if (harness === 'claude') {
    return (
      <span className="harness-run-claude inline-flex shrink-0">
        <Asterisk className="h-3.5 w-3.5 text-orange-400" />
      </span>
    );
  }
  return <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-orange-400" />;
}
