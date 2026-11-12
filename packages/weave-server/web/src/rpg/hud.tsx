import { useEffect, useMemo, useState } from 'react';
import { useT } from '@/i18n/I18nProvider';
import type { RpgData } from './use-rpg-data';
import { contextWindowOf } from '@/components/tasks/use-session-controls';
import { latestSessionOf } from './hud-derive';
import { CharacterSprite } from './CharacterSprite';
import type { RpgHexagon, RpgProgressView, RpgRoleView } from '@/lib/api';

/**
 * RimWorld 三件套 HUD（G2.5，设计 §九「全屏世界 + overlay HUD」）：全部是普通
 * DOM overlay（G4 引擎裁决不破——不引 canvas）。**生存条是信号面不是新账**：
 * 每格标真实数据源，派生不出的格不摆（不摆空壳铁律）——
 * - 头顶状态条：绿 = 体力（token 预算余量：sessionRow.contextTokens / 模型窗口，
 *   `contextWindowOf` 同一档位表）/ 黄 = 进度（回合开着时长，lastSeenAt 近似——
 *   回合开着的会话才摆）/ 红 = 健康（该角色项目下 failed run 数，近 50 条账内）。
 * - 顶部警报带：级2 待批（决策信箱，G6）+ 挂起待答（questions）+ 失败 run，按红黄排序；无警报整条不出现。
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
  // 失败会话（defeated）= 满红；失败 run 只按计数热度。
  const health =
    status === 'failed' ? 1 : failed > 0 ? Math.min(1, failed / 5) : null;
  return { hp, progress, health };
}

/** 头顶状态条（sprite 头上 2-3px 细条，叠三格：绿/黄/红）。
 *  常驻语义（G2.6 规格 §4.3）：一格都派生不出 = 一行纯绿「正常」——
 *  状态条是角色的常驻器官，不是数据富余时的装饰。 */
export function SpriteHeadBars({ bars }: { bars: HeadBars }) {
  const segs: Array<[string, number]> = [];
  if (bars.hp != null) segs.push(['#3fbf5f', bars.hp]);
  if (bars.progress != null) segs.push(['#d9a441', bars.progress]);
  if (bars.health != null) segs.push(['#c9566e', bars.health]);
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
      {segs.length === 0 && <div className="flex-1" style={{ background: '#3fbf5f', opacity: 0.85 }} />}
    </div>
  );
}

/* ---- ② 顶部警报带 ---- */

export interface RpgAlert {
  key: string;
  severity: 'red' | 'yellow';
  label: string;
  /** 级2 待批格（G6 决策路由）：渲染方按它接信箱 onOpen）；其余格 label 即终文。 */
  routing?: boolean;
  /** 点击动作（面板展开/跳转，由调用方接）。 */
  onOpen?: () => void;
}

/** 警报派生（纯函数）：级2 待批 = 红（label = 待批数，文案由渲染方译）、挂起待答
 *  = 红、失败 run = 红（有 error）/黄；按红先黄后。 */
export function alertsOf(
  data: Pick<RpgData, 'questions' | 'runs' | 'sessionById' | 'routingPending'>,
): RpgAlert[] {
  const out: RpgAlert[] = [];
  if (data.routingPending > 0) {
    out.push({ key: 'routing-pending', severity: 'red', label: String(data.routingPending), routing: true });
  }
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

/** 顶部警报带：有警报才出现（整条横贯顶部，红黄排）；点击跳对应会话/复盘面板。
 *  级2 待批格点击开决策信箱（G6）。 */
export function AlertStrip({ data, onOpenRouting }: { data: RpgData; onOpenRouting?: () => void }) {
  const t = useT();
  const alerts = useMemo(() => alertsOf(data), [data]);
  if (alerts.length === 0) return null;
  return (
    <div className="rpg-hud-anchor pointer-events-none absolute inset-x-0 top-0 z-20 flex justify-center">
      <div className="rpg-hud-face pointer-events-auto mt-1 flex max-w-[92%] flex-wrap items-center justify-center gap-1 rounded-t-none border-t-0 px-2 py-1">
        <span className="text-[10px] uppercase tracking-wide text-[var(--w-text-dim)]">
          {t('rpg.alertTitle')}
        </span>
        {alerts.map((a) => (
          <span
            key={a.key}
            title={a.label}
            onClick={a.routing && onOpenRouting ? onOpenRouting : undefined}
            className={
              'max-w-56 truncate rounded-sm px-1.5 py-0.5 text-[11px] ' +
              (a.routing && onOpenRouting ? 'cursor-pointer ' : '') +
              (a.severity === 'red'
                ? 'bg-[#c9566e]/25 text-[#e58ca0]'
                : 'bg-[#d9a441]/20 text-[#e0b768]')
            }
          >
            {a.severity === 'red' ? '●' : '▲'} {a.routing ? t('rpg.routingAlert', { n: a.label }) : a.label}
          </span>
        ))}
      </div>
    </div>
  );
}

/* ---- ③ 底部选中详情条（G2.6 五区重组） ---- */

/** 六维条色（参考图 A：青/绿/橙/绿/黄/红 依维度）。 */
export const HEX_DIM_BAR_COLORS: Record<keyof RpgHexagon, string> = {
  力量: '#4ec9b0',
  智慧: '#3fbf5f',
  敏捷: '#d9822b',
  速度: '#3fbf5f',
  内力: '#d9a441',
  运气: '#c9566e',
};

/** 六维展示序（固定）。 */
export const HEX_DIM_ORDER: readonly (keyof RpgHexagon)[] = ['力量', '智慧', '敏捷', '速度', '内力', '运气'];

/** 修为进度（0-1）= 距下一级余量占整档比例：1 - remaining/nextAt；异常档位
 *  （nextAt 非正 / remaining 超档）= null（不摆③区空壳条）。 */
export function xpRatioOf(p: RpgProgressView['xp']): number | null {
  if (!Number.isFinite(p.nextAt) || p.nextAt <= 0) return null;
  if (p.remaining < 0 || p.remaining > p.nextAt) return null;
  return Math.max(0, Math.min(1, 1 - p.remaining / p.nextAt));
}

/** 五区详情 HUD（横向半透明条，非卡片壳）：①头像·名字·状态·当前行为 ②六维
 *  细长像素条 ③修为 Lv + 青色进度条 ④最近回合摘要（≤3 行，最近 runs 会话）。
 *  数据恒真实派生：六维/修为取 progress 派生面、摘要取 runs——派生不出的区
 *  整区不摆（不摆空壳铁律）。移动端紧凑横条（六维折叠，点开）。 */
export function DetailHud({
  role,
  statusLabel,
  behavior,
  progress,
  recentRuns,
  compact,
  onClose,
}: {
  role: RpgRoleView;
  statusLabel: string;
  /** 当前行为一句话（最近 run 名 / 摘要；派生不出 = null 不摆）。 */
  behavior: string | null;
  /** progress 派生面（六维/修为）；null = 派生中/不出（②③区不摆）。 */
  progress: RpgProgressView | null;
  /** 最近回合摘要行（≤3 条，调用方已截）。 */
  recentRuns: string[];
  compact: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const [dimsOpen, setDimsOpen] = useState(false);
  const xp = progress ? xpRatioOf(progress.xp) : null;
  const dims = progress ? progress.hexagon.dims : null;
  return (
    <div className="rpg-hud-face pointer-events-auto absolute inset-x-2 bottom-2 z-20 flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 shadow-xl">
      {/* ① 像素头像 · 名字 · 状态 · 当前行为 */}
      <div className="flex min-w-32 items-center gap-2">
        <div className="h-8 w-8 shrink-0 overflow-hidden">
          <CharacterSprite
            archetype={role.archetype}
            status="idle"
            size={0.75}
            gender={role.gender}
            appearanceSeed={role.appearanceSeed}
          />
        </div>
        <div className="min-w-0">
          <div className="truncate text-xs text-[#d7d1c6]">{role.name}</div>
          <div className="truncate text-[10px] text-[var(--w-text-dim)]">{statusLabel}</div>
          {behavior != null && <div className="truncate text-[10px] text-[var(--w-text-dim)]">{behavior}</div>}
        </div>
      </div>

      {/* ② 六维细长像素条（移动端折叠可点开） */}
      {dims != null && (!compact || dimsOpen) && (
        <div className="flex min-w-40 flex-col gap-1">
          {HEX_DIM_ORDER.map((dim) => {
            const v = Math.max(0, Math.min(1, (dims[dim] ?? 0) / HEX_BAR_MAX));
            return (
              <div key={dim} className="flex items-center gap-1.5">
                <span className="w-8 shrink-0 text-[9px] text-[var(--w-text-dim)]">{t(`rpg.dim.${dim}` as 'rpg.dim.力量')}</span>
                <div className="rpg-dim-bar flex-1">
                  <div style={{ width: `${Math.round(v * 100)}%`, background: HEX_DIM_BAR_COLORS[dim] }} />
                </div>
                <span className="w-6 shrink-0 text-right font-mono tabular-nums text-[9px] text-[var(--w-text-dim)]">
                  {dims[dim] ?? 0}
                </span>
              </div>
            );
          })}
        </div>
      )}
      {dims != null && compact && (
        <button
          type="button"
          onClick={() => setDimsOpen((cur) => !cur)}
          className="rounded px-1.5 py-0.5 text-[10px] text-[var(--w-text-dim)] hover:bg-[var(--w-surface-2)]"
        >
          {dimsOpen ? '▾' : '▸'} {t('rpg.hexagon')}
        </button>
      )}

      {/* ③ 修为 Lv + 青色进度条 */}
      {progress != null && xp != null && (
        <div className="min-w-28">
          <div className="flex items-baseline gap-1.5 text-[10px] text-[var(--w-text-dim)]">
            <span className="text-xs text-[#4ec9b0]">{t('rpg.levelN', { n: String(progress.xp.level) })}</span>
            <span>{progress.xp.realm}</span>
          </div>
          <div className="rpg-xp-bar mt-1 w-full">
            <div style={{ width: `${Math.round(xp * 100)}%` }} />
          </div>
        </div>
      )}

      {/* ④ 最近回合摘要（≤3 行，有账才摆） */}
      {recentRuns.length > 0 && (
        <div className="min-w-40 flex-1">
          {recentRuns.map((line, i) => (
            <div key={i} className="truncate text-[10px] leading-4 text-[var(--w-text-dim)]">
              {line}
            </div>
          ))}
        </div>
      )}

      <button
        type="button"
        onClick={onClose}
        className="ml-auto shrink-0 rounded px-1.5 py-0.5 text-xs text-[var(--w-text-dim)] hover:bg-[var(--w-surface-2)]"
      >
        ✕
      </button>
    </div>
  );
}

/** 六维条满档（服务端 hexCap 对齐值；条只做相对热度，不装精确刻度）。 */
export const HEX_BAR_MAX = 20;

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

/** 时钟位（右上角，G2.6 校色 = rpg-hud-face + 等宽数字）：事件速率 + 在跑会话
 *  数；读不到不摆（不摆空壳铁律）。 */
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
      <div className="rpg-hud-face pointer-events-auto flex items-center gap-2 px-2 py-1 text-[11px]">
        <span className="font-mono tabular-nums">{now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
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

/** 选中角色循环（空格键）：返回下一个角色 id；无角色 = null。纯函数可单测。 */
export function nextSelectedRoleId(
  roles: readonly { id: number }[],
  current: number | null,
): number | null {
  if (roles.length === 0) return null;
  if (current == null) return roles[0]!.id;
  const idx = roles.findIndex((r) => r.id === current);
  if (idx < 0) return roles[0]!.id;
  return roles[(idx + 1) % roles.length]!.id;
}
