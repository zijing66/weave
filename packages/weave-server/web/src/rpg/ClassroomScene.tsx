import { useMemo } from 'react';
import { useT } from '@/i18n/I18nProvider';
import { useRpgData } from './use-rpg-data';
import { gameStatusOf, type GameStatus } from './status-map';
import { CharacterSprite } from './CharacterSprite';
import { hexagonSum } from './growth-derive';
import type { SessionRow } from '@/lib/api';

/**
 * 教室（大屏黑板，E1）：黑板 = 团队简报位——北墙 20×14 tile 布局里占 8×3 tile
 * 的三区（任务板 / 点名 / 成长榜，1 tile 木框隔断）。粉笔字与板擦痕 = CSS 离散
 * 效果（rpg-blackboard / rpg-chalk，index.css）。三区只摆有数据的：无 runs 不摆
 * 任务板、无角色不摆点名与成长榜。
 */
export function ClassroomScene({
  data,
  onOpenSession,
}: {
  data: ReturnType<typeof useRpgData>;
  onOpenSession: (projectId: number, sessionId: string) => void;
}) {
  const t = useT();

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {/* 北墙黑板：三区 + 隔断 */}
      <div className="rpg-blackboard relative flex flex-wrap gap-0 overflow-hidden rounded p-3">
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className="rpg-chalk-dust" style={{ left: `${18 + i * 22}%`, bottom: '12%' }} aria-hidden />
        ))}
        <div className="min-w-0 flex-1 basis-full lg:basis-0">
          <TaskBoard data={data} />
        </div>
        <div className="hidden w-2 shrink-0 self-stretch bg-[#6b463a] lg:block" aria-hidden />
        <div className="min-w-0 flex-1 basis-full lg:basis-0">
          <RollCall data={data} onOpenSession={onOpenSession} />
        </div>
        <div className="hidden w-2 shrink-0 self-stretch bg-[#6b463a] lg:block" aria-hidden />
        <div className="min-w-0 flex-1 basis-full lg:basis-0">
          <GrowthBoard data={data} />
        </div>
      </div>
      <p className="text-[11px] text-neutral-600">{t('rpg.classroomHint')}</p>
    </div>
  );
}

/** 今日任务板：编排 runs 排程（新在前、最多 6 条），游戏态徽标。 */
function TaskBoard({ data }: { data: ReturnType<typeof useRpgData> }) {
  const t = useT();
  const rows = useMemo(() => data.runs?.slice(0, 6) ?? null, [data.runs]);
  return (
    <section className="p-2">
      <h3 className="rpg-chalk mb-2 text-xs font-semibold tracking-wide">{t('rpg.boardTaskToday')}</h3>
      {!rows || rows.length === 0 ? (
        <p className="rpg-chalk text-[11px] opacity-70">{t('rpg.boardTaskEmpty')}</p>
      ) : (
        <ul className="space-y-1">
          {rows.map((r) => (
            <li key={r.id} className="rpg-chalk flex items-center gap-2 text-[11px]">
              <span className="opacity-70">#{r.id}</span>
              <span className="min-w-0 flex-1 truncate">{r.orchestrationName}</span>
              <span>{t(`rpg.board${cap(r.status)}` as 'rpg.boardDone')}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** 团队点名：角色状态总览——像素立绘 + 派生状态（点名有数据的角色才上榜）。 */
function RollCall({
  data,
  onOpenSession,
}: {
  data: ReturnType<typeof useRpgData>;
  onOpenSession: (projectId: number, sessionId: string) => void;
}) {
  const t = useT();
  const rows = useMemo(() => {
    if (!data.roles) return null;
    return data.roles.map((role) => {
      const row = latestSessionOf(role.projectId, data.sessionById);
      const status = row ? (data.statuses.get(row.sessionId) ?? 'open') : 'open';
      return { role, session: row, game: gameStatusOf(status) as GameStatus };
    });
  }, [data.roles, data.sessionById, data.statuses]);

  if (rows == null) return <p className="rpg-chalk p-2 text-[11px] opacity-70">…</p>;
  if (rows.length === 0) {
    return (
      <section className="p-2">
        <h3 className="rpg-chalk mb-2 text-xs font-semibold tracking-wide">{t('rpg.boardRollCall')}</h3>
        <p className="rpg-chalk text-[11px] opacity-70">{t('rpg.emptyRoles')}</p>
      </section>
    );
  }
  return (
    <section className="p-2">
      <h3 className="rpg-chalk mb-2 text-xs font-semibold tracking-wide">{t('rpg.boardRollCall')}</h3>
      <ul className="space-y-1.5">
        {rows.map(({ role, session, game }) => (
          <li key={role.id} className="flex items-center gap-2">
            <span className={game === 'gone' ? 'inline-block opacity-40' : 'inline-block'}>
              <CharacterSprite archetype={role.archetype} status={game} size={2} />
            </span>
            <button
              type="button"
              onClick={session ? () => onOpenSession(role.projectId, session.sessionId) : undefined}
              className={
                'rpg-chalk min-w-0 flex-1 truncate text-left text-[11px] ' +
                (session ? 'underline decoration-dotted underline-offset-2 hover:opacity-80' : 'opacity-80')
              }
            >
              {role.name}
            </button>
            <span className="rpg-chalk shrink-0 text-[11px] opacity-70">
              {t(`rpg.state${cap(game)}` as 'rpg.stateIdle')}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * 成长榜：六维/技巧分读面派生（E2 在做 XP/等级数值深化——基线里还没有等级
 * 派生面，本榜先按「六维总和 + 最新技巧分」排座次，E2 的派生面落地后换键）。
 */
function GrowthBoard({ data }: { data: ReturnType<typeof useRpgData> }) {
  const t = useT();
  const rows = useMemo(() => {
    if (!data.roles || data.roles.length === 0) return null;
    return data.roles
      .map((role) => ({ role, total: role.hexagon ? hexagonSum(role.hexagon) : null }))
      .sort((a, b) => (b.total ?? -1) - (a.total ?? -1))
      .slice(0, 6);
  }, [data.roles]);

  if (rows == null) return <p className="rpg-chalk p-2 text-[11px] opacity-70">…</p>;
  if (rows.length === 0) {
    return (
      <section className="p-2">
        <h3 className="rpg-chalk mb-2 text-xs font-semibold tracking-wide">{t('rpg.boardGrowth')}</h3>
        <p className="rpg-chalk text-[11px] opacity-70">{t('rpg.emptyRoles')}</p>
      </section>
    );
  }
  return (
    <section className="p-2">
      <h3 className="rpg-chalk mb-2 text-xs font-semibold tracking-wide">{t('rpg.boardGrowth')}</h3>
      <ol className="space-y-1">
        {rows.map(({ role, total }, i) => (
          <li key={role.id} className="rpg-chalk flex items-center gap-2 text-[11px]">
            <span className="w-4 text-right opacity-70">{i + 1}</span>
            <span className="min-w-0 flex-1 truncate">{role.name}</span>
            <span className="opacity-70">{total != null ? `${t('rpg.hexagon')} ${total}` : '—'}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function latestSessionOf(
  projectId: number,
  sessionById: ReadonlyMap<string, SessionRow>,
): SessionRow | undefined {
  let best: SessionRow | undefined;
  for (const s of sessionById.values()) {
    if (s.projectId !== projectId) continue;
    if (!best || s.createdAt > best.createdAt) best = s;
  }
  return best;
}
