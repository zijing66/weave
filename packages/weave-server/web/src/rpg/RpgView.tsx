import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useT } from '@/i18n/I18nProvider';
import { RPG_SCENES, sceneOf } from './scenes';
import { useRpgData } from './use-rpg-data';
import { CharacterSprite } from './CharacterSprite';
import { gameStatusOf } from './status-map';
import { CollabScene } from './CollabScene';
import { ClassroomScene } from './ClassroomScene';
import { MeetingScene } from './MeetingScene';
import { CreateRoleForm } from './CreateRoleForm';
import { RoleProgressPanel } from './RoleProgressPanel';
import { STATUS_BADGE } from '@/components/tasks/session-status';
import type { SessionRow } from '@/lib/api';

/**
 * RPG 游戏视图（D1 场景框架 + E4 语义收敛）：场景注册表切换；Home = 出征前
 * 准备视图（角色卡阵 + 修行详情 + 内建建角色入口），办公区 / 教室 / 会议室 =
 * 共用协同视图（CollabScene）的三份皮肤。位置即 URL（`/rpg/<scene>`，route.ts
 * 单向落下）；角色点击 = `navigate` 进既有会话详情，不新建对话面。
 */

export function RpgView({
  sceneKey,
  onOpenSession,
}: {
  sceneKey: string | undefined;
  onOpenSession: (projectId: number, sessionId: string) => void;
}) {
  const t = useT();
  const scene = sceneOf(sceneKey);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-3">
      {/* 场景注册表切换条 */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs uppercase tracking-wide text-[var(--w-text-dim)]">{t('rpg.sceneRegistry')}</span>
        {RPG_SCENES.map((s) => (
          <span
            key={s.key}
            className={
              'rounded px-2 py-0.5 text-xs ' +
              (s.key === scene.key
                ? 'bg-[var(--w-accent)] text-white'
                : 'bg-[var(--w-surface-2)] text-[var(--w-text-dim)]')
            }
          >
            {t(s.titleKey)}
          </span>
        ))}
      </div>

      {scene.kind === 'home' ? (
        <HomeScene />
      ) : scene.kind === 'classroom' ? (
        <ClassroomSkin onOpenSession={onOpenSession} />
      ) : scene.kind === 'meeting' ? (
        <MeetingSkin onOpenSession={onOpenSession} />
      ) : (
        <OfficeSkin onOpenSession={onOpenSession} />
      )}
    </div>
  );
}

function ClassroomSkin(props: { onOpenSession: (projectId: number, sessionId: string) => void }) {
  return <ClassroomScene {...props} />;
}
function MeetingSkin(props: { onOpenSession: (projectId: number, sessionId: string) => void }) {
  return <MeetingScene {...props} />;
}
function OfficeSkin(props: { onOpenSession: (projectId: number, sessionId: string) => void }) {
  return <CollabScene skin="office" {...props} />;
}

/**
 * Home 准备视图（E4 验收①）：角色卡阵（复用协同视图的角色卡）+ 修行详情 +
 * 空态引导 = 内建建角色表单（不绕资源管理）。零派位逻辑——不出征前的准备面。
 */
function HomeScene() {
  const t = useT();
  const qc = useQueryClient();
  const data = useRpgData();
  const [detailRoleId, setDetailRoleId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);

  if (data.roles == null) {
    return <div className="p-8 text-sm text-[var(--w-text-dim)]">…</div>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {data.roles.length === 0 ? (
        <div className="rpg-tile flex min-h-0 flex-1 flex-col items-center justify-center gap-4 rounded border border-[var(--w-border)] p-8 text-center">
          <p className="text-sm text-[var(--w-text-dim)]">{t('rpg.emptyRolesHome')}</p>
          <div className="w-full max-w-2xl">
            <CreateRoleForm
              onCreated={() => {
                void qc.invalidateQueries({ queryKey: ['rpg-roles'] });
                setCreating(false);
              }}
            />
          </div>
        </div>
      ) : (
        <>
          <div className="rpg-tile min-h-0 flex-1 overflow-auto rounded border border-[var(--w-border)] p-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs text-[var(--w-text-dim)]">
                {t('rpg.charCount')} · {data.roles.length}
              </span>
              <button
                type="button"
                onClick={() => setCreating((v) => !v)}
                className="rounded bg-[var(--w-surface-2)] px-2 py-1 text-xs text-[var(--w-text-dim)] hover:bg-[var(--w-surface-3)]"
              >
                {t('rpg.roleCreate')}
              </button>
            </div>
            {creating && (
              <div className="mb-4 rounded border border-[var(--w-border)] bg-[var(--w-surface-1)] p-3">
                <CreateRoleForm
                  onCreated={() => {
                    void qc.invalidateQueries({ queryKey: ['rpg-roles'] });
                    setCreating(false);
                  }}
                />
              </div>
            )}
            <div className="flex flex-wrap gap-4">
              {data.roles.map((role) => {
                // 角色 = 项目：取该项目最近会话的派生状态（无会话 = 待命）。
                const row = latestSessionOf(role.projectId, data.sessionById);
                const status = row ? (data.statuses.get(row.sessionId) ?? 'open') : 'open';
                const game = gameStatusOf(status);
                return (
                  <button
                    key={role.id}
                    type="button"
                    onClick={() => setDetailRoleId((cur) => (cur === role.id ? null : role.id))}
                    className={
                      'flex w-40 flex-col items-center gap-2 rounded border p-3 ' +
                      (detailRoleId === role.id
                        ? 'border-[var(--w-accent)] bg-[var(--w-surface-3)]'
                        : row
                          ? 'border-[var(--w-border)] bg-[var(--w-surface-2)] hover:border-[var(--w-accent)]'
                          : 'border-dashed border-[var(--w-border)] opacity-70')
                    }
                    title={t('rpg.roleProgress')}
                  >
                    <div className={game === 'gone' ? 'opacity-40' : undefined}>
                      <CharacterSprite archetype={role.archetype} status={game} size={3} />
                    </div>
                    <span className="truncate text-sm font-medium">{role.name}</span>
                    <span className={'rounded px-1.5 py-0.5 text-[11px] ' + STATUS_BADGE[status]}>
                      {role.archetype ?? '—'} · {t(`tasks.status${cap(status)}` as 'tasks.statusOpen')}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {detailRoleId != null && (
            <div className="rounded border border-[var(--w-border)] bg-[var(--w-surface-1)] p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs uppercase tracking-wide text-[var(--w-text-dim)]">
                  {t('rpg.roleProgress')}
                </span>
                <button
                  type="button"
                  onClick={() => setDetailRoleId(null)}
                  className="rounded px-2 py-0.5 text-xs text-[var(--w-text-dim)] hover:bg-[var(--w-surface-2)]"
                >
                  ✕
                </button>
              </div>
              <RoleProgressPanel roleId={detailRoleId} />
            </div>
          )}
        </>
      )}
    </div>
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
