import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useT } from '@/i18n/I18nProvider';
import { api, type ProjectRow } from '@/lib/api';
import { useBackPop } from '@/lib/back-pop';
import { Input } from '@/components/ui/input';
import { navigate } from '@/lib/route';
import { roomSceneKey } from './scenes';
import type { RpgRoleView } from '@/lib/api';

/**
 * 建房对话框（G2 组建流的 web 缺口补齐，2026-11-09）：选核心（点开项目房时预填）
 * + 辅助项目 + 角色入住一步落（POST /rpg/houses），成功即进该房协同棋盘。
 * 「直接进项目视图」保留 G2 无房回落的老出口。
 */
export function HouseCreateDialog({
  coreProject,
  projects,
  roles,
  onClose,
}: {
  coreProject: ProjectRow;
  projects: ProjectRow[];
  roles: RpgRoleView[];
  onClose: () => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const [name, setName] = useState(coreProject.name);
  const [aux, setAux] = useState<number[]>([]);
  const [memberRoles, setMemberRoles] = useState<number[]>([]);
  const others = projects.filter((p) => p.id !== coreProject.id);

  useBackPop(true, () => {
    onClose();
    return true;
  });

  const form = useMutation({
    mutationFn: () =>
      api.createHouse({
        name: name.trim() || coreProject.name,
        coreProjectId: coreProject.id,
        ...(aux.length ? { auxProjectIds: aux } : {}),
        ...(memberRoles.length ? { roleIds: memberRoles } : {}),
      }),
    onSuccess: (house) => {
      void qc.invalidateQueries({ queryKey: ['rpg-houses'] });
      onClose();
      navigate({ kind: 'rpg', scene: roomSceneKey(house.id) });
    },
  });

  const chip = (on: boolean): string =>
    'rounded px-2 py-1 text-xs ' +
    (on
      ? 'bg-[var(--w-accent)] text-white'
      : 'bg-[var(--w-surface-2)] text-[var(--w-text-dim)] hover:bg-[var(--w-surface-3)]');

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-3" onClick={onClose}>
      <div
        className="max-h-[85dvh] w-full max-w-md overflow-auto rounded-lg border border-edge/[0.1] bg-neutral-900 p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold">{t('rpg.houseCreateTitle')}</h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded px-2 py-0.5 text-xs text-[var(--w-text-dim)] hover:bg-[var(--w-surface-2)]"
          >
            ✕
          </button>
        </div>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <span className="text-xs text-[var(--w-text-dim)]">{t('rpg.houseCreateName')}</span>
            <Input value={name} onChange={(e) => setName(e.target.value)} aria-label={t('rpg.houseCreateName')} />
          </div>
          <p className="text-xs text-[var(--w-text-dim)]">
            {t('rpg.houseCreateCore')} · <span className="text-[var(--w-text)]">{coreProject.name}</span>
          </p>
          {others.length > 0 && (
            <div className="flex flex-col gap-1">
              <span className="text-xs text-[var(--w-text-dim)]">{t('rpg.houseCreateAux')}</span>
              <div className="flex flex-wrap gap-2">
                {others.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setAux((cur) => (cur.includes(p.id) ? cur.filter((x) => x !== p.id) : [...cur, p.id]))}
                    className={chip(aux.includes(p.id))}
                  >
                    {p.name}
                  </button>
                ))}
              </div>
            </div>
          )}
          {roles.length > 0 && (
            <div className="flex flex-col gap-1">
              <span className="text-xs text-[var(--w-text-dim)]">{t('rpg.houseCreateRoles')}</span>
              <div className="flex flex-wrap gap-2">
                {roles.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() =>
                      setMemberRoles((cur) => (cur.includes(r.id) ? cur.filter((x) => x !== r.id) : [...cur, r.id]))
                    }
                    className={chip(memberRoles.includes(r.id))}
                  >
                    {r.name}
                  </button>
                ))}
              </div>
            </div>
          )}
          {form.isError && <span className="text-xs text-red-400">{String(form.error)}</span>}
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => navigate({ kind: 'project', projectId: coreProject.id, category: 'tasks', sessionId: null })}
              className="rounded px-2 py-1.5 text-xs text-[var(--w-text-dim)] hover:bg-[var(--w-surface-2)]"
            >
              {t('rpg.houseCreateGoProject')}
            </button>
            <button
              type="button"
              disabled={form.isPending}
              onClick={() => form.mutate()}
              className="rounded bg-[var(--w-accent)] px-3 py-1.5 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              {form.isPending ? '…' : t('rpg.houseCreateOk')}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
