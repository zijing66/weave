import { useEffect, useMemo, useState } from 'react';
import { useT } from '@/i18n/I18nProvider';
import type { RpgData } from './use-rpg-data';
import { contextWindowOf } from '@/components/tasks/use-session-controls';
import { latestSessionOf } from './hud-derive';
import type { RpgRoleView } from '@/lib/api';

/**
 * RimWorld 三件套 HUD（G2.5，设计 §九「全屏世界 + overlay HUD」）：全部是普通
 * DOM overlay（G4 引擎裁决不破——不引 canvas）。**生存条是信号面不是新账**：
 * 每格标真实数据源，派生不出的格不摆（不摆空壳铁律）——
 * - 头顶状态条：绿 = 体力（token 预算余量：sessionRow.contextTokens / 模型窗口，
 *   `contextWindowOf` 同一档位表）/ 黄 = 进度（回合开着时长，lastSeenAt 近似——
 *   回合开着的会话才摆）/ 红 = 健康（该角色项目下 failed run 数，近 50 条账内）。
 * - 顶部警报带：挂起待答（questions）+ 失败 run，按红黄排序；无警报整条不出现。
 * - 底部选中详情条：点 sprite 展开（RoleProgressPanel 内容 + 最近回合 + 在跑 run）。
 * - 时钟位：右上角事件速率 + 在跑会话数（dashboard rate 缓存，读不到不摆）。
 */

export interface HeadBars {
  /** 0-1；null = 派生不出（不摆该格）。 */
  hp: number | null;
  progress: number | null;
  health: number | null;
}

/**
 * 角色头顶三格信号（纯派生，零新账）：
 * - 绿（体力）= token 预算余量：1 - contextTokens/窗口；contextTokens null 不摆。
 * - 黄（进度）= 回合开着时长热度：turnOpen 会话 lastSeenAt 越久热度越高
 *   （2 分钟内 = 0..1 线性）；不在跑 = 不摆（回合收了进度就清零，无进展拍数
 *   归 G6 循环检测信号，本波不摆）。
 * - 红（健康）= failed run 计数热度：min(1, 失败数/5)；零失败不摆。
 */
export function headBarsOf(
  role: RpgRoleView,
  data: Pick<RpgData, 'sessionById' | 'statuses' | 'runs'>,
  now: number,
): HeadBars {
  const row = latestSessionOf(role.projectId, data.sessionById);
  const hp =
    row?.contextTokens != null && Number.isFinite(row.contextTokens) && row.contextTokens > 0
      ? Math.max(0, Math.min(1, 1 - row.contextTokens / contextWindowOf(row.model)))
      : null;
  const status = row ? (data.statuses.get(row.sessionId) ?? 'open') : 'open';
  const turnAge = row ? now - Date.parse(row.lastSeenAt) : Infinity;
  const progress =
    status === 'running' || status === 'compacting'
      ? Math.max(0.15, Math.min(1, turnAge / 120_000))
      : null;
  const failed = (data.runs ?? []).filter((r) => r.status === 'failed').length;
  const health = failed > 0 ? Math.min(1, failed / 5) : null;
  return { hp, progress, health };
}

/** 头顶状态条（sprite 头上 2-3px 细条，叠三格：绿/黄/红；缺格不摆）。 */
export function SpriteHeadBars({ bars }: { bars: HeadBars }) {
  const segs: Array<[string, number]> = [];
  if (bars.hp != null) segs.push(['#3fbf5f', bars.hp]);
  if (bars.progress != null) segs.push(['#d9a441', bars.progress]);
  if (bars.health != null) segs.push(['#c9566e', bars.health]);
  if (segs.length === 0) return null;
  return (
    <div
      className="pointer-events-none absolute -top-1 left-0 flex w-full gap-px"
      style={{ height: 3 }}
      aria-hidden
    >
      {segs.map(([color, v], i) => (
        <div key={i} className="flex-1" style={{ background: color, opacity: 0.9 }}>
          <div style={{ width: `${Math.round(v * 100)}%`, height: '100%', background: color }} />
        </div>
      ))}
    </div>
  );
}

/* ---- ② 顶部警报带 ---- */

export interface RpgAlert {
  key: string;
  severity: 'red' | 'yellow';
  label: string;
  /** 点击动作（面板展开/跳转，由调用方接）。 */
  onOpen?: () => void;
}

/** 警报派生（纯函数）：挂起待答 = 红、失败 run = 红（有 error）/黄；按红先黄后。 */
export function alertsOf(
  data: Pick<RpgData, 'questions' | 'runs' | 'sessionById'>,
): RpgAlert[] {
  const out: RpgAlert[] = [];
  for (const [sessionId] of data.questions) {
    const title = data.sessionById.get(sessionId)?.title ?? sessionId.slice(0, 8);
    out.push({
      key: `q-${sessionId}`,
      severity: 'red',
      label: title,
    });
  }
  for (const r of data.runs ?? []) {
    if (r.status !== 'failed') continue;
    out.push({
      key: `run-${r.id}`,
      severity: r.error ? 'red' : 'yellow',
      label: `#${r.id} ${r.orchestrationName}`,
    });
  }
  return out.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'red' ? -1 : 1));
}

/** 顶部警报带：有警报才出现（整条横贯顶部，红黄排）；点击跳对应会话/复盘面板。 */
export function AlertStrip({ data }: { data: RpgData }) {
  const t = useT();
  const alerts = useMemo(() => alertsOf(data), [data]);
  if (alerts.length === 0) return null;
  return (
    <div className="rpg-hud-anchor pointer-events-none absolute inset-x-0 top-0 z-20 flex justify-center">
      <div className="pointer-events-auto mt-1 flex max-w-[92%] flex-wrap items-center justify-center gap-1 rounded-b border border-t-0 border-[var(--w-border)] bg-[var(--w-surface-1)]/90 px-2 py-1 backdrop-blur-sm">
        <span className="text-[10px] uppercase tracking-wide text-[var(--w-text-dim)]">
          {t('rpg.alertTitle')}
        </span>
        {alerts.map((a) => (
          <span
            key={a.key}
            title={a.label}
            className={
              'max-w-56 cursor-pointer truncate rounded px-1.5 py-0.5 text-[11px] ' +
              (a.severity === 'red'
                ? 'bg-[#c9566e]/25 text-[#e58ca0]'
                : 'bg-[#d9a441]/20 text-[#e0b768]')
            }
          >
            {a.severity === 'red' ? '●' : '▲'} {a.label}
          </span>
        ))}
      </div>
    </div>
  );
}

/* ---- ③ 底部选中详情条 ---- */

/** 底部选中详情条（点 sprite 展开、点空处收起）：RoleProgressPanel + 最近回合。
 *  `roleId` 供调用方判哪位被选中（本壳只负责表面）。 */
export function SelectionDetailBar({
  roleId: _roleId,
  onClose,
  children,
}: {
  roleId: number;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const t = useT();
  return (
    <div className="rpg-overlay-surface absolute inset-x-0 bottom-0 z-20 max-h-[55%] overflow-auto border-t border-[var(--w-border)] p-3 shadow-xl">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs uppercase tracking-wide text-[var(--w-text-dim)]">
          {t('rpg.roleProgress')}
        </span>
        <button
          type="button"
          onClick={onClose}
          className="rounded px-2 py-0.5 text-xs text-[var(--w-text-dim)] hover:bg-[var(--w-surface-2)]"
        >
          ✕
        </button>
      </div>
      {children}
    </div>
  );
}

/** 时钟位（右上角）：事件速率 + 在跑会话数；读不到不摆（不摆空壳铁律）。 */
export function ClockWidget({
  rate,
  runningCount,
}: {
  rate: number | null;
  runningCount: number | null;
}) {
  const t = useT();
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(id);
  }, []);
  if (rate == null && runningCount == null) return null;
  return (
    <div className="rpg-hud-anchor pointer-events-none absolute right-2 top-2 z-10">
      <div className="pointer-events-auto flex items-center gap-2 rounded border border-[var(--w-border)] bg-[var(--w-surface-1)]/80 px-2 py-1 text-[11px] text-[var(--w-text-dim)] backdrop-blur-sm">
        <span>{now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
        {rate != null && (
          <span title={t('rpg.metricsRate')}>
            {rate} {t('rpg.metricsRate')}
          </span>
        )}
        {runningCount != null && runningCount > 0 && (
          <span title={t('rpg.taskbar')}>
            ⚔ {runningCount}
          </span>
        )}
      </div>
    </div>
  );
}
